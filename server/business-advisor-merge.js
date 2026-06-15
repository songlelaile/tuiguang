// 生意参谋「商品_全部」多日表合并
//
// 把一批 `【生意参谋平台】商品_全部_YYYY-MM-DD_YYYY-MM-DD.xls` 日表
// 合并成单个 .xlsx（一行表头 + 按日期升序的数据），可直接当「商品维度」源表用。
//
// 设计要点（对应需求）：
//   - 文件名提取日期；自动定位"既含 统计日期 又含 商品ID"的那一行作表头
//   - 表头一致性校验：以第一张表为准，后续必须完全一致
//   - 行校验：每行 统计日期 必须等于文件名日期
//   - 单元格清洗：空→空；商品ID/编码列强制文本，避免科学计数法/丢精度
//   - 重复日期不静默覆盖：预检列出，由调用方传 resolution 显式选择保留哪份
//
// 解析用 xlsx（SheetJS，能读老版 .xls）；写出也用 xlsx。

import XLSX from "xlsx";
import path from "node:path";

const REQUIRED_HEADER_KEYS = ["统计日期", "商品ID"];
// 这些列强制按文本输出，避免长数字（商品ID 等）变成科学计数法或丢精度
const FORCE_TEXT_HINTS = ["ID", "编码", "id"];

export function extractDatesFromName(name) {
  const base = path.basename(String(name || ""));
  const dates = [];
  const re = /(\d{4})-(\d{2})-(\d{2})/g;
  let m;
  while ((m = re.exec(base)) !== null) dates.push(`${m[1]}-${m[2]}-${m[3]}`);
  return dates;
}

export function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, mo, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// 枚举 [start, end] 闭区间内的每一天（YYYY-MM-DD）
export function enumerateDates(start, end) {
  if (!isValidDate(start) || !isValidDate(end) || start > end) return [];
  const out = [];
  let cur = Date.parse(`${start}T00:00:00Z`);
  const stop = Date.parse(`${end}T00:00:00Z`);
  while (cur <= stop) {
    out.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86400000;
  }
  return out;
}

function normalizeDate(value) {
  if (typeof value === "number") {
    const p = XLSX.SSF.parse_date_code(value);
    if (p) return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
  }
  const s = String(value ?? "").trim();
  const m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  return s;
}

function isForceTextHeader(header) {
  return FORCE_TEXT_HINTS.some((h) => header.includes(h));
}

// 找到既含"统计日期"又含"商品ID"的那一行作表头；返回行号，找不到返回 -1
function findHeaderRow(aoa) {
  for (let i = 0; i < aoa.length; i++) {
    const row = (aoa[i] || []).map((c) => String(c ?? "").trim());
    if (REQUIRED_HEADER_KEYS.every((k) => row.includes(k))) return i;
  }
  return -1;
}

// 解析单个工作簿文件 → { header, dataRows, headerRowIndex }
// header 为字符串数组；dataRows 为原始单元格二维数组（与 header 同列序）
export function parseWorkbookFile(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) return { header: null, dataRows: [], headerRowIndex: -1 };
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null, blankrows: false });
  const headerRowIndex = findHeaderRow(aoa);
  if (headerRowIndex < 0) return { header: null, dataRows: [], headerRowIndex: -1 };
  const header = aoa[headerRowIndex].map((c) => String(c ?? "").trim());
  const dataRows = [];
  for (let i = headerRowIndex + 1; i < aoa.length; i++) {
    const raw = aoa[i];
    if (!raw || raw.every((c) => c === null || c === undefined || String(c).trim() === "")) continue;
    dataRows.push(raw);
  }
  return { header, dataRows, headerRowIndex };
}

function headersEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

// 让出事件循环，避免同步解析大量文件时把单进程 node 卡死
const yieldToLoop = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 预检：解析+校验，不做合并。
 * files: [{ name, path }]  name=原始文件名（用于取日期）
 * options: { start, end }  可选，给了就做日期完整性校验
 */
export async function preflight(files, options = {}) {
  const { start = "", end = "" } = options;
  const parsedFiles = [];
  let headerStandard = null;
  const headerMismatches = [];
  const headerMissing = [];
  const rangeFiles = [];
  const dateRowMismatches = [];
  const byDate = new Map(); // date -> [name,...]

  for (const f of files) {
    await yieldToLoop();
    const names = extractDatesFromName(f.name);
    const primaryDate = names[0] || "";
    const isRange = names.length >= 2 && names[0] !== names[1];
    if (isRange) rangeFiles.push({ name: f.name, dates: names });

    let parsed;
    try {
      parsed = parseWorkbookFile(f.path);
    } catch (err) {
      headerMissing.push({ name: f.name, reason: `无法解析文件：${err.message}` });
      parsedFiles.push({ name: f.name, date: primaryDate, rows: 0, headerOk: false });
      continue;
    }

    if (!parsed.header) {
      headerMissing.push({ name: f.name, reason: "未找到同时包含「统计日期」和「商品ID」的表头行" });
      parsedFiles.push({ name: f.name, date: primaryDate, rows: 0, headerOk: false });
      continue;
    }

    // 表头一致性
    let headerOk = true;
    if (!headerStandard) {
      headerStandard = parsed.header;
    } else if (!headersEqual(headerStandard, parsed.header)) {
      headerOk = false;
      headerMismatches.push({ name: f.name, reason: `表头与首张表不一致（${parsed.header.length} 列 vs ${headerStandard.length} 列）` });
    }

    // 行日期校验：每行 统计日期 应等于文件名日期
    let mismatchCount = 0;
    const foundSet = new Set();
    if (primaryDate && isValidDate(primaryDate)) {
      const dateIdx = parsed.header.indexOf("统计日期");
      if (dateIdx >= 0) {
        for (const row of parsed.dataRows) {
          const d = normalizeDate(row[dateIdx]);
          if (d !== primaryDate) {
            mismatchCount += 1;
            if (foundSet.size < 5) foundSet.add(d || "(空)");
          }
        }
      }
    }
    if (mismatchCount > 0) {
      dateRowMismatches.push({ name: f.name, expected: primaryDate, foundSample: [...foundSet], count: mismatchCount });
    }

    if (primaryDate) {
      if (!byDate.has(primaryDate)) byDate.set(primaryDate, []);
      byDate.get(primaryDate).push(f.name);
    }

    parsedFiles.push({
      name: f.name,
      date: primaryDate,
      rows: parsed.dataRows.length,
      headerOk,
      isRange,
      dateMismatchCount: mismatchCount
    });
  }

  const validDates = parsedFiles.map((f) => f.date).filter((d) => d && isValidDate(d)).sort();
  const detectedStart = validDates[0] || "";
  const detectedEnd = validDates[validDates.length - 1] || "";

  const duplicateDates = [...byDate.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([date, names]) => ({ date, files: names }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // 缺失日期（仅给了 start/end 时）
  let missingDates = [];
  if (start && end && isValidDate(start) && isValidDate(end)) {
    const have = new Set([...byDate.keys()]);
    missingDates = enumerateDates(start, end).filter((d) => !have.has(d));
  }

  // 无效文件名（取不到合法日期）
  const noDateFiles = parsedFiles.filter((f) => !f.date || !isValidDate(f.date)).map((f) => f.name);

  const blocking = [];
  if (headerMissing.length) blocking.push(`${headerMissing.length} 个文件未找到有效表头`);
  if (headerMismatches.length) blocking.push(`${headerMismatches.length} 个文件表头与首张表不一致`);
  if (noDateFiles.length) blocking.push(`${noDateFiles.length} 个文件名中无法识别日期`);

  const totalRows = parsedFiles.reduce((sum, f) => sum + (f.rows || 0), 0);

  return {
    fileCount: files.length,
    parsedCount: parsedFiles.filter((f) => f.headerOk !== false && f.rows >= 0).length,
    detectedStart,
    detectedEnd,
    headerStandard: headerStandard || [],
    columnCount: headerStandard ? headerStandard.length : 0,
    files: parsedFiles,
    headerMismatches,
    headerMissing,
    noDateFiles,
    rangeFiles,
    duplicateDates,
    missingDates,
    dateRowMismatches,
    totalRows,
    blocking,
    needsResolution: duplicateDates.length > 0,
    canMerge: blocking.length === 0
  };
}

function normalizeCellForOutput(value, header) {
  if (value === null || value === undefined) return "";
  if (header === "统计日期") return normalizeDate(value);
  if (typeof value === "number") {
    if (isForceTextHeader(header)) {
      // 整数 ID 直接 String；JS 安全整数范围内（< 2^53）精度无损
      return Number.isInteger(value) ? String(value) : String(value);
    }
    return value; // 金额/数量等保留数值，Excel 里能直接计算
  }
  const s = String(value).trim();
  return s;
}

/**
 * 合并：按 resolution 选定每个重复日期保留的文件，输出 AOA + 汇总。
 * files: [{ name, path }]
 * options: { resolution: {date: keptName}, start, end }
 * 返回 { aoa, summary, header }
 */
export async function mergeFiles(files, options = {}) {
  const { resolution = {}, start = "", end = "" } = options;

  // 先建立 date -> [file] 映射，并解析表头标准
  const byDate = new Map();
  let headerStandard = null;
  for (const f of files) {
    await yieldToLoop();
    const primaryDate = extractDatesFromName(f.name)[0] || "";
    if (!primaryDate || !isValidDate(primaryDate)) continue;
    const parsed = parseWorkbookFile(f.path);
    if (!parsed.header) continue;
    if (!headerStandard) headerStandard = parsed.header;
    else if (!headersEqual(headerStandard, parsed.header)) {
      throw new Error(`文件「${f.name}」表头与首张表不一致，无法合并`);
    }
    if (!byDate.has(primaryDate)) byDate.set(primaryDate, []);
    byDate.get(primaryDate).push({ ...f, parsed, primaryDate });
  }

  if (!headerStandard) throw new Error("没有可合并的有效文件（未识别到表头）");

  const dateIdx = headerStandard.indexOf("统计日期");
  const dates = [...byDate.keys()].sort();
  const usedFiles = [];
  const rows = [];

  for (const date of dates) {
    if (start && date < start) continue;
    if (end && date > end) continue;
    const candidates = byDate.get(date);
    let chosen;
    if (candidates.length === 1) {
      chosen = candidates[0];
    } else {
      // 重复日期：必须有 resolution 指定保留哪份
      const keptName = resolution[date];
      chosen = candidates.find((c) => c.name === keptName);
      if (!chosen) {
        throw new Error(`日期 ${date} 有 ${candidates.length} 个文件，请先选择保留哪一份`);
      }
    }
    usedFiles.push({ date, name: chosen.name });
    for (const raw of chosen.parsed.dataRows) {
      const out = headerStandard.map((h, i) => normalizeCellForOutput(raw[i], h));
      // 强制 统计日期 列与文件名日期一致（前面已校验，这里兜底统一）
      if (dateIdx >= 0) out[dateIdx] = date;
      rows.push(out);
    }
  }

  const aoa = [headerStandard, ...rows];
  const summary = {
    fileCount: usedFiles.length,
    rows: rows.length,
    columns: headerStandard.length,
    firstDate: usedFiles.length ? usedFiles[0].date : "",
    lastDate: usedFiles.length ? usedFiles[usedFiles.length - 1].date : "",
    usedFiles
  };
  return { aoa, summary, header: headerStandard };
}

// 把 AOA 写成 xlsx Buffer。sheetName 默认「商品维度」——
// 与 readProductWorkbook 的 `Sheets["商品维度"] || 第一个 sheet` 对齐，确保能直接当源表读。
export function workbookBuffer(aoa, sheetName = "商品维度") {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  if (aoa.length && aoa[0].length) {
    const ref = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: aoa[0].length - 1 } });
    ws["!autofilter"] = { ref };
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}
