import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { parse as parseCsvStream } from "csv-parse"; // 流式:buildMeta 汇总用,不构建整行对象
import XLSX from "xlsx";

// 多租户:每个 user 的上传文件落在 ROOT_UPLOAD_DIR/{userId}/ 下
// ROOT_DATA_DIR 保留只是给 buildMeta 报告路径用,**不再**作为新用户的默认源数据(新用户看空数据)
const ROOT_DATA_DIR = process.env.HUOPAN_DATA_DIR || path.resolve(process.cwd(), "data", "source-data");
const ROOT_UPLOAD_DIR = process.env.HUOPAN_UPLOAD_DIR || path.resolve(process.cwd(), "uploads", "source-data");

function requireUserId(userId) {
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    throw new Error(`metrics: 缺失 userId(收到 ${userId})`);
  }
  return userId;
}

function userUploadDir(userId) {
  return path.join(ROOT_UPLOAD_DIR, String(requireUserId(userId)));
}

function clearedStateFileFor(userId) {
  return path.join(userUploadDir(userId), ".sources-cleared");
}

const sourceDateFields = {
  product: "统计日期",
  adItem: "日期",
  content: "日期",
  keyword: "日期",
  crowd: "日期"
};

const sourceNames = {
  product: "店铺数据_商品维度",
  adItem: "店铺数据_推广商品报表",
  content: "店铺数据_推广内容报表",
  keyword: "店铺数据_推广关键词报表",
  crowd: "店铺数据_推广人群报表"
};

export const sourceUploadSlots = [
  { id: "product", name: sourceNames.product, defaultFile: "生参商品排行榜.xlsx", uploadFile: "product.xlsx", extensions: [".xlsx", ".xls"] },
  { id: "adItem", name: sourceNames.adItem, defaultFile: "推广商品报表_20260118_130730.csv", uploadFile: "adItem.csv", extensions: [".csv"] },
  { id: "content", name: sourceNames.content, defaultFile: "推广内容报表_20260118_130815.csv", uploadFile: "content.csv", extensions: [".csv"] },
  { id: "keyword", name: sourceNames.keyword, defaultFile: "推广关键词报表_20260118_130845.csv", uploadFile: "keyword.csv", extensions: [".csv"] },
  { id: "crowd", name: sourceNames.crowd, defaultFile: "推广人群报表_20260118_130755.csv", uploadFile: "crowd.csv", extensions: [".csv"] }
];

// ============ 按表惰性缓存(替代"一次性全载 5 表并永久缓存")============
// 旧设计:loadRaw 把 5 张源表全量解析后常驻内存(单用户 ~6GB),并发多用户/
// 每次 /api/meta 都全量载入 → 内存成倍叠加 → OOM。
// 新设计(不改任何财务聚合口径,只改"怎么载入/驻留"):
//   1. 按 (user, table) 粒度惰性载入,视图只载它真正用到的表(商品页不再载 crowd/keyword);
//   2. 在途 Promise 去重,防并发惊群;
//   3. 总行数预算 LRU 淘汰,硬性封顶常驻内存;
//   4. 惰性 TTL,空闲数据过期后下次访问重载;
//   5. 解析并发信号量,封顶瞬时解析峰值(并发多用户时不至于 N 份大文件同时解析撑爆)。
const RAW_TTL_MS = Number(process.env.RAW_CACHE_TTL_MS || 5 * 60 * 1000);
const RAW_ROW_BUDGET = Number(process.env.RAW_CACHE_ROW_BUDGET || 1_000_000);
const RAW_PARSE_CONCURRENCY = Math.max(1, Number(process.env.RAW_PARSE_CONCURRENCY || 2));

const tableCache = new Map(); // `${uid}:${tableId}` -> { rows, count, loadedAt, lastAccess }
const tableLoading = new Map(); // `${uid}:${tableId}` -> Promise<rows>
const summaryCache = new Map(); // uid -> Map(tableId -> { sig, summary })  buildMeta 用的轻量汇总

const ALL_TABLE_IDS = ["product", "adItem", "content", "keyword", "crowd"];

// 解析信号量:最多 RAW_PARSE_CONCURRENCY 个文件同时解析,其余排队
let parseActive = 0;
const parseQueue = [];
function acquireParseSlot() {
  if (parseActive < RAW_PARSE_CONCURRENCY) {
    parseActive++;
    return Promise.resolve();
  }
  return new Promise((resolve) => parseQueue.push(resolve));
}
function releaseParseSlot() {
  parseActive = Math.max(0, parseActive - 1);
  const next = parseQueue.shift();
  if (next) {
    parseActive++;
    next();
  }
}

function totalCachedRows() {
  let total = 0;
  for (const entry of tableCache.values()) total += entry.count;
  return total;
}

// 预算超限时按 lastAccess 最旧优先淘汰(保护刚插入的 protectKey)
function evictRawToBudget(protectKey) {
  if (totalCachedRows() <= RAW_ROW_BUDGET) return;
  const victims = [...tableCache.entries()]
    .filter(([key]) => key !== protectKey)
    .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
  for (const [key] of victims) {
    if (totalCachedRows() <= RAW_ROW_BUDGET) break;
    tableCache.delete(key);
  }
}

// ============ 结果缓存(缓存视图聚合产物,而非原始行)============
// 重页面(人群/关键词)每次请求都要重算几十万行(~2s+),重复浏览很浪费。
// 按 (用户, 视图, 筛选参数, 源文件签名) 缓存聚合结果:同参数重复请求直接命中(~0ms);
// 源文件一变(上传)签名就变 → 旧 key 自然失效。按总字节 LRU 封顶,内存可控。
const RESULT_CACHE_MAX_MB = Number(process.env.RESULT_CACHE_MAX_MB || 512);
const resultCache = new Map(); // key -> { value, bytes, lastAccess }
let resultBytes = 0;

async function tablesSignature(uid, ids) {
  const sources = await resolveSourceFiles(uid);
  const parts = await Promise.all(
    ids.map((id) => {
      const s = sources[id];
      return s.cleared || !s.file ? Promise.resolve("∅") : fileSignature(s.file);
    })
  );
  return parts.join("|");
}

// 包住一个 view builder:命中缓存直接返回;否则跑 build()、缓存产物、按字节 LRU 淘汰
async function cachedView(uid, view, range, depTables, build) {
  const sig = await tablesSignature(uid, depTables);
  const key = JSON.stringify([uid, view, range || {}, sig]);
  const hit = resultCache.get(key);
  if (hit) {
    hit.lastAccess = Date.now();
    return hit.value;
  }
  const value = await build();
  let bytes = 0;
  try {
    bytes = JSON.stringify(value).length;
  } catch {
    bytes = 0;
  }
  resultCache.set(key, { value, bytes, lastAccess: Date.now() });
  resultBytes += bytes;
  const limit = RESULT_CACHE_MAX_MB * 1024 * 1024;
  if (resultBytes > limit) {
    const victims = [...resultCache.entries()].sort((a, b) => a[1].lastAccess - b[1].lastAccess);
    for (const [k, e] of victims) {
      if (resultBytes <= limit) break;
      resultCache.delete(k);
      resultBytes -= e.bytes;
    }
  }
  return value;
}

function clearResultCache(uid) {
  if (uid === undefined) {
    resultCache.clear();
    resultBytes = 0;
    return;
  }
  const prefix = `[${uid},`;
  for (const [k, e] of resultCache) {
    if (k.startsWith(prefix)) {
      resultCache.delete(k);
      resultBytes -= e.bytes;
    }
  }
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getUploadDir(userId) {
  return userUploadDir(userId);
}

export function getRootUploadDir() {
  return ROOT_UPLOAD_DIR;
}

export function getUploadedSourcePath(userId, sourceId) {
  const slot = sourceUploadSlots.find((item) => item.id === sourceId);
  if (!slot) throw new Error(`Unknown source id: ${sourceId}`);
  return path.join(userUploadDir(userId), slot.uploadFile);
}

export function resetRawCache(userId) {
  if (userId === undefined) {
    tableCache.clear();
    tableLoading.clear();
    summaryCache.clear();
    clearResultCache();
    return;
  }
  const uid = requireUserId(userId);
  const prefix = `${uid}:`;
  for (const key of tableCache.keys()) if (key.startsWith(prefix)) tableCache.delete(key);
  for (const key of tableLoading.keys()) if (key.startsWith(prefix)) tableLoading.delete(key);
  summaryCache.delete(uid);
  clearResultCache(uid);
}

export async function clearSourceData(userId) {
  const uid = requireUserId(userId);
  const dir = userUploadDir(uid);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(clearedStateFileFor(uid), new Date().toISOString(), "utf8");
  resetRawCache(uid);
}

// 多租户:新用户没有"默认 demo 数据",未上传即为空
async function resolveSourceFiles(userId) {
  const uid = requireUserId(userId);
  const entries = await Promise.all(
    sourceUploadSlots.map(async (slot) => {
      const uploadedPath = path.join(userUploadDir(uid), slot.uploadFile);
      const uploaded = await fileExists(uploadedPath);
      return [
        slot.id,
        {
          ...slot,
          file: uploaded ? uploadedPath : "",
          uploaded,
          mode: uploaded ? "uploaded" : "empty",
          cleared: !uploaded
        }
      ];
    })
  );
  return Object.fromEntries(entries);
}

const moneyFields = new Set([
  "支付金额",
  "成功退款金额",
  "老买家支付金额",
  "年累计支付金额",
  "商品访客数",
  "支付买家数",
  "支付老买家数",
  "商品加购人数",
  "商品浏览量",
  "平均停留时长",
  "推广消耗",
  "花费",
  "总成交金额",
  "展现量",
  "点击量",
  "总成交笔数",
  "间接成交笔数",
  "总购物车数",
  "引导访问潜客数",
  "引导访问人数",
  "平均展现排名"
]);

function cleanNumber(value) {
  if (value === null || value === undefined || value === "") return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value).replace(/,/g, "").replace(/%/g, "").trim();
  if (!normalized || normalized === "#VALUE!" || normalized === "NaN") return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRatio(value, fallback = 0) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  const text = String(value).trim();
  if (!text) return fallback;
  if (text.endsWith("%")) return cleanNumber(text) / 100;
  return cleanNumber(text);
}

function div(numerator, denominator) {
  const d = cleanNumber(denominator);
  if (!d) return null;
  return cleanNumber(numerator) / d;
}

function round(value, digits = 4) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseDateText(value) {
  if (!value) return "";
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function inRange(rowDate, range, field = "日期") {
  const value = parseDateText(rowDate?.[field] ?? rowDate);
  if (!value) return true;
  if (range.start && value < range.start) return false;
  if (range.end && value > range.end) return false;
  return true;
}

function textMatch(text, q) {
  if (!q) return true;
  return String(text || "").toLowerCase().includes(q.toLowerCase());
}

async function readCsv(filePath) {
  const buffer = await fs.readFile(filePath);
  const text = new TextDecoder("gb18030").decode(buffer);
  // P4.12 用 cast 在解析期就地转换金额字段,取代解析后再 rows.map() 复制一遍。
  // 大文件(crowd.csv 70 万行 × 75 列)那次 .map() 会瞬时再分配一份等大数组,
  // 正是 OOM 栈里的 Builtins_ArrayMap。就地转换把单文件峰值再砍掉约一份拷贝。
  return parse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
    cast: (value, context) => {
      if (context.header) return value; // 表头原样,只转数据格
      return moneyFields.has(context.column) ? cleanNumber(value) : value;
    }
  });
}

async function readProductWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sheet = workbook.Sheets["商品维度"] || workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (key === "统计日期") out[key] = parseExcelDate(value);
      else out[key] = moneyFields.has(key) ? cleanNumber(value) : value;
    }
    return out;
  });
}

function parseExcelDate(value) {
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) {
      const month = String(parsed.m).padStart(2, "0");
      const day = String(parsed.d).padStart(2, "0");
      return `${parsed.y}-${month}-${day}`;
    }
  }
  return parseDateText(value);
}

async function safeRead(source, reader) {
  if (source.cleared) return [];
  if (!source.file) return [];
  if (!(await fileExists(source.file))) return [];
  return reader(source.file);
}

const tableReaders = {
  product: readProductWorkbook,
  adItem: readCsv,
  content: readCsv,
  keyword: readCsv,
  crowd: readCsv
};

// 惰性载入单张表:命中缓存(未过期)直接返回;否则解析,带在途去重 + 解析信号量 + 预算淘汰
async function loadTable(userId, tableId) {
  const uid = requireUserId(userId);
  const key = `${uid}:${tableId}`;
  const cached = tableCache.get(key);
  if (cached) {
    if (Date.now() - cached.loadedAt <= RAW_TTL_MS) {
      cached.lastAccess = Date.now();
      return cached.rows;
    }
    tableCache.delete(key); // 过期,重载
  }
  const inflight = tableLoading.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const sources = await resolveSourceFiles(uid);
    await acquireParseSlot();
    let rows;
    try {
      rows = await safeRead(sources[tableId], tableReaders[tableId]);
    } finally {
      releaseParseSlot();
    }
    const now = Date.now();
    tableCache.set(key, { rows, count: rows.length, loadedAt: now, lastAccess: now });
    evictRawToBudget(key);
    return rows;
  })();
  tableLoading.set(key, promise);
  try {
    return await promise;
  } finally {
    tableLoading.delete(key);
  }
}

// 按需载入一组表,返回 { [id]: rows }(只载入 ids 指定的表)
async function loadTables(userId, ids) {
  const pairs = await Promise.all(ids.map(async (id) => [id, await loadTable(userId, id)]));
  return Object.fromEntries(pairs);
}

// P1.2 暴露 raw 数据快照给历史库入库流程(入库需要全部 5 张表)
export async function getRawSnapshot(userId) {
  return loadTables(userId, ALL_TABLE_IDS);
}

// ============ buildMeta 用的轻量汇总 ============
// buildMeta 只需要每表的「行数 / 日期范围 / 去重场景」,不需要财务列。
// 流式扫描只取 date + 场景名字 两列,内存 O(去重场景数);按文件签名(mtime+size)缓存,
// 文件没变就直接复用,避免每次 /api/meta 都重扫 463MB。
async function fileSignature(filePath) {
  try {
    const st = await fs.stat(filePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

// 流式汇总 CSV:columns:false 只按列下标取 date/scene,不构建 75 列对象 → 快且省内存
async function summarizeCsv(filePath, dateField, sceneField) {
  const buffer = await fs.readFile(filePath);
  const text = new TextDecoder("gb18030").decode(buffer);
  return await new Promise((resolve, reject) => {
    let count = 0;
    let start = "";
    let end = "";
    let dateIdx = -1;
    let sceneIdx = -1;
    let headerSeen = false;
    const scenes = new Set();
    const parser = parseCsvStream(text, {
      columns: false,
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: true
    });
    parser.on("readable", () => {
      let rec;
      while ((rec = parser.read()) !== null) {
        if (!headerSeen) {
          headerSeen = true;
          dateIdx = rec.indexOf(dateField);
          sceneIdx = sceneField ? rec.indexOf(sceneField) : -1;
          continue;
        }
        count++;
        if (dateIdx >= 0) {
          const d = parseDateText(rec[dateIdx]);
          if (d) {
            if (!start || d < start) start = d;
            if (!end || d > end) end = d;
          }
        }
        if (sceneIdx >= 0) {
          const s = rec[sceneIdx];
          if (s) scenes.add(s);
        }
      }
    });
    parser.on("error", reject);
    parser.on("end", () => resolve({ count, start, end, scenes: [...scenes].sort() }));
  });
}

// product 是 xlsx 且体积小(~27K 行),直接全量解析后汇总即弃;无场景列
async function summarizeWorkbook(filePath) {
  const rows = await readProductWorkbook(filePath);
  let start = "";
  let end = "";
  for (const row of rows) {
    const d = parseDateText(row["统计日期"]);
    if (d) {
      if (!start || d < start) start = d;
      if (!end || d > end) end = d;
    }
  }
  return { count: rows.length, start, end, scenes: [] };
}

const EMPTY_SUMMARY = { count: 0, start: "", end: "", scenes: [] };

async function getSummaries(uid, sources) {
  let perUser = summaryCache.get(uid);
  if (!perUser) {
    perUser = new Map();
    summaryCache.set(uid, perUser);
  }
  const out = {};
  for (const id of ALL_TABLE_IDS) {
    const source = sources[id];
    if (source.cleared || !source.file) {
      out[id] = EMPTY_SUMMARY;
      continue;
    }
    const sig = await fileSignature(source.file);
    const hit = perUser.get(id);
    if (hit && hit.sig === sig) {
      out[id] = hit.summary;
      continue;
    }
    // 汇总扫描同样走解析信号量,封顶并发首次加载时的瞬时内存峰值
    await acquireParseSlot();
    let summary;
    try {
      summary =
        id === "product"
          ? await summarizeWorkbook(source.file)
          : await summarizeCsv(source.file, sourceDateFields[id], "场景名字");
    } finally {
      releaseParseSlot();
    }
    perUser.set(id, { sig, summary });
    out[id] = summary;
  }
  return out;
}

function addToGroup(map, key, initial, merge) {
  if (!map.has(key)) map.set(key, initial());
  const target = map.get(key);
  merge(target);
  return target;
}

function sumFields(target, row, fields) {
  for (const field of fields) {
    target[field] = cleanNumber(target[field]) + cleanNumber(row[field]);
  }
}

function sortBy(rows, field, direction = "desc") {
  const factor = direction === "asc" ? 1 : -1;
  return rows.sort((a, b) => (cleanNumber(a[field]) - cleanNumber(b[field])) * factor);
}

function dateRange(rows, field) {
  const dates = rows.map((row) => parseDateText(row[field])).filter(Boolean).sort();
  return {
    start: dates[0] || "",
    end: dates[dates.length - 1] || ""
  };
}

function getIsoWeek(dateText) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  const monday = new Date(Date.UTC(year, month - 1, day));
  monday.setUTCDate(monday.getUTCDate() - weekday + 1);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const mmdd = (d) => `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  return {
    sortKey: `${isoYear}-${String(week).padStart(2, "0")}`,
    label: `${isoYear}-${String(week).padStart(2, "0")} (${mmdd(monday)}-${mmdd(sunday)})`
  };
}

function enrichAdMetrics(row) {
  row.spend = round(row["花费"], 2);
  row.gmv = round(row["总成交金额"], 2);
  row.roi = round(div(row["总成交金额"], row["花费"]), 4);
  row.cpc = round(div(row["花费"], row["点击量"]), 4);
  row.ctr = round(div(row["点击量"], row["展现量"]), 4);
  row.cvr = round(div(row["总成交笔数"], row["点击量"]), 4);
  row.customerPrice = round(div(row["总成交金额"], row["总成交笔数"]), 4);
  row.indirectCvr = round(div(row["间接成交笔数"], row["点击量"]), 4);
  row.leadRatio = round(div(row["引导访问潜客数"], row["引导访问人数"]), 4);
  row.cartCost = round(div(row["花费"], row["总购物车数"]), 4);
  row.cpm = round(div(row["花费"] * 1000, row["展现量"]), 4);
  return row;
}

// P3.2 智能异常：扫描 daily 数组，每行附加 flags[]、anomalous（保留向后兼容）
// flags 元素结构 { kind, severity: "warning"|"info", label, hint }
function detectProductDailyAnomalies(daily) {
  // 7 日均值（rolling）作为对比基线
  const win = 7;
  const spends = daily.map((d) => cleanNumber(d["推广消耗"]));
  const pays = daily.map((d) => cleanNumber(d["支付金额"]));
  function rollingAvg(arr, idx) {
    const start = Math.max(0, idx - win + 1);
    const slice = arr.slice(start, idx + 1);
    if (!slice.length) return 0;
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  }
  for (let i = 0; i < daily.length; i++) {
    const row = daily[i];
    const flags = [];
    const pay = cleanNumber(row["支付金额"]);
    const refund = cleanNumber(row["成功退款金额"]);
    const spend = cleanNumber(row["推广消耗"]);
    const netFee = typeof row.netFeeRatio === "number" ? row.netFeeRatio : null;

    if (pay > 0 && refund > pay) {
      flags.push({
        kind: "refund_exceeds_pay",
        severity: "warning",
        label: "退款超出支付",
        hint: `退款 ${refund.toFixed(2)} > 支付 ${pay.toFixed(2)}，常因前几日订单的退款集中在当天结算`
      });
    }
    if (netFee !== null && Math.abs(netFee) > 1) {
      flags.push({
        kind: "net_fee_extreme",
        severity: "warning",
        label: "净费比绝对值 > 100%",
        hint: `净费比 ${(netFee * 100).toFixed(0)}%，分母（净支付）可能很小或为负，请结合退款率综合判断`
      });
    }
    // spend 突变（仅 i >= 3 有意义；至少要有几天历史才能算均值）
    if (i >= 3) {
      const avg = rollingAvg(spends, i - 1); // 不含当日
      if (avg > 100) {
        if (spend > avg * 2) {
          flags.push({
            kind: "spend_spike",
            severity: "info",
            label: "推广花费突增",
            hint: `当日 ${spend.toFixed(2)}，前 ${win} 日均值 ${avg.toFixed(2)}，增幅 ${((spend / avg - 1) * 100).toFixed(0)}%`
          });
        } else if (spend < avg * 0.4) {
          flags.push({
            kind: "spend_drop",
            severity: "info",
            label: "推广花费骤降",
            hint: `当日 ${spend.toFixed(2)}，前 ${win} 日均值 ${avg.toFixed(2)}，降幅 ${((1 - spend / avg) * 100).toFixed(0)}%`
          });
        }
      }
      // 支付突变
      const payAvg = rollingAvg(pays, i - 1);
      if (payAvg > 1000 && pay > 0) {
        if (pay > payAvg * 2.5) {
          flags.push({
            kind: "pay_spike",
            severity: "info",
            label: "当日支付突增",
            hint: `当日 ${pay.toFixed(0)}，前 ${win} 日均值 ${payAvg.toFixed(0)}`
          });
        }
      }
    }

    if (flags.length > 0) {
      row.flags = flags;
      row.anomalous = true;
      row.anomalyKind = flags[0].kind;
      row.anomalyHint = flags[0].hint;
    } else {
      row.flags = [];
      row.anomalous = false;
    }
  }
}

function filterRows(rows, range, dateField, textFields = []) {
  return rows.filter((row) => {
    if (!inRange(row, range, dateField)) return false;
    if (range.scene && Object.prototype.hasOwnProperty.call(row, "场景名字") && row["场景名字"] !== range.scene) return false;
    if (!range.q) return true;
    return textFields.some((field) => textMatch(row[field], range.q));
  });
}

const productFields = ["支付金额", "成功退款金额", "支付买家数", "支付老买家数", "老买家支付金额", "商品加购人数", "商品访客数", "商品浏览量", "推广消耗"];

function enrichProductMetrics(row) {
  const pay = cleanNumber(row["支付金额"]);
  const refund = cleanNumber(row["成功退款金额"]);
  const spend = cleanNumber(row["推广消耗"]);
  const netPay = pay - refund;
  row.pay = round(pay, 2);
  row.visitors = round(row["商品访客数"], 0);
  row.conversionRate = round(div(row["支付买家数"], row["商品访客数"]), 4);
  row.customerPrice = round(div(row["支付金额"], row["支付买家数"]), 4);
  row.netFeeRatio = round(div(row["推广消耗"], netPay), 4);
  row.refundRatio = round(div(row["成功退款金额"], row["支付金额"]), 4);
  row.repeatRate = round(div(row["支付老买家数"], row["支付买家数"]), 4);
  row.repeatPayRatio = round(div(row["老买家支付金额"], row["支付金额"]), 4);
  row.cartRate = round(div(row["商品加购人数"], row["商品访客数"]), 4);
  row.pvPerVisitor = round(div(row["商品浏览量"], row["商品访客数"]), 4);
  row.netRoi = spend ? round(netPay / spend, 4) : null;
  return row;
}

function diffDays(startIso, endIso) {
  if (!startIso || !endIso) return 0;
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86400000);
}

const sourceLabels = {
  product: "商品维度",
  adItem: "推广商品",
  content: "推广内容",
  keyword: "推广关键词",
  crowd: "推广人群"
};

export function computeAlignment(perTable) {
  const tables = Object.entries(perTable).map(([id, range]) => ({
    id,
    label: sourceLabels[id] || id,
    start: range.start || "",
    end: range.end || ""
  }));

  const present = tables.filter((item) => item.start && item.end);
  const missing = tables.filter((item) => !item.start || !item.end).map((item) => item.id);

  if (!present.length) {
    return {
      status: "incomplete",
      intersection: { start: "", end: "" },
      union: { start: "", end: "" },
      perTable: Object.fromEntries(tables.map((item) => [item.id, { start: item.start, end: item.end }])),
      missing,
      warnings: []
    };
  }

  const intersectionStart = present.reduce((acc, item) => (item.start > acc ? item.start : acc), present[0].start);
  const intersectionEnd = present.reduce((acc, item) => (item.end < acc ? item.end : acc), present[0].end);
  const unionStart = present.reduce((acc, item) => (item.start < acc ? item.start : acc), present[0].start);
  const unionEnd = present.reduce((acc, item) => (item.end > acc ? item.end : acc), present[0].end);

  const hasIntersection = intersectionStart <= intersectionEnd;
  const allSameStart = present.every((item) => item.start === present[0].start);
  const allSameEnd = present.every((item) => item.end === present[0].end);

  let status;
  if (missing.length) status = "incomplete";
  else if (allSameStart && allSameEnd) status = "aligned";
  else if (hasIntersection) status = "partial";
  else status = "mismatch";

  const warnings = [];
  if (status === "partial" || status === "mismatch") {
    for (const item of present) {
      if (item.start < intersectionStart) {
        const days = diffDays(item.start, intersectionStart);
        warnings.push({
          table: item.id,
          label: item.label,
          kind: "extends_start",
          diffDays: days,
          message: `${item.label} 比共同区间多出前置 ${days} 天（${item.start} ~ ${intersectionStart}），这段时间其他表无对应数据`
        });
      }
      if (item.end > intersectionEnd) {
        const days = diffDays(intersectionEnd, item.end);
        warnings.push({
          table: item.id,
          label: item.label,
          kind: "extends_end",
          diffDays: days,
          message: `${item.label} 比共同区间多出后置 ${days} 天（${intersectionEnd} ~ ${item.end}），这段时间其他表无对应数据`
        });
      }
    }
  }
  if (missing.length) {
    for (const id of missing) {
      warnings.push({
        table: id,
        label: sourceLabels[id] || id,
        kind: "missing",
        diffDays: 0,
        message: `${sourceLabels[id] || id} 尚未上传或无有效日期`
      });
    }
  }

  return {
    status,
    intersection: hasIntersection ? { start: intersectionStart, end: intersectionEnd } : { start: "", end: "" },
    union: { start: unionStart, end: unionEnd },
    perTable: Object.fromEntries(tables.map((item) => [item.id, { start: item.start, end: item.end }])),
    missing,
    warnings
  };
}

export async function buildMeta(userId) {
  const uid = requireUserId(userId);
  const sources = await resolveSourceFiles(uid);
  // 轻量汇总(行数 / 日期范围 / 去重场景),不再全量载入 5 张表
  const summaries = await getSummaries(uid, sources);
  const sourceMeta = (id) => ({
    id,
    name: sourceNames[id],
    file: sources[id].file || "已清空源数据",
    uploaded: sources[id].uploaded,
    mode: sources[id].mode,
    cleared: sources[id].cleared,
    rows: summaries[id].count,
    dateField: sourceDateFields[id],
    start: summaries[id].start,
    end: summaries[id].end
  });
  const sourceList = ALL_TABLE_IDS.map(sourceMeta);
  const alignment = computeAlignment(
    Object.fromEntries(sourceList.map((item) => [item.id, { start: item.start, end: item.end }]))
  );
  // 跨表场景去重 = 各表去重场景的并集再排序(等价于原来对拼接行去重)
  const unionScenes = (ids) => [...new Set(ids.flatMap((id) => summaries[id].scenes))].sort();
  return {
    dataDir: ROOT_DATA_DIR,
    uploadDir: userUploadDir(uid),
    sourceDataCleared: Object.values(sources).every((source) => source.cleared),
    sources: sourceList,
    alignment,
    scenes: unionScenes(["adItem", "content", "keyword", "crowd"]),
    scenesByView: {
      product: [],
      "ad-products": unionScenes(["adItem", "content"]),
      keywords: unionScenes(["keyword"]),
      crowds: unionScenes(["crowd"]),
      contents: unionScenes(["content"]),
      sources: []
    }
  };
}

// 对外导出:带结果缓存的 view(同参数重复请求直接命中 ~0ms)。
// 每个 view 声明依赖哪些源表;源文件签名变化(上传)即自动失效。
export const buildProductView = (userId, range = {}) =>
  cachedView(requireUserId(userId), "product", range, ["product", "adItem", "content"], () =>
    buildProductViewRaw(userId, range)
  );
export const buildAdProductsView = (userId, range = {}) =>
  cachedView(requireUserId(userId), "ad", range, ["adItem", "content"], () => buildAdProductsViewRaw(userId, range));
export const buildKeywordView = (userId, range = {}) =>
  cachedView(requireUserId(userId), "keyword", range, ["keyword"], () => buildKeywordViewRaw(userId, range));
export const buildCrowdView = (userId, range = {}) =>
  cachedView(requireUserId(userId), "crowd", range, ["crowd"], () => buildCrowdViewRaw(userId, range));
export const buildContentView = (userId, range = {}) =>
  cachedView(requireUserId(userId), "content", range, ["content"], () => buildContentViewRaw(userId, range));

// P4.15(二)用注入的历史行直接构建视图(管理员按区间在线浏览历史)。
// 复用同一套聚合逻辑、不经结果缓存;injected = { product/adItem/content/keyword/crowd: rows[] }。
export async function buildViewWithRows(viewName, userId, range, injected) {
  switch (viewName) {
    case "product":
      return buildProductViewRaw(userId, range, injected);
    case "ad-products":
      return buildAdProductsViewRaw(userId, range, injected);
    case "keywords":
      return buildKeywordViewRaw(userId, range, injected);
    case "crowds":
      return buildCrowdViewRaw(userId, range, injected);
    case "contents":
      return buildContentViewRaw(userId, range, injected);
    default:
      throw new Error(`未知视图: ${viewName}`);
  }
}

async function buildProductViewRaw(userId, range = {}, injected = null) {
  const { product, adItem, content } = injected || (await loadTables(userId, ["product", "adItem", "content"]));
  const rows = filterRows(product, range, "统计日期", ["商品名称", "商品标题", "商品ID"]);

  // 全店推广花费：从推广商品报表 + 推广内容报表的"花费"按日期聚合
  // （product 表的"推广消耗"字段在生参排行榜里普遍为空，不能作为全店口径）
  const adRows = filterRows([...adItem, ...content], range, "日期", ["主体名称", "计划名字", "场景名字", "主体ID", "计划ID"]);
  const adSpendByDate = new Map();
  for (const row of adRows) {
    const date = parseDateText(row["日期"]);
    if (!date) continue;
    adSpendByDate.set(date, (adSpendByDate.get(date) || 0) + cleanNumber(row["花费"]));
  }
  const adSpendByWeek = new Map();
  for (const [date, spend] of adSpendByDate) {
    const key = getIsoWeek(date).sortKey;
    adSpendByWeek.set(key, (adSpendByWeek.get(key) || 0) + spend);
  }
  const totalAdSpend = [...adSpendByDate.values()].reduce((sum, v) => sum + v, 0);

  // 按商品ID 聚合 adItem 花费（只 adItem 表的"主体类型=商品"行能 join 到 product 表
  // content 表"主体类型=短视频"，主体ID 是内容ID，无法可靠分摊到单品）
  const adItemSpendByItemId = new Map();
  const adItemSpendByItemAndDate = new Map();   // P0.1a 行下钻：按商品+日期细分
  // 同时收集主体名称用于补全 product 表里缺失的商品标题
  const adItemNameById = new Map();
  const adItemRowsFiltered = filterRows(adItem, range, "日期", ["主体名称", "计划名字", "场景名字", "主体ID", "计划ID"]);
  for (const row of adItemRowsFiltered) {
    if (row["主体类型"] !== "商品" || !row["主体ID"]) continue;
    const id = String(row["主体ID"]);
    const spend = cleanNumber(row["花费"]);
    adItemSpendByItemId.set(id, (adItemSpendByItemId.get(id) || 0) + spend);
    const dateKey = parseDateText(row["日期"]);
    if (dateKey) {
      if (!adItemSpendByItemAndDate.has(id)) adItemSpendByItemAndDate.set(id, new Map());
      const dayMap = adItemSpendByItemAndDate.get(id);
      dayMap.set(dateKey, (dayMap.get(dateKey) || 0) + spend);
    }
    if (!adItemNameById.has(id) && row["主体名称"]) {
      adItemNameById.set(id, String(row["主体名称"]));
    }
  }

  const groups = new Map();

  for (const row of rows) {
    const itemId = row["商品ID"] ? String(Math.trunc(cleanNumber(row["商品ID"]))) : "未识别";
    // 生参导出在不同版本下字段名不一致：早期叫"商品标题"，新版叫"商品名称"
    // 没拿到的情况下还能从 adItem 表的"主体名称"反查（join on 商品ID = 主体ID）
    const title = String(row["商品名称"] || row["商品标题"] || adItemNameById.get(itemId) || "未识别商品");
    const key = `${itemId}${title}`;
    addToGroup(
      groups,
      key,
      () => ({
        itemId,
        title,
        subjectCode: key,
        "年累计支付金额": 0,
        "平均停留时长_sum": 0,
        "平均停留时长_count": 0,
        dailyByDate: new Map()
      }),
      (target) => {
        sumFields(target, row, productFields);
        target["年累计支付金额"] = Math.max(cleanNumber(target["年累计支付金额"]), cleanNumber(row["年累计支付金额"]));
        const stay = cleanNumber(row["平均停留时长"]);
        if (stay) {
          target["平均停留时长_sum"] += stay;
          target["平均停留时长_count"] += 1;
        }
        // P0.1a 行下钻：按日累加该商品的当日数据
        const dateKey = parseDateText(row["统计日期"]);
        if (dateKey) {
          let day = target.dailyByDate.get(dateKey);
          if (!day) {
            day = { date: dateKey };
            target.dailyByDate.set(dateKey, day);
          }
          sumFields(day, row, productFields);
        }
      }
    );
  }

  const table = [...groups.values()].map((row) => {
    const pay = cleanNumber(row["支付金额"]);
    const refund = cleanNumber(row["成功退款金额"]);
    // 推广消耗：用 adItem 表按主体ID 聚合的实际花费，覆盖 product 表自带的空字段
    const itemSpend = adItemSpendByItemId.get(row.itemId) || 0;

    // P0.1a 行下钻：把 dailyByDate 转成排序后的 daily 数组，注入 adItem 当日花费 + 业务指标
    // 裁掉全零天（payment=0 且 refund=0 且 spend=0），让长尾商品的 daily 大幅瘦身
    const itemDailySpendMap = adItemSpendByItemAndDate.get(row.itemId) || new Map();
    const daily = [...row.dailyByDate.values()]
      .map((day) => {
        const dPay = cleanNumber(day["支付金额"]);
        const dRefund = cleanNumber(day["成功退款金额"]);
        const dSpend = itemDailySpendMap.get(day.date) || 0;
        const dNetPay = dPay - dRefund;
        return {
          date: day.date,
          payment: round(dPay, 2),
          refund: round(dRefund, 2),
          spend: round(dSpend, 2) || 0,
          visitors: round(day["商品访客数"], 0),
          feeRatio: dSpend > 0 && dPay > 0 ? round(div(dSpend, dPay), 4) : null,
          netFeeRatio: dSpend > 0 && dNetPay !== 0 ? round(div(dSpend, dNetPay), 4) : null,
          refundRatio: dPay > 0 ? round(div(dRefund, dPay), 4) : null,
          netRoi: dSpend > 0 ? round(dNetPay / dSpend, 4) : null
        };
      })
      .filter((d) => d.payment > 0 || d.refund > 0 || d.spend > 0)
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      ...enrichProductMetrics({
        subjectCode: row.subjectCode,
        "支付金额": pay,
        "成功退款金额": refund,
        "支付买家数": row["支付买家数"],
        "支付老买家数": row["支付老买家数"],
        "老买家支付金额": row["老买家支付金额"],
        "商品加购人数": row["商品加购人数"],
        "商品访客数": row["商品访客数"],
        "商品浏览量": row["商品浏览量"],
        "推广消耗": round(itemSpend, 2) || 0,
        annualPay: round(row["年累计支付金额"], 2),
        annualPayShare: round(div(row["支付金额"], row["年累计支付金额"]), 4),
        feeRatio: round(div(itemSpend, pay), 4),
        avgStay: round(div(row["平均停留时长_sum"], row["平均停留时长_count"]), 2)
      }),
      daily
    };
  });

  sortBy(table, "pay");
  const totalPay = table.reduce((sum, row) => sum + cleanNumber(row.pay), 0);
  const totalRefund = table.reduce((sum, row) => sum + cleanNumber(row["成功退款金额"]), 0);
  const allocatedSpend = table.reduce((sum, row) => sum + cleanNumber(row["推广消耗"]), 0);
  const promotedItemCount = table.filter((row) => cleanNumber(row["推广消耗"]) > 0).length;
  const treemap = table.map((row) => ({
    name: row.subjectCode,
    value: row.pay,
    share: round(div(row.pay, totalPay), 4),
    feeRatio: row.feeRatio
  }));

  const weekGroups = new Map();
  for (const row of rows) {
    const week = getIsoWeek(parseDateText(row["统计日期"]));
    addToGroup(weekGroups, week.sortKey, () => ({ week: week.label, sortKey: week.sortKey }), (target) => sumFields(target, row, productFields));
  }
  // 用 adItem+content 的周花费覆盖 product 表自带的"推广消耗"
  for (const target of weekGroups.values()) {
    target["推广消耗"] = round(adSpendByWeek.get(target.sortKey) || 0, 2) || 0;
  }
  const weekly = [...weekGroups.values()].map(enrichProductMetrics).sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));

  const dayGroups = new Map();
  for (const row of rows) {
    const date = parseDateText(row["统计日期"]);
    if (!date) continue;
    addToGroup(dayGroups, date, () => ({ date, sortKey: date }), (target) => sumFields(target, row, productFields));
  }
  // 用 adItem+content 的日花费覆盖 product 表自带的"推广消耗"
  for (const target of dayGroups.values()) {
    target["推广消耗"] = round(adSpendByDate.get(target.date) || 0, 2) || 0;
  }
  const daily = [...dayGroups.values()]
    .map(enrichProductMetrics)
    .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  // P3.2 智能异常检测：对每条 daily 打 flags 数组
  // 检测窗口 = 该日的前 7 日均值；偏离 > 阈值即标 flag
  detectProductDailyAnomalies(daily);

  return {
    summary: {
      rows: rows.length,
      groups: table.length,
      promotedItemCount,
      totalPay: round(totalPay, 2),
      totalRefund: round(totalRefund, 2),
      totalSpend: round(totalAdSpend, 2),
      allocatedSpend: round(allocatedSpend, 2),
      unallocatedSpend: round(totalAdSpend - allocatedSpend, 2),
      productTableSpend: 0,
      topShare: table[0] ? round(div(table[0].pay, totalPay), 4) : null,
      refundRatio: round(div(totalRefund, totalPay), 4),
      netFeeRatio: round(div(totalAdSpend, totalPay - totalRefund), 4),
      spendSource: "adUnion"
    },
    treemap,
    weekly,
    daily,
    table
  };
}

function adUnion(raw) {
  return [...raw.adItem, ...raw.content];
}

// P0.1b 行下钻：把 group target 上累计的 dailyByDate Map 转成可被前端消费的 daily 数组
// （丢掉 spend=0 && gmv=0 的天数，避免长尾对象塞一堆零值天）
function flushAdDailyByDate(target) {
  const days = [...(target.dailyByDate?.values() || [])];
  delete target.dailyByDate;
  return days
    .map((day) => {
      enrichAdMetrics(day);
      return {
        date: day.date,
        spend: cleanNumber(day.spend) || 0,
        gmv: cleanNumber(day.gmv) || 0,
        roi: day.roi,
        cpc: day.cpc,
        ctr: day.ctr,
        cvr: day.cvr,
        impressions: cleanNumber(day["展现量"]),
        clicks: cleanNumber(day["点击量"]),
        orders: cleanNumber(day["总成交笔数"])
      };
    })
    .filter((d) => d.spend > 0 || d.gmv > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// 在 group merge 阶段，把当前 row 累加到 target.dailyByDate 对应的日子
function accumulateAdDailyRow(target, row, dateField = "日期") {
  if (!target.dailyByDate) target.dailyByDate = new Map();
  const dateKey = parseDateText(row[dateField]);
  if (!dateKey) return;
  let day = target.dailyByDate.get(dateKey);
  if (!day) {
    day = { date: dateKey };
    target.dailyByDate.set(dateKey, day);
  }
  sumFields(day, row, adFields);
}

function buildAdSubject(rows) {
  const groups = new Map();
  for (const row of rows) {
    const id = row["主体ID"] ? String(row["主体ID"]) : "未识别";
    const name = row["主体名称"] || "未识别主体";
    const key = `${id}${name}`;
    addToGroup(groups, key, () => ({ subjectCode: key }), (target) => sumFields(target, row, adFields));
  }
  const table = [...groups.values()].map(enrichAdMetrics);
  sortBy(table, "spend");
  const totalSpend = table.reduce((sum, row) => sum + cleanNumber(row.spend), 0);
  return table.map((row) => ({ ...row, spendShare: round(div(row.spend, totalSpend), 4) }));
}

const adFields = ["花费", "总成交金额", "展现量", "点击量", "总成交笔数", "间接成交笔数", "总购物车数", "引导访问潜客数", "引导访问人数"];

async function buildAdProductsViewRaw(userId, range = {}, injected = null) {
  const raw = injected || (await loadTables(userId, ["adItem", "content"]));
  const rows = filterRows(adUnion(raw), range, "日期", ["主体名称", "计划名字", "场景名字", "主体ID", "计划ID"]);
  const subjects = buildAdSubject(rows);

  const sceneGroups = new Map();
  for (const row of rows) {
    const key = row["场景名字"] || "未识别场景";
    addToGroup(sceneGroups, key, () => ({ scene: key }), (target) => sumFields(target, row, adFields));
  }
  const scene = [...sceneGroups.values()].map(enrichAdMetrics);
  sortBy(scene, "spend");

  const weekGroups = new Map();
  for (const row of rows) {
    const week = getIsoWeek(parseDateText(row["日期"]));
    addToGroup(weekGroups, week.sortKey, () => ({ week: week.label, sortKey: week.sortKey }), (target) => sumFields(target, row, adFields));
  }
  const weekly = [...weekGroups.values()].map(enrichAdMetrics).sort((a, b) => String(b.sortKey).localeCompare(String(a.sortKey)));

  const dayGroups = new Map();
  for (const row of rows) {
    const date = parseDateText(row["日期"]);
    if (!date) continue;
    addToGroup(dayGroups, date, () => ({ date, sortKey: date }), (target) => sumFields(target, row, adFields));
  }
  const daily = [...dayGroups.values()].map(enrichAdMetrics).sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  const planGroups = new Map();
  for (const row of rows) {
    const key = `${row["计划名字"] || "未识别计划"}${row["主体名称"] || "未识别主体"}`;
    addToGroup(planGroups, key, () => ({ planCode: key }), (target) => {
      sumFields(target, row, adFields);
      accumulateAdDailyRow(target, row);
    });
  }
  const planTable = [...planGroups.values()].map((row) => {
    const daily = flushAdDailyByDate(row);
    enrichAdMetrics(row);
    row.daily = daily;
    return row;
  });
  sortBy(planTable, "spend");

  const totalSpend = subjects.reduce((sum, row) => sum + cleanNumber(row.spend), 0);
  return {
    summary: {
      rows: rows.length,
      subjects: subjects.length,
      plans: planTable.length,
      totalSpend: round(totalSpend, 2),
      totalGmv: round(subjects.reduce((sum, row) => sum + cleanNumber(row.gmv), 0), 2),
      roi: round(div(subjects.reduce((sum, row) => sum + cleanNumber(row.gmv), 0), totalSpend), 4)
    },
    treemap: subjects.map((row) => ({
      name: row.subjectCode,
      value: row.spend,
      roi: row.roi,
      share: row.spendShare
    })),
    scene,
    weekly,
    daily,
    planTable
  };
}

async function buildKeywordViewRaw(userId, range = {}, injected = null) {
  const raw = injected || (await loadTables(userId, ["keyword"]));
  const rows = filterRows(raw.keyword, range, "日期", ["词名字/词包名字", "宝贝名称", "计划名字", "宝贝ID", "词ID/词包ID", "计划ID", "单元ID"]);
  const groups = new Map();
  const wordGroups = new Map();
  const typeGroups = new Map();

  for (const row of rows) {
    const keywordCode = `${row["词类型"] || "未知"}${row["词名字/词包名字"] || "未命名"}${row["宝贝名称"] || ""}`;
    addToGroup(groups, keywordCode, () => ({ keywordCode, type: row["词类型"], word: row["词名字/词包名字"] }), (target) => {
      sumFields(target, row, [...adFields, "平均展现排名"]);
      target.rankWeighted = cleanNumber(target.rankWeighted) + cleanNumber(row["平均展现排名"]) * cleanNumber(row["展现量"]);
      accumulateAdDailyRow(target, row);
    });
    const word = row["词名字/词包名字"] || "未命名";
    addToGroup(wordGroups, word, () => ({ name: word, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
    const type = row["词类型"] || "未知";
    addToGroup(typeGroups, type, () => ({ name: type, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
  }

  const table = [...groups.values()].map((row) => {
    const daily = flushAdDailyByDate(row);
    enrichAdMetrics(row);
    row.avgRank = round(div(row.rankWeighted, row["展现量"]), 4);
    row.daily = daily;
    return row;
  });
  sortBy(table, "spend");

  const dayGroups = new Map();
  for (const row of rows) {
    const date = parseDateText(row["日期"]);
    if (!date) continue;
    addToGroup(dayGroups, date, () => ({ date, sortKey: date }), (target) => sumFields(target, row, adFields));
  }
  const daily = [...dayGroups.values()].map(enrichAdMetrics).sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  return {
    summary: {
      rows: rows.length,
      groups: table.length,
      totalSpend: round(table.reduce((sum, row) => sum + cleanNumber(row.spend), 0), 2)
    },
    wordCloud: sortBy([...wordGroups.values()], "value").slice(0, 160),
    typePie: sortBy([...typeGroups.values()], "value"),
    bubble: table.slice(0, 120).map((row) => ({
      name: row.word,
      value: [row.cvr || 0, row.spend || 0, row.gmv || 0],
      roi: row.roi
    })),
    daily,
    table
  };
}

async function buildCrowdViewRaw(userId, range = {}, injected = null) {
  const raw = injected || (await loadTables(userId, ["crowd"]));
  const rows = filterRows(raw.crowd, range, "日期", ["人群名字", "主体名称", "单元名字", "场景名字", "主体ID", "计划ID", "单元ID"]);
  const groups = new Map();
  const sceneWords = new Map();
  const crowdWords = new Map();

  for (const row of rows) {
    const crowdCode = `${row["人群名字"] || "未识别人群"}${row["场景名字"] || ""}${row["单元名字"] || ""}`;
    addToGroup(groups, crowdCode, () => ({ crowdCode }), (target) => {
      sumFields(target, row, adFields);
      accumulateAdDailyRow(target, row);
    });
    const scene = row["场景名字"] || "未识别场景";
    addToGroup(sceneWords, scene, () => ({ name: scene, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
    const crowd = row["人群名字"] || "未识别人群";
    addToGroup(crowdWords, crowd, () => ({ name: crowd, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
  }

  const table = [...groups.values()].map((row) => {
    const daily = flushAdDailyByDate(row);
    enrichAdMetrics(row);
    row.daily = daily;
    return row;
  }).filter((row) => cleanNumber(row.spend) > 0);
  sortBy(table, "spend");

  const dayGroups = new Map();
  for (const row of rows) {
    const date = parseDateText(row["日期"]);
    if (!date) continue;
    addToGroup(dayGroups, date, () => ({ date, sortKey: date }), (target) => sumFields(target, row, adFields));
  }
  const daily = [...dayGroups.values()].map(enrichAdMetrics).sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  return {
    summary: {
      rows: rows.length,
      groups: table.length,
      totalSpend: round(table.reduce((sum, row) => sum + cleanNumber(row.spend), 0), 2)
    },
    sceneWords: sortBy([...sceneWords.values()], "value"),
    crowdWords: sortBy([...crowdWords.values()], "value").slice(0, 120),
    daily,
    table
  };
}

async function buildContentViewRaw(userId, range = {}, injected = null) {
  const raw = injected || (await loadTables(userId, ["content"]));
  const rows = filterRows(raw.content, range, "日期", ["主体名称", "计划名字", "主体类型", "主体ID", "计划ID"]);
  const groups = new Map();
  for (const row of rows) {
    const contentCode = `${row["主体类型"] || "内容"}${row["主体名称"] || "未命名内容"}`;
    addToGroup(groups, contentCode, () => ({ contentCode, type: row["主体类型"] || "内容" }), (target) => {
      sumFields(target, row, adFields);
      accumulateAdDailyRow(target, row);
    });
  }
  const table = [...groups.values()].map((row) => {
    const daily = flushAdDailyByDate(row);
    enrichAdMetrics(row);
    row.daily = daily;
    return row;
  });
  sortBy(table, "spend");

  const dayGroups = new Map();
  for (const row of rows) {
    const date = parseDateText(row["日期"]);
    if (!date) continue;
    addToGroup(dayGroups, date, () => ({ date, sortKey: date }), (target) => sumFields(target, row, adFields));
  }
  const daily = [...dayGroups.values()].map(enrichAdMetrics).sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  return {
    summary: {
      rows: rows.length,
      groups: table.length,
      totalSpend: round(table.reduce((sum, row) => sum + cleanNumber(row.spend), 0), 2)
    },
    treemap: table.map((row) => ({
      name: row.contentCode,
      value: row.spend,
      roi: row.roi
    })),
    daily,
    table
  };
}
