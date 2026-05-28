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

export function closeDb() {
  if (db) { db.close(); db = null; }
}
