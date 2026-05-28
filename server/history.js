// P1 — 长期存储模块（SQLite 双写）
//
// 设计原则：
//   - 现有 metrics.js 计算路径完全不动；这里只追加 + 暴露独立的 history API
//   - 主键 (date, 业务主键)，同一天同一对象后传覆盖前传
//   - 每张表带一份 raw_json，方便生参字段未来变动时反序列化拿任意字段
//   - 写入失败不应让上传失败（调用方包 try/catch + log）

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const HISTORY_DB_PATH = process.env.HUOPAN_HISTORY_DB || path.resolve(process.cwd(), "data", "history.sqlite");

let db = null;

function ensureDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(HISTORY_DB_PATH), { recursive: true });
  db = new Database(HISTORY_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  initSchema(db);
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uploaded_at TEXT NOT NULL,
      product_rows INTEGER, ad_item_rows INTEGER, content_rows INTEGER,
      keyword_rows INTEGER, crowd_rows INTEGER,
      date_min TEXT, date_max TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS product_daily (
      date TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT,
      payment REAL, refund REAL, visitors INTEGER, page_views INTEGER,
      pay_buyers INTEGER, repeat_buyers INTEGER, repeat_payment REAL,
      cart_buyers INTEGER, ad_spend REAL, annual_pay REAL,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (date, item_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ad_item (
      date TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      subject_name TEXT, subject_type TEXT, plan_name TEXT,
      scene_id TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER, cart_count INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (date, subject_id, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS content (
      date TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      subject_name TEXT, subject_type TEXT, plan_name TEXT,
      scene_id TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (date, subject_id, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS keyword (
      date TEXT NOT NULL,
      word_key TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      word_type TEXT, word_name TEXT, item_id TEXT, plan_name TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER, avg_rank REAL,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (date, word_key, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS crowd (
      date TEXT NOT NULL,
      crowd_key TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      crowd_name TEXT, unit_name TEXT, subject_name TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (date, crowd_key, plan_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_product_daily_date  ON product_daily(date);
    CREATE INDEX IF NOT EXISTS idx_product_daily_item  ON product_daily(item_id);
    CREATE INDEX IF NOT EXISTS idx_ad_item_date        ON ad_item(date);
    CREATE INDEX IF NOT EXISTS idx_ad_item_subject     ON ad_item(subject_id);
    CREATE INDEX IF NOT EXISTS idx_content_date        ON content(date);
    CREATE INDEX IF NOT EXISTS idx_content_subject     ON content(subject_id);
    CREATE INDEX IF NOT EXISTS idx_keyword_date        ON keyword(date);
    CREATE INDEX IF NOT EXISTS idx_keyword_word        ON keyword(word_name);
    CREATE INDEX IF NOT EXISTS idx_crowd_date          ON crowd(date);
    CREATE INDEX IF NOT EXISTS idx_crowd_name          ON crowd(crowd_name);
  `);
}

// ---- 工具 ----

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/,/g, "").replace(/%/g, ""));
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function str(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function dateKey(value) {
  const text = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

// ---- 公共入口 ----

export function ingestUpload({ product = [], adItem = [], content = [], keyword = [], crowd = [], note = "" }) {
  const conn = ensureDb();
  const uploadedAt = new Date().toISOString();

  // 计算本次上传日期范围
  const allDates = [
    ...product.map((r) => dateKey(r["统计日期"])),
    ...adItem.map((r) => dateKey(r["日期"])),
    ...content.map((r) => dateKey(r["日期"])),
    ...keyword.map((r) => dateKey(r["日期"])),
    ...crowd.map((r) => dateKey(r["日期"]))
  ].filter(Boolean).sort();
  const dateMin = allDates[0] || null;
  const dateMax = allDates[allDates.length - 1] || null;

  const txn = conn.transaction(() => {
    const upload = conn
      .prepare(
        `INSERT INTO uploads(uploaded_at, product_rows, ad_item_rows, content_rows, keyword_rows, crowd_rows, date_min, date_max, note)
         VALUES (@uploaded_at, @product_rows, @ad_item_rows, @content_rows, @keyword_rows, @crowd_rows, @date_min, @date_max, @note)`
      )
      .run({
        uploaded_at: uploadedAt,
        product_rows: product.length,
        ad_item_rows: adItem.length,
        content_rows: content.length,
        keyword_rows: keyword.length,
        crowd_rows: crowd.length,
        date_min: dateMin,
        date_max: dateMax,
        note: note || null
      });
    const uploadId = upload.lastInsertRowid;

    ingestProduct(conn, product, uploadId, uploadedAt);
    ingestAdItem(conn, adItem, uploadId, uploadedAt);
    ingestContent(conn, content, uploadId, uploadedAt);
    ingestKeyword(conn, keyword, uploadId, uploadedAt);
    ingestCrowd(conn, crowd, uploadId, uploadedAt);

    return uploadId;
  });

  return { uploadId: Number(txn()), dateMin, dateMax };
}

function ingestProduct(conn, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO product_daily(date, item_id, item_name, payment, refund, visitors, page_views,
      pay_buyers, repeat_buyers, repeat_payment, cart_buyers, ad_spend, annual_pay,
      raw_json, upload_id, last_updated_at)
    VALUES (@date, @item_id, @item_name, @payment, @refund, @visitors, @page_views,
      @pay_buyers, @repeat_buyers, @repeat_payment, @cart_buyers, @ad_spend, @annual_pay,
      @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(date, item_id) DO UPDATE SET
      item_name = excluded.item_name,
      payment = excluded.payment, refund = excluded.refund,
      visitors = excluded.visitors, page_views = excluded.page_views,
      pay_buyers = excluded.pay_buyers, repeat_buyers = excluded.repeat_buyers,
      repeat_payment = excluded.repeat_payment, cart_buyers = excluded.cart_buyers,
      ad_spend = excluded.ad_spend, annual_pay = excluded.annual_pay,
      raw_json = excluded.raw_json,
      upload_id = excluded.upload_id,
      last_updated_at = excluded.last_updated_at
  `);
  for (const row of rows) {
    const date = dateKey(row["统计日期"]);
    const itemId = str(row["商品ID"]);
    if (!date || !itemId) continue;
    stmt.run({
      date,
      item_id: itemId,
      item_name: str(row["商品名称"] || row["商品标题"]),
      payment: num(row["支付金额"]),
      refund: num(row["成功退款金额"]),
      visitors: int(row["商品访客数"]),
      page_views: int(row["商品浏览量"]),
      pay_buyers: int(row["支付买家数"]),
      repeat_buyers: int(row["支付老买家数"]),
      repeat_payment: num(row["老买家支付金额"]),
      cart_buyers: int(row["商品加购人数"]),
      ad_spend: num(row["推广消耗"]),
      annual_pay: num(row["年累计支付金额"]),
      raw_json: JSON.stringify(row),
      upload_id: uploadId,
      last_updated_at: uploadedAt
    });
  }
}

function ingestAdLike(conn, table, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO ${table}(date, subject_id, plan_id, subject_name, subject_type, plan_name,
      scene_id, scene_name, spend, gmv, impressions, clicks, orders${table === "ad_item" ? ", cart_count" : ""},
      raw_json, upload_id, last_updated_at)
    VALUES (@date, @subject_id, @plan_id, @subject_name, @subject_type, @plan_name,
      @scene_id, @scene_name, @spend, @gmv, @impressions, @clicks, @orders${table === "ad_item" ? ", @cart_count" : ""},
      @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(date, subject_id, plan_id) DO UPDATE SET
      subject_name = excluded.subject_name, subject_type = excluded.subject_type,
      plan_name = excluded.plan_name, scene_id = excluded.scene_id, scene_name = excluded.scene_name,
      spend = excluded.spend, gmv = excluded.gmv,
      impressions = excluded.impressions, clicks = excluded.clicks, orders = excluded.orders,
      ${table === "ad_item" ? "cart_count = excluded.cart_count," : ""}
      raw_json = excluded.raw_json,
      upload_id = excluded.upload_id, last_updated_at = excluded.last_updated_at
  `);
  for (const row of rows) {
    const date = dateKey(row["日期"]);
    const subjectId = str(row["主体ID"]);
    const planId = str(row["计划ID"]) || "0";
    if (!date || !subjectId) continue;
    const base = {
      date,
      subject_id: subjectId,
      plan_id: planId,
      subject_name: str(row["主体名称"]),
      subject_type: str(row["主体类型"]),
      plan_name: str(row["计划名字"]),
      scene_id: str(row["场景ID"]),
      scene_name: str(row["场景名字"]),
      spend: num(row["花费"]),
      gmv: num(row["总成交金额"]),
      impressions: int(row["展现量"]),
      clicks: int(row["点击量"]),
      orders: int(row["总成交笔数"]),
      raw_json: JSON.stringify(row),
      upload_id: uploadId,
      last_updated_at: uploadedAt
    };
    if (table === "ad_item") base.cart_count = int(row["总购物车数"]);
    stmt.run(base);
  }
}

function ingestAdItem(conn, rows, uploadId, ts) { ingestAdLike(conn, "ad_item", rows, uploadId, ts); }
function ingestContent(conn, rows, uploadId, ts) { ingestAdLike(conn, "content", rows, uploadId, ts); }

function ingestKeyword(conn, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO keyword(date, word_key, plan_id, word_type, word_name, item_id, plan_name, scene_name,
      spend, gmv, impressions, clicks, orders, avg_rank, raw_json, upload_id, last_updated_at)
    VALUES (@date, @word_key, @plan_id, @word_type, @word_name, @item_id, @plan_name, @scene_name,
      @spend, @gmv, @impressions, @clicks, @orders, @avg_rank, @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(date, word_key, plan_id) DO UPDATE SET
      word_type = excluded.word_type, word_name = excluded.word_name,
      item_id = excluded.item_id, plan_name = excluded.plan_name, scene_name = excluded.scene_name,
      spend = excluded.spend, gmv = excluded.gmv,
      impressions = excluded.impressions, clicks = excluded.clicks, orders = excluded.orders,
      avg_rank = excluded.avg_rank, raw_json = excluded.raw_json,
      upload_id = excluded.upload_id, last_updated_at = excluded.last_updated_at
  `);
  for (const row of rows) {
    const date = dateKey(row["日期"]);
    const wordName = str(row["词名字/词包名字"]);
    const wordType = str(row["词类型"]);
    if (!date || !wordName) continue;
    // word_key 含"宝贝"维度：同一天同一词在不同宝贝上的花费是独立记录
    const itemKey = str(row["宝贝名称"]) || str(row["宝贝ID"]) || str(row["商品ID"]) || "";
    stmt.run({
      date,
      word_key: `${wordType || ""}|${wordName}|${itemKey}`,
      plan_id: str(row["计划ID"]) || "0",
      word_type: wordType,
      word_name: wordName,
      item_id: str(row["宝贝ID"] || row["商品ID"]),
      plan_name: str(row["计划名字"]),
      scene_name: str(row["场景名字"]),
      spend: num(row["花费"]),
      gmv: num(row["总成交金额"]),
      impressions: int(row["展现量"]),
      clicks: int(row["点击量"]),
      orders: int(row["总成交笔数"]),
      avg_rank: num(row["平均展现排名"]),
      raw_json: JSON.stringify(row),
      upload_id: uploadId,
      last_updated_at: uploadedAt
    });
  }
}

function ingestCrowd(conn, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO crowd(date, crowd_key, plan_id, crowd_name, unit_name, subject_name, scene_name,
      spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at)
    VALUES (@date, @crowd_key, @plan_id, @crowd_name, @unit_name, @subject_name, @scene_name,
      @spend, @gmv, @impressions, @clicks, @orders, @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(date, crowd_key, plan_id) DO UPDATE SET
      crowd_name = excluded.crowd_name, unit_name = excluded.unit_name,
      subject_name = excluded.subject_name, scene_name = excluded.scene_name,
      spend = excluded.spend, gmv = excluded.gmv,
      impressions = excluded.impressions, clicks = excluded.clicks, orders = excluded.orders,
      raw_json = excluded.raw_json, upload_id = excluded.upload_id, last_updated_at = excluded.last_updated_at
  `);
  for (const row of rows) {
    const date = dateKey(row["日期"]);
    const crowdName = str(row["人群名字"]);
    if (!date || !crowdName) continue;
    stmt.run({
      date,
      crowd_key: `${crowdName}|${str(row["场景名字"]) || ""}|${str(row["单元名字"]) || ""}`,
      plan_id: str(row["计划ID"]) || "0",
      crowd_name: crowdName,
      unit_name: str(row["单元名字"]),
      subject_name: str(row["主体名称"]),
      scene_name: str(row["场景名字"]),
      spend: num(row["花费"]),
      gmv: num(row["总成交金额"]),
      impressions: int(row["展现量"]),
      clicks: int(row["点击量"]),
      orders: int(row["总成交笔数"]),
      raw_json: JSON.stringify(row),
      upload_id: uploadId,
      last_updated_at: uploadedAt
    });
  }
}

// ---- 查询 ----

export function getCoverage() {
  const conn = ensureDb();
  const totals = conn
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM uploads) AS uploads,
        (SELECT COUNT(*) FROM product_daily) AS product_rows,
        (SELECT COUNT(*) FROM ad_item) AS ad_item_rows,
        (SELECT COUNT(*) FROM content) AS content_rows,
        (SELECT COUNT(*) FROM keyword) AS keyword_rows,
        (SELECT COUNT(*) FROM crowd) AS crowd_rows,
        (SELECT MIN(date) FROM product_daily) AS product_date_min,
        (SELECT MAX(date) FROM product_daily) AS product_date_max,
        (SELECT MIN(date) FROM ad_item) AS ad_item_date_min,
        (SELECT MAX(date) FROM ad_item) AS ad_item_date_max,
        (SELECT MIN(date) FROM content) AS content_date_min,
        (SELECT MAX(date) FROM content) AS content_date_max,
        (SELECT MIN(date) FROM keyword) AS keyword_date_min,
        (SELECT MAX(date) FROM keyword) AS keyword_date_max,
        (SELECT MIN(date) FROM crowd) AS crowd_date_min,
        (SELECT MAX(date) FROM crowd) AS crowd_date_max`
    )
    .get();
  return totals || {};
}

export function listUploads(limit = 50) {
  const conn = ensureDb();
  return conn
    .prepare(`SELECT * FROM uploads ORDER BY id DESC LIMIT ?`)
    .all(limit);
}

export function queryProductHistory({ start, end, itemId }) {
  const conn = ensureDb();
  const where = ["1 = 1"];
  const params = {};
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }
  if (itemId) { where.push("item_id = @item_id"); params.item_id = itemId; }
  return conn
    .prepare(`SELECT date, item_id, item_name, payment, refund, visitors, ad_spend FROM product_daily WHERE ${where.join(" AND ")} ORDER BY date ASC, item_id ASC`)
    .all(params);
}

export function queryAdSummary({ start, end }) {
  const conn = ensureDb();
  const where = ["1 = 1"];
  const params = {};
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }
  // 全店推广花费：adItem + content 的"花费"按日合计
  return conn
    .prepare(
      `SELECT date,
              SUM(CASE WHEN tbl = 'ad_item' THEN spend ELSE 0 END) AS ad_item_spend,
              SUM(CASE WHEN tbl = 'content' THEN spend ELSE 0 END) AS content_spend,
              SUM(spend) AS total_spend,
              SUM(gmv) AS total_gmv,
              SUM(orders) AS total_orders
       FROM (
         SELECT date, spend, gmv, orders, 'ad_item' AS tbl FROM ad_item WHERE ${where.join(" AND ")}
         UNION ALL
         SELECT date, spend, gmv, orders, 'content' AS tbl FROM content WHERE ${where.join(" AND ")}
       )
       GROUP BY date ORDER BY date ASC`
    )
    .all(params);
}

// ---- P2.3 跨周期导出：把库里某段时间的 raw_json 直接 yield 出来 ----
// 还原成生参原始 csv 列（字段名 + 顺序由第一行决定）

const tableOrderBy = {
  product_daily: "date ASC, item_id ASC",
  ad_item: "date ASC, subject_id ASC, plan_id ASC",
  content: "date ASC, subject_id ASC, plan_id ASC",
  keyword: "date ASC, word_key ASC, plan_id ASC",
  crowd: "date ASC, crowd_key ASC, plan_id ASC"
};

// ---- P2.1 同比/环比：从 SQLite 拉指定区间的日聚合指标 ----

// view = "ad" 走 adItem+content 合并；"product" 走 product_daily 聚合
// metric 字段决定算什么；返回 [{date, value}]
export function querySeries({ view, metric, start, end }) {
  const conn = ensureDb();
  const where = ["date IS NOT NULL"];
  const params = {};
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }

  if (view === "ad") {
    // 全店推广：adItem+content union 后按日 sum
    let valueExpr;
    switch (metric) {
      case "spend": valueExpr = "SUM(spend)"; break;
      case "gmv": valueExpr = "SUM(gmv)"; break;
      case "roi": valueExpr = "CASE WHEN SUM(spend)=0 THEN NULL ELSE SUM(gmv)*1.0/SUM(spend) END"; break;
      case "clicks": valueExpr = "SUM(clicks)"; break;
      case "orders": valueExpr = "SUM(orders)"; break;
      default: valueExpr = "SUM(spend)";
    }
    return conn
      .prepare(
        `SELECT date, ${valueExpr} AS value FROM (
           SELECT date, spend, gmv, clicks, orders FROM ad_item WHERE ${where.join(" AND ")}
           UNION ALL
           SELECT date, spend, gmv, clicks, orders FROM content WHERE ${where.join(" AND ")}
         ) GROUP BY date ORDER BY date ASC`
      )
      .all(params);
  }

  // view = product
  // 部分指标涉及 ad spend / refund，需要 join 全店推广花费日聚合
  let select;
  switch (metric) {
    case "pay": select = "SUM(payment) AS value"; break;
    case "refund": select = "SUM(refund) AS value"; break;
    case "refundRatio": select = "CASE WHEN SUM(payment)=0 THEN NULL ELSE SUM(refund)*1.0/SUM(payment) END AS value"; break;
    case "visitors": select = "SUM(visitors) AS value"; break;
    case "netFeeRatio":
      // 分子 = 全店 ad spend；分母 = 全店净支付（pay - refund）
      // SQLite 子查询易读：先按日 join
      return conn
        .prepare(
          `SELECT p.date,
             CASE WHEN (p.pay - p.refund)=0 THEN NULL
                  ELSE a.spend*1.0 / (p.pay - p.refund) END AS value
           FROM (
             SELECT date, SUM(payment) AS pay, SUM(refund) AS refund
             FROM product_daily WHERE ${where.join(" AND ")} GROUP BY date
           ) p
           LEFT JOIN (
             SELECT date, SUM(spend) AS spend FROM (
               SELECT date, spend FROM ad_item WHERE ${where.join(" AND ")}
               UNION ALL
               SELECT date, spend FROM content WHERE ${where.join(" AND ")}
             ) GROUP BY date
           ) a ON a.date = p.date
           ORDER BY p.date ASC`
        )
        .all(params);
    default: select = "SUM(payment) AS value";
  }
  return conn
    .prepare(`SELECT date, ${select} FROM product_daily WHERE ${where.join(" AND ")} GROUP BY date ORDER BY date ASC`)
    .all(params);
}

// 计算对比段时间范围
export function computeCompareRange(start, end, preset) {
  if (!start || !end) return null;
  if (preset === "custom") return null;  // 调用方应该自己传 compareStart/compareEnd
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
  switch (preset) {
    case "WoW": {
      const offset = 7 * 86400 * 1000;
      return { start: toIso(startMs - offset), end: toIso(endMs - offset) };
    }
    case "MoM": {
      // 近似按 30 天往前
      const offset = 30 * 86400 * 1000;
      return { start: toIso(startMs - offset), end: toIso(endMs - offset) };
    }
    case "YoY": {
      const offset = 365 * 86400 * 1000;
      return { start: toIso(startMs - offset), end: toIso(endMs - offset) };
    }
    default:
      return null;
  }
}

export function* iterateTableRaw(table, { start, end }) {
  const conn = ensureDb();
  const where = ["raw_json IS NOT NULL"];
  const params = {};
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }
  const orderBy = tableOrderBy[table] || "date ASC";
  const stmt = conn.prepare(`SELECT raw_json FROM ${table} WHERE ${where.join(" AND ")} ORDER BY ${orderBy}`);
  for (const row of stmt.iterate(params)) {
    if (!row.raw_json) continue;
    try {
      yield JSON.parse(row.raw_json);
    } catch {
      // 损坏行跳过
    }
  }
}

// 不同表用的"日期"字段名不同，导出还原时需要
export const tableDateField = {
  product_daily: "统计日期",
  ad_item: "日期",
  content: "日期",
  keyword: "日期",
  crowd: "日期"
};

// 各表导出文件名（中文，跟生参导出习惯一致）
export const tableExportName = {
  product_daily: "店铺数据_商品维度.csv",
  ad_item: "店铺数据_推广商品报表.csv",
  content: "店铺数据_推广内容报表.csv",
  keyword: "店铺数据_推广关键词报表.csv",
  crowd: "店铺数据_推广人群报表.csv"
};

export function closeDb() {
  if (db) { db.close(); db = null; }
}
