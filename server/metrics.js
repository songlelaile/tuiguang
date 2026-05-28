import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";
import XLSX from "xlsx";

const dataDir = process.env.HUOPAN_DATA_DIR || path.resolve(process.cwd(), "data", "source-data");
const uploadDir = process.env.HUOPAN_UPLOAD_DIR || path.resolve(process.cwd(), "uploads", "source-data");
const clearedStateFile = path.join(uploadDir, ".sources-cleared");

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

let rawCache;

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function defaultSourcePath(slot) {
  return path.join(dataDir, slot.defaultFile);
}

export function getUploadDir() {
  return uploadDir;
}

export function getUploadedSourcePath(sourceId) {
  const slot = sourceUploadSlots.find((item) => item.id === sourceId);
  if (!slot) throw new Error(`Unknown source id: ${sourceId}`);
  return path.join(uploadDir, slot.uploadFile);
}

export function resetRawCache() {
  rawCache = undefined;
}

export async function clearSourceData() {
  await fs.rm(uploadDir, { recursive: true, force: true });
  await fs.mkdir(uploadDir, { recursive: true });
  await fs.writeFile(clearedStateFile, new Date().toISOString(), "utf8");
  resetRawCache();
}

async function resolveSourceFiles() {
  const sourceDataCleared = await fileExists(clearedStateFile);
  const entries = await Promise.all(
    sourceUploadSlots.map(async (slot) => {
      const uploadedPath = getUploadedSourcePath(slot.id);
      const uploaded = await fileExists(uploadedPath);
      const mode = uploaded ? "uploaded" : sourceDataCleared ? "empty" : "default";
      return [
        slot.id,
        {
          ...slot,
          file: mode === "empty" ? "" : uploaded ? uploadedPath : defaultSourcePath(slot),
          uploaded,
          mode,
          cleared: mode === "empty"
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
  const rows = parse(text, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true
  });
  return rows.map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = moneyFields.has(key) ? cleanNumber(value) : value;
    }
    return out;
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

async function loadRaw() {
  if (rawCache) return rawCache;
  const sources = await resolveSourceFiles();
  const [product, adItem, content, keyword, crowd] = await Promise.all([
    safeRead(sources.product, readProductWorkbook),
    safeRead(sources.adItem, readCsv),
    safeRead(sources.content, readCsv),
    safeRead(sources.keyword, readCsv),
    safeRead(sources.crowd, readCsv)
  ]);
  rawCache = { product, adItem, content, keyword, crowd };
  return rawCache;
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

export async function buildMeta() {
  const sources = await resolveSourceFiles();
  const raw = await loadRaw();
  const uniqueScenes = (rows) => [...new Set(rows.map((row) => row["场景名字"]).filter(Boolean))].sort();
  const sourceMeta = (id, rows, dateField) => ({
    id,
    name: sourceNames[id],
    file: sources[id].file || "已清空源数据",
    uploaded: sources[id].uploaded,
    mode: sources[id].mode,
    cleared: sources[id].cleared,
    rows: rows.length,
    dateField,
    ...dateRange(rows, dateField)
  });
  const sourceList = [
    sourceMeta("product", raw.product, sourceDateFields.product),
    sourceMeta("adItem", raw.adItem, sourceDateFields.adItem),
    sourceMeta("content", raw.content, sourceDateFields.content),
    sourceMeta("keyword", raw.keyword, sourceDateFields.keyword),
    sourceMeta("crowd", raw.crowd, sourceDateFields.crowd)
  ];
  const alignment = computeAlignment(
    Object.fromEntries(sourceList.map((item) => [item.id, { start: item.start, end: item.end }]))
  );
  return {
    dataDir,
    uploadDir,
    sourceDataCleared: Object.values(sources).some((source) => source.cleared),
    sources: sourceList,
    alignment,
    scenes: uniqueScenes([...raw.adItem, ...raw.content, ...raw.keyword, ...raw.crowd]),
    scenesByView: {
      product: [],
      "ad-products": uniqueScenes([...raw.adItem, ...raw.content]),
      keywords: uniqueScenes(raw.keyword),
      crowds: uniqueScenes(raw.crowd),
      contents: uniqueScenes(raw.content),
      sources: []
    }
  };
}

export async function buildProductView(range = {}) {
  const { product, adItem, content } = await loadRaw();
  const rows = filterRows(product, range, "统计日期", ["商品标题", "商品ID"]);

  // 全店推广花费：从推广商品报表 + 推广内容报表的"花费"按日期聚合
  // （product 表的"推广消耗"字段在生参排行榜里普遍为空，不能作为全店口径）
  const adRows = filterRows([...adItem, ...content], range, "日期", ["主体名称", "计划名字", "场景名字"]);
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

  const groups = new Map();

  for (const row of rows) {
    const itemId = row["商品ID"] ? String(Math.trunc(cleanNumber(row["商品ID"]))) : "未识别";
    const title = String(row["商品标题"] || "未识别商品");
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
        "平均停留时长_count": 0
      }),
      (target) => {
        sumFields(target, row, productFields);
        target["年累计支付金额"] = Math.max(cleanNumber(target["年累计支付金额"]), cleanNumber(row["年累计支付金额"]));
        const stay = cleanNumber(row["平均停留时长"]);
        if (stay) {
          target["平均停留时长_sum"] += stay;
          target["平均停留时长_count"] += 1;
        }
      }
    );
  }

  const table = [...groups.values()].map((row) => {
    const pay = cleanNumber(row["支付金额"]);
    const spend = cleanNumber(row["推广消耗"]);
    const refund = cleanNumber(row["成功退款金额"]);
    return enrichProductMetrics({
      subjectCode: row.subjectCode,
      "支付金额": pay,
      "成功退款金额": refund,
      "支付买家数": row["支付买家数"],
      "支付老买家数": row["支付老买家数"],
      "老买家支付金额": row["老买家支付金额"],
      "商品加购人数": row["商品加购人数"],
      "商品访客数": row["商品访客数"],
      "商品浏览量": row["商品浏览量"],
      "推广消耗": spend,
      annualPay: round(row["年累计支付金额"], 2),
      annualPayShare: round(div(row["支付金额"], row["年累计支付金额"]), 4),
      feeRatio: round(div(row["推广消耗"], row["支付金额"]), 4),
      avgStay: round(div(row["平均停留时长_sum"], row["平均停留时长_count"]), 2)
    });
  });

  sortBy(table, "pay");
  const totalPay = table.reduce((sum, row) => sum + cleanNumber(row.pay), 0);
  const totalRefund = table.reduce((sum, row) => sum + cleanNumber(row["成功退款金额"]), 0);
  const totalSpend = table.reduce((sum, row) => sum + cleanNumber(row["推广消耗"]), 0);
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
    .map((row) => {
      // 标记单日异常：退款金额 > 支付金额（净支付为负，net 费比因此变成大负数）
      // 通常是退款滞后入账造成的口径错位，非真实业务恶化
      const pay = cleanNumber(row["支付金额"]);
      const refund = cleanNumber(row["成功退款金额"]);
      if (pay > 0 && refund > pay) {
        row.anomalous = true;
        row.anomalyKind = "refund_exceeds_pay";
        row.anomalyHint = "退款金额 > 支付金额，单日净费比受滞后退款冲账影响，建议结合 7 日均线观察";
      } else {
        row.anomalous = false;
      }
      return row;
    })
    .sort((a, b) => String(a.sortKey).localeCompare(String(b.sortKey)));

  return {
    summary: {
      rows: rows.length,
      groups: table.length,
      totalPay: round(totalPay, 2),
      totalRefund: round(totalRefund, 2),
      totalSpend: round(totalAdSpend, 2),
      productTableSpend: round(totalSpend, 2),
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

export async function buildAdProductsView(range = {}) {
  const raw = await loadRaw();
  const rows = filterRows(adUnion(raw), range, "日期", ["主体名称", "计划名字", "场景名字"]);
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
    addToGroup(planGroups, key, () => ({ planCode: key }), (target) => sumFields(target, row, adFields));
  }
  const planTable = [...planGroups.values()].map(enrichAdMetrics);
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

export async function buildKeywordView(range = {}) {
  const raw = await loadRaw();
  const rows = filterRows(raw.keyword, range, "日期", ["词名字/词包名字", "宝贝名称", "计划名字"]);
  const groups = new Map();
  const wordGroups = new Map();
  const typeGroups = new Map();

  for (const row of rows) {
    const keywordCode = `${row["词类型"] || "未知"}${row["词名字/词包名字"] || "未命名"}${row["宝贝名称"] || ""}`;
    addToGroup(groups, keywordCode, () => ({ keywordCode, type: row["词类型"], word: row["词名字/词包名字"] }), (target) => {
      sumFields(target, row, [...adFields, "平均展现排名"]);
      target.rankWeighted = cleanNumber(target.rankWeighted) + cleanNumber(row["平均展现排名"]) * cleanNumber(row["展现量"]);
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
    enrichAdMetrics(row);
    row.avgRank = round(div(row.rankWeighted, row["展现量"]), 4);
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

export async function buildCrowdView(range = {}) {
  const raw = await loadRaw();
  const rows = filterRows(raw.crowd, range, "日期", ["人群名字", "主体名称", "单元名字", "场景名字"]);
  const groups = new Map();
  const sceneWords = new Map();
  const crowdWords = new Map();

  for (const row of rows) {
    const crowdCode = `${row["人群名字"] || "未识别人群"}${row["场景名字"] || ""}${row["单元名字"] || ""}`;
    addToGroup(groups, crowdCode, () => ({ crowdCode }), (target) => sumFields(target, row, adFields));
    const scene = row["场景名字"] || "未识别场景";
    addToGroup(sceneWords, scene, () => ({ name: scene, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
    const crowd = row["人群名字"] || "未识别人群";
    addToGroup(crowdWords, crowd, () => ({ name: crowd, value: 0 }), (target) => {
      target.value += cleanNumber(row["花费"]);
    });
  }

  const table = [...groups.values()].map(enrichAdMetrics).filter((row) => cleanNumber(row.spend) > 0);
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

export async function buildContentView(range = {}) {
  const raw = await loadRaw();
  const rows = filterRows(raw.content, range, "日期", ["主体名称", "计划名字", "主体类型"]);
  const groups = new Map();
  for (const row of rows) {
    const contentCode = `${row["主体类型"] || "内容"}${row["主体名称"] || "未命名内容"}`;
    addToGroup(groups, contentCode, () => ({ contentCode, type: row["主体类型"] || "内容" }), (target) => sumFields(target, row, adFields));
  }
  const table = [...groups.values()].map(enrichAdMetrics);
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
