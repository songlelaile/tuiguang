// P1 — 长期存储模块（SQLite 双写） + 多租户改造
//
// 设计原则:
//   - 6 张业务表都带 user_id;主键 (user_id, 业务键);所有读取都按 user_id 过滤
//   - 与 server/auth.js 共用同一个 db 文件 + 同一处连接
//   - ensureDb 第一次调用时:确保 auth 表 → bootstrap admin(若 users 空) → 检测旧 schema → 迁移 → 建业务表
//
// 写入失败仍然不应让上传失败(调用方包 try/catch + log)。

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import {
  ensureUserTables,
  bootstrapAdmin,
  hasLegacyUploadsTable,
  migrateLegacyBusinessTables
} from "./auth.js";

const HISTORY_DB_PATH = process.env.HUOPAN_HISTORY_DB || path.resolve(process.cwd(), "data", "history.sqlite");

let db = null;
let legacyMigratedAdminId = null; // 暴露给外部以触发文件系统迁移

function ensureDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(HISTORY_DB_PATH), { recursive: true });
  db = new Database(HISTORY_DB_PATH);

  // P4.5 SQLite 性能调优 —— 适合"读多写多、单进程"的 BI 场景
  db.pragma("journal_mode = WAL");          // 已有:并发读 + 写,不阻塞
  db.pragma("synchronous = NORMAL");        // 已有:WAL 下 NORMAL 已经够安全
  db.pragma("foreign_keys = ON");           // 已有:约束完整性
  // ↓ 新增:
  db.pragma("cache_size = -65536");         // 内存 page cache 上限 64MB(负数 = KB);默认 2MB 不够 25K+ 行业务表
  db.pragma("mmap_size = 268435456");       // 内存映射 256MB,大表读省一次 memcpy
  db.pragma("temp_store = MEMORY");         // 临时表 / index 放内存,避免磁盘 IO
  db.pragma("busy_timeout = 5000");         // 锁冲突时等 5s,不立即报 SQLITE_BUSY
  db.pragma("wal_autocheckpoint = 1000");   // 每 1000 page 自动 checkpoint,防 WAL 无限增长
  db.pragma("auto_vacuum = INCREMENTAL");   // P4.14 增量回收空闲页(需一次全量 VACUUM 转换后生效,见 runHistoryMaintenance)

  ensureUserTables(db);
  bootstrapAdmin(db);

  if (hasLegacyUploadsTable(db)) {
    const admin = db
      .prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`)
      .get();
    if (!admin) {
      throw new Error(
        "检测到旧版业务数据(uploads 表无 user_id 列),但 users 表为空。请设置 ADMIN_BOOTSTRAP_USERNAME 和 ADMIN_BOOTSTRAP_PASSWORD 环境变量后重启,以将旧数据归属到首个管理员。"
      );
    }
    migrateLegacyBusinessTables(db, admin.id);
    legacyMigratedAdminId = admin.id;
  }

  initBusinessSchema(db);
  return db;
}

export function getLegacyMigratedAdminId() {
  ensureDb();
  return legacyMigratedAdminId;
}

// 显式触发 DB 初始化(auth 表 + bootstrap admin + 老数据迁移 + 业务 schema)
// 应该在 app.listen 之前调用一次,确保第一个请求来时数据库已就绪
export function initDatabase() {
  return ensureDb();
}

// 给 auth 中间件 / 路由共用同一个连接,避免双 handle 写同一个 SQLite 文件
export function getDbHandle() {
  return ensureDb();
}

export function getFirstAdminId() {
  const conn = ensureDb();
  const row = conn.prepare(`SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1`).get();
  return row ? row.id : null;
}

function initBusinessSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at TEXT NOT NULL,
      product_rows INTEGER, ad_item_rows INTEGER, content_rows INTEGER,
      keyword_rows INTEGER, crowd_rows INTEGER,
      date_min TEXT, date_max TEXT,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS product_daily (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      item_id TEXT NOT NULL,
      item_name TEXT,
      payment REAL, refund REAL, visitors INTEGER, page_views INTEGER,
      pay_buyers INTEGER, repeat_buyers INTEGER, repeat_payment REAL,
      cart_buyers INTEGER, ad_spend REAL, annual_pay REAL,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, item_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS ad_item (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      subject_name TEXT, subject_type TEXT, plan_name TEXT,
      scene_id TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER, cart_count INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, subject_id, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS content (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      subject_name TEXT, subject_type TEXT, plan_name TEXT,
      scene_id TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, subject_id, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS keyword (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      word_key TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      word_type TEXT, word_name TEXT, item_id TEXT, plan_name TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER, avg_rank REAL,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, word_key, plan_id)
    ) WITHOUT ROWID;

    CREATE TABLE IF NOT EXISTS crowd (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date TEXT NOT NULL,
      crowd_key TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      crowd_name TEXT, unit_name TEXT, subject_name TEXT, scene_name TEXT,
      spend REAL, gmv REAL, impressions INTEGER, clicks INTEGER, orders INTEGER,
      raw_json TEXT,
      upload_id INTEGER NOT NULL,
      last_updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, date, crowd_key, plan_id)
    ) WITHOUT ROWID;

    CREATE INDEX IF NOT EXISTS idx_uploads_user        ON uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_product_daily_date  ON product_daily(date);
    CREATE INDEX IF NOT EXISTS idx_product_daily_item  ON product_daily(item_id);
    CREATE INDEX IF NOT EXISTS idx_product_daily_user  ON product_daily(user_id);
    CREATE INDEX IF NOT EXISTS idx_ad_item_date        ON ad_item(date);
    CREATE INDEX IF NOT EXISTS idx_ad_item_subject     ON ad_item(subject_id);
    CREATE INDEX IF NOT EXISTS idx_ad_item_user        ON ad_item(user_id);
    CREATE INDEX IF NOT EXISTS idx_content_date        ON content(date);
    CREATE INDEX IF NOT EXISTS idx_content_subject     ON content(subject_id);
    CREATE INDEX IF NOT EXISTS idx_content_user        ON content(user_id);
    CREATE INDEX IF NOT EXISTS idx_keyword_date        ON keyword(date);
    CREATE INDEX IF NOT EXISTS idx_keyword_word        ON keyword(word_name);
    CREATE INDEX IF NOT EXISTS idx_keyword_user        ON keyword(user_id);
    CREATE INDEX IF NOT EXISTS idx_crowd_date          ON crowd(date);
    CREATE INDEX IF NOT EXISTS idx_crowd_name          ON crowd(crowd_name);
    CREATE INDEX IF NOT EXISTS idx_crowd_user          ON crowd(user_id);
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

function requireUserId(userId) {
  if (typeof userId !== "number" || !Number.isInteger(userId) || userId <= 0) {
    throw new Error(`history: 缺失 userId(收到 ${userId})`);
  }
  return userId;
}

// ---- 公共入口 ----

export function ingestUpload({ userId, product = [], adItem = [], content = [], keyword = [], crowd = [], note = "", keepHistory = true }) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const uploadedAt = new Date().toISOString();

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
    // P4.14 覆盖式留存:非 admin(keepHistory=false)上传前先清掉该用户的全部旧历史,
    // 只保留本次最新一份 → 普通用户不再往历史库累积,磁盘可控。
    if (!keepHistory) {
      for (const t of ["product_daily", "ad_item", "content", "keyword", "crowd", "uploads"]) {
        conn.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(uid);
      }
    }
    const upload = conn
      .prepare(
        `INSERT INTO uploads(user_id, uploaded_at, product_rows, ad_item_rows, content_rows, keyword_rows, crowd_rows, date_min, date_max, note)
         VALUES (@user_id, @uploaded_at, @product_rows, @ad_item_rows, @content_rows, @keyword_rows, @crowd_rows, @date_min, @date_max, @note)`
      )
      .run({
        user_id: uid,
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

    ingestProduct(conn, uid, product, uploadId, uploadedAt);
    ingestAdItem(conn, uid, adItem, uploadId, uploadedAt);
    ingestContent(conn, uid, content, uploadId, uploadedAt);
    ingestKeyword(conn, uid, keyword, uploadId, uploadedAt);
    ingestCrowd(conn, uid, crowd, uploadId, uploadedAt);

    return uploadId;
  });

  return { uploadId: Number(txn()), dateMin, dateMax };
}

function ingestProduct(conn, userId, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO product_daily(user_id, date, item_id, item_name, payment, refund, visitors, page_views,
      pay_buyers, repeat_buyers, repeat_payment, cart_buyers, ad_spend, annual_pay,
      raw_json, upload_id, last_updated_at)
    VALUES (@user_id, @date, @item_id, @item_name, @payment, @refund, @visitors, @page_views,
      @pay_buyers, @repeat_buyers, @repeat_payment, @cart_buyers, @ad_spend, @annual_pay,
      @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(user_id, date, item_id) DO UPDATE SET
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
      user_id: userId,
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

function ingestAdLike(conn, userId, table, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO ${table}(user_id, date, subject_id, plan_id, subject_name, subject_type, plan_name,
      scene_id, scene_name, spend, gmv, impressions, clicks, orders${table === "ad_item" ? ", cart_count" : ""},
      raw_json, upload_id, last_updated_at)
    VALUES (@user_id, @date, @subject_id, @plan_id, @subject_name, @subject_type, @plan_name,
      @scene_id, @scene_name, @spend, @gmv, @impressions, @clicks, @orders${table === "ad_item" ? ", @cart_count" : ""},
      @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(user_id, date, subject_id, plan_id) DO UPDATE SET
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
      user_id: userId,
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

function ingestAdItem(conn, userId, rows, uploadId, ts) { ingestAdLike(conn, userId, "ad_item", rows, uploadId, ts); }
function ingestContent(conn, userId, rows, uploadId, ts) { ingestAdLike(conn, userId, "content", rows, uploadId, ts); }

function ingestKeyword(conn, userId, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO keyword(user_id, date, word_key, plan_id, word_type, word_name, item_id, plan_name, scene_name,
      spend, gmv, impressions, clicks, orders, avg_rank, raw_json, upload_id, last_updated_at)
    VALUES (@user_id, @date, @word_key, @plan_id, @word_type, @word_name, @item_id, @plan_name, @scene_name,
      @spend, @gmv, @impressions, @clicks, @orders, @avg_rank, @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(user_id, date, word_key, plan_id) DO UPDATE SET
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
    const itemKey = str(row["宝贝名称"]) || str(row["宝贝ID"]) || str(row["商品ID"]) || "";
    stmt.run({
      user_id: userId,
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

function ingestCrowd(conn, userId, rows, uploadId, uploadedAt) {
  if (!rows.length) return;
  const stmt = conn.prepare(`
    INSERT INTO crowd(user_id, date, crowd_key, plan_id, crowd_name, unit_name, subject_name, scene_name,
      spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at)
    VALUES (@user_id, @date, @crowd_key, @plan_id, @crowd_name, @unit_name, @subject_name, @scene_name,
      @spend, @gmv, @impressions, @clicks, @orders, @raw_json, @upload_id, @last_updated_at)
    ON CONFLICT(user_id, date, crowd_key, plan_id) DO UPDATE SET
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
      user_id: userId,
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

// ---- 查询(全部按 userId 过滤) ----

export function getCoverage(userId) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const totals = conn
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM uploads        WHERE user_id = @uid) AS uploads,
        (SELECT COUNT(*) FROM product_daily  WHERE user_id = @uid) AS product_rows,
        (SELECT COUNT(*) FROM ad_item        WHERE user_id = @uid) AS ad_item_rows,
        (SELECT COUNT(*) FROM content        WHERE user_id = @uid) AS content_rows,
        (SELECT COUNT(*) FROM keyword        WHERE user_id = @uid) AS keyword_rows,
        (SELECT COUNT(*) FROM crowd          WHERE user_id = @uid) AS crowd_rows,
        (SELECT MIN(date) FROM product_daily WHERE user_id = @uid) AS product_date_min,
        (SELECT MAX(date) FROM product_daily WHERE user_id = @uid) AS product_date_max,
        (SELECT MIN(date) FROM ad_item       WHERE user_id = @uid) AS ad_item_date_min,
        (SELECT MAX(date) FROM ad_item       WHERE user_id = @uid) AS ad_item_date_max,
        (SELECT MIN(date) FROM content       WHERE user_id = @uid) AS content_date_min,
        (SELECT MAX(date) FROM content       WHERE user_id = @uid) AS content_date_max,
        (SELECT MIN(date) FROM keyword       WHERE user_id = @uid) AS keyword_date_min,
        (SELECT MAX(date) FROM keyword       WHERE user_id = @uid) AS keyword_date_max,
        (SELECT MIN(date) FROM crowd         WHERE user_id = @uid) AS crowd_date_min,
        (SELECT MAX(date) FROM crowd         WHERE user_id = @uid) AS crowd_date_max`
    )
    .get({ uid });
  return totals || {};
}

export function listUploads(userId, limit = 50) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  return conn
    .prepare(`SELECT * FROM uploads WHERE user_id = ? ORDER BY id DESC LIMIT ?`)
    .all(uid, limit);
}

export function queryProductHistory({ userId, start, end, itemId }) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const where = ["user_id = @uid"];
  const params = { uid };
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }
  if (itemId) { where.push("item_id = @item_id"); params.item_id = itemId; }
  return conn
    .prepare(`SELECT date, item_id, item_name, payment, refund, visitors, ad_spend FROM product_daily WHERE ${where.join(" AND ")} ORDER BY date ASC, item_id ASC`)
    .all(params);
}

export function queryAdSummary({ userId, start, end }) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const where = ["user_id = @uid"];
  const params = { uid };
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }
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

// ---- P2.3 跨周期导出 ----

const tableOrderBy = {
  product_daily: "date ASC, item_id ASC",
  ad_item: "date ASC, subject_id ASC, plan_id ASC",
  content: "date ASC, subject_id ASC, plan_id ASC",
  keyword: "date ASC, word_key ASC, plan_id ASC",
  crowd: "date ASC, crowd_key ASC, plan_id ASC"
};

// ---- P2.1 同比/环比 ----

export function querySeries({ userId, view, metric, start, end }) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const where = ["user_id = @uid", "date IS NOT NULL"];
  const params = { uid };
  if (start) { where.push("date >= @start"); params.start = start; }
  if (end) { where.push("date <= @end"); params.end = end; }

  if (view === "ad") {
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

  let select;
  switch (metric) {
    case "pay": select = "SUM(payment) AS value"; break;
    case "refund": select = "SUM(refund) AS value"; break;
    case "refundRatio": select = "CASE WHEN SUM(payment)=0 THEN NULL ELSE SUM(refund)*1.0/SUM(payment) END AS value"; break;
    case "visitors": select = "SUM(visitors) AS value"; break;
    case "netFeeRatio":
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

export function computeCompareRange(start, end, preset) {
  if (!start || !end) return null;
  if (preset === "custom") return null;
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

export function* iterateTableRaw(userId, table, { start, end }) {
  const conn = ensureDb();
  const uid = requireUserId(userId);
  const where = ["user_id = @uid", "raw_json IS NOT NULL"];
  const params = { uid };
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

export const tableDateField = {
  product_daily: "统计日期",
  ad_item: "日期",
  content: "日期",
  keyword: "日期",
  crowd: "日期"
};

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

// ============ P4.14 历史库留存 + 自动维护 ============

// N 个月前的日期(YYYY-MM-DD),用于按 last_updated_at 裁剪
function monthsAgoIso(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

// 留存清理:删除"最近 N 个月没再被上传刷新过"的历史行。
// 用 last_updated_at 作判据 → admin 累积的老数据会被清;普通用户每次覆盖式上传
// last_updated_at 都是最新,不会被误删。months<=0 表示永久保留(不清)。
const HISTORY_TABLES = ["product_daily", "ad_item", "content", "keyword", "crowd"];
export function pruneOldHistory(months) {
  if (!months || months <= 0) return 0;
  const conn = ensureDb();
  const cutoff = monthsAgoIso(months);
  let removed = 0;
  const txn = conn.transaction(() => {
    for (const t of HISTORY_TABLES) {
      removed += conn.prepare(`DELETE FROM ${t} WHERE last_updated_at < ?`).run(cutoff).changes;
    }
    // 清掉没有任何数据行引用的空 uploads 记录
    conn.prepare(
      `DELETE FROM uploads WHERE id NOT IN (
         SELECT upload_id FROM product_daily UNION SELECT upload_id FROM ad_item
         UNION SELECT upload_id FROM content UNION SELECT upload_id FROM keyword
         UNION SELECT upload_id FROM crowd)`
    ).run();
  });
  txn();
  return removed;
}

// 自动维护:留存清理 + WAL 回收 + 空间回收。建议启动后跑一次 + 每天跑。
//   - 首次(库还不是 incremental auto_vacuum 模式):跑一次全量 VACUUM 完成转换 + 压实历史膨胀;
//   - 之后:incremental_vacuum 增量回收,便宜、不阻塞太久。
export function runHistoryMaintenance(retentionMonths = 0) {
  const conn = ensureDb();
  try {
    const pruned = pruneOldHistory(retentionMonths);
    if (pruned > 0) console.log(`[history] 留存清理:删除 ${pruned} 行(>${retentionMonths} 个月未刷新)`);
    conn.pragma("wal_checkpoint(TRUNCATE)");
    const mode = conn.pragma("auto_vacuum", { simple: true });
    if (mode !== 2) {
      const t0 = Date.now();
      conn.exec("VACUUM"); // 一次性:转 incremental 模式 + 压实历史膨胀
      console.log(`[history] 已 VACUUM(转 incremental + 压实),耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } else {
      conn.pragma("incremental_vacuum");
    }
  } catch (e) {
    console.error("[history] 维护失败:", e.message);
  }
}
