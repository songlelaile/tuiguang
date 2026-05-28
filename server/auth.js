// 认证与多租户基础设施
//
// 表设计:
//   users          — 账号 + bcrypt 密码 + 角色 + 状态
//   sessions       — 服务器侧 session,token = 32 字节随机十六进制(64 字符)
//   invite_codes   — 管理员生成,注册时核销
//
// 中间件:
//   requireAuth    — 从 cookie 解出 session,挂 req.user;无效返回 401
//   requireAdmin   — 必须 admin 角色,否则 403
//
// 启动钩子:
//   bootstrapAdmin — users 表空时从环境变量创建第一个 admin
//   migrateLegacyData — 把单租户时代留下来的业务数据 + 上传文件归属给 bootstrap admin

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";

const SESSION_COOKIE = "tg_session";
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS || 14);
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

// 邀请码字符集:去掉容易混淆的 0/O/1/I/l
const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const INVITE_LENGTH = 10;

// ---- schema ----

export function ensureUserTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'user')),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      created_at TEXT NOT NULL,
      last_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      code TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      expires_at TEXT,
      max_uses INTEGER NOT NULL DEFAULT 1,
      used_count INTEGER NOT NULL DEFAULT 0,
      note TEXT
    );

    CREATE TABLE IF NOT EXISTS sms_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      phone TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_sms_codes_phone ON sms_codes(phone);
    CREATE INDEX IF NOT EXISTS idx_sms_codes_expires ON sms_codes(expires_at);
  `);

  // P4.1 增量:users 加 phone 列(若不存在),并建 partial unique index 允许多个 NULL 但非 NULL 唯一
  const cols = db.prepare(`PRAGMA table_info(users)`).all();
  if (!cols.some((c) => c.name === "phone")) {
    db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
    console.log("[auth] users 表已新增 phone 列");
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL`);
}

// ---- 密码 ----

export function hashPassword(plain) {
  return bcrypt.hashSync(plain, BCRYPT_COST);
}

export function verifyPassword(plain, hash) {
  if (!hash) return false;
  try {
    return bcrypt.compareSync(plain, hash);
  } catch {
    return false;
  }
}

// ---- session ----

function randomToken() {
  return crypto.randomBytes(32).toString("hex");
}

export function createSession(db, userId) {
  const token = randomToken();
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_TTL_MS);
  db.prepare(
    `INSERT INTO sessions(token, user_id, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(token, userId, now.toISOString(), expires.toISOString(), now.toISOString());
  return { token, expiresAt: expires };
}

export function getSessionUser(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token, s.expires_at, s.user_id,
              u.id, u.username, u.email, u.phone, u.role, u.status
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token);
  if (!row) return null;
  if (row.status !== "active") return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
    return null;
  }
  // touch last_seen_at(轻量,不更新 expires_at,session 到期就是到期)
  const nowIso = new Date().toISOString();
  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`).run(nowIso, token);
  db.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`).run(nowIso, row.user_id);
  return { id: row.id, username: row.username, email: row.email, phone: row.phone, role: row.role, status: row.status };
}

export function destroySession(db, token) {
  if (!token) return;
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(token);
}

export function pruneExpiredSessions(db) {
  const now = new Date().toISOString();
  const result = db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(now);
  return result.changes;
}

// ---- cookie helpers ----

function isSecureRequest(req) {
  if (req.secure) return true;
  const xfp = req.headers["x-forwarded-proto"];
  if (typeof xfp === "string" && xfp.split(",")[0].trim() === "https") return true;
  return false;
}

export function setSessionCookie(req, res, token, expiresAt) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(req, res) {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export const SESSION_COOKIE_NAME = SESSION_COOKIE;

// ---- 中间件 ----

export function buildAuthMiddleware(getDb) {
  return function requireAuth(req, res, next) {
    const token = req.cookies?.[SESSION_COOKIE];
    const user = getSessionUser(getDb(), token);
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    req.user = user;
    next();
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  next();
}

// ---- 邀请码 ----

export function generateInviteCode() {
  const bytes = crypto.randomBytes(INVITE_LENGTH);
  let out = "";
  for (let i = 0; i < INVITE_LENGTH; i++) {
    out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  }
  return out;
}

export function createInvite(db, { createdBy, maxUses = 1, expiresAt = null, note = null }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateInviteCode();
    try {
      db.prepare(
        `INSERT INTO invite_codes(code, created_by, created_at, expires_at, max_uses, used_count, note)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
      ).run(code, createdBy, new Date().toISOString(), expiresAt, maxUses, note);
      return code;
    } catch (e) {
      if (!/UNIQUE/.test(e.message)) throw e;
      // 极小概率撞码,重试
    }
  }
  throw new Error("生成邀请码失败");
}

export function redeemInvite(db, code) {
  const row = db.prepare(`SELECT * FROM invite_codes WHERE code = ?`).get(code);
  if (!row) return { ok: false, reason: "邀请码不存在" };
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: "邀请码已过期" };
  }
  if (row.used_count >= row.max_uses) {
    return { ok: false, reason: "邀请码已用完" };
  }
  db.prepare(`UPDATE invite_codes SET used_count = used_count + 1 WHERE code = ?`).run(code);
  return { ok: true };
}

export function listInvites(db) {
  return db
    .prepare(
      `SELECT i.*, u.username AS created_by_username
       FROM invite_codes i
       LEFT JOIN users u ON u.id = i.created_by
       ORDER BY i.created_at DESC`
    )
    .all();
}

export function deleteInvite(db, code) {
  const result = db.prepare(`DELETE FROM invite_codes WHERE code = ?`).run(code);
  return result.changes > 0;
}

// ---- 用户 ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_一-龥][\w一-龥.-]{1,30}$/;
const PHONE_RE = /^1[3-9]\d{9}$/; // 中国大陆手机号

export function validateUsername(name) {
  if (typeof name !== "string") return "用户名必填";
  const trimmed = name.trim();
  if (!trimmed) return "用户名必填";
  if (!USERNAME_RE.test(trimmed)) return "用户名 2–31 位,可用字母数字下划线点中划线中文";
  return null;
}

export function validatePassword(pwd) {
  if (typeof pwd !== "string" || pwd.length < 8) return "密码至少 8 位";
  if (pwd.length > 200) return "密码过长";
  return null;
}

export function validateEmail(email) {
  if (email === undefined || email === null || email === "") return null;
  if (typeof email !== "string") return "邮箱格式不正确";
  if (!EMAIL_RE.test(email.trim())) return "邮箱格式不正确";
  return null;
}

export function validatePhone(phone) {
  if (typeof phone !== "string") return "请输入手机号";
  const trimmed = phone.trim();
  if (!trimmed) return "请输入手机号";
  if (!PHONE_RE.test(trimmed)) return "手机号格式不正确(11 位中国大陆号码)";
  return null;
}

export function createUser(db, { username, email, phone, password, role = "user" }) {
  // 至少有 password 或 phone 中一个(纯 SMS 用户没有密码,用随机不可登的 hash 占位)
  const hash = password ? hashPassword(password) : hashPassword(crypto.randomBytes(16).toString("hex"));
  const stmt = db.prepare(
    `INSERT INTO users(username, email, phone, password_hash, role, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'active', ?)`
  );
  const cleanPhone = phone && String(phone).trim() ? String(phone).trim() : null;
  const result = stmt.run(
    username.trim(),
    email && email.trim() ? email.trim() : null,
    cleanPhone,
    hash,
    role,
    new Date().toISOString()
  );
  return {
    id: Number(result.lastInsertRowid),
    username: username.trim(),
    email: email && email.trim() ? email.trim() : null,
    phone: cleanPhone,
    role,
    status: "active"
  };
}

export function getUserByPhone(db, phone) {
  if (!phone) return null;
  return db.prepare(`SELECT * FROM users WHERE phone = ?`).get(String(phone).trim());
}

// ---- SMS 验证码 ----
const SMS_TTL_MS = 10 * 60 * 1000;
const SMS_RESEND_COOLDOWN_MS = 60 * 1000;
const SMS_DAILY_LIMIT = 10;

export function checkSmsRateLimit(db, phone) {
  const lastSend = db
    .prepare(`SELECT created_at FROM sms_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`)
    .get(phone);
  if (lastSend) {
    const elapsed = Date.now() - new Date(lastSend.created_at).getTime();
    if (elapsed < SMS_RESEND_COOLDOWN_MS) {
      const remain = Math.ceil((SMS_RESEND_COOLDOWN_MS - elapsed) / 1000);
      return { ok: false, reason: `请 ${remain} 秒后再请求验证码` };
    }
  }
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const dailyCount = db
    .prepare(`SELECT COUNT(*) AS n FROM sms_codes WHERE phone = ? AND created_at >= ?`)
    .get(phone, startOfDay.toISOString());
  if (dailyCount.n >= SMS_DAILY_LIMIT) {
    return { ok: false, reason: "今日请求次数已达上限,请明天再试" };
  }
  return { ok: true };
}

export function generateSmsCode() {
  // 6 位数字,避开 000000 / 全相同
  let code;
  do {
    code = crypto.randomInt(100000, 1000000).toString();
  } while (/^(\d)\1{5}$/.test(code));
  return code;
}

export function recordSmsCode(db, phone, code) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SMS_TTL_MS);
  db.prepare(
    `INSERT INTO sms_codes(phone, code, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)`
  ).run(phone, code, expiresAt.toISOString(), now.toISOString());
}

export function verifySmsCode(db, phone, code) {
  if (!phone || !code) return { ok: false, reason: "请输入验证码" };
  // 找最新未用、未过期的;只允许验证最新那条以防绕过
  const row = db
    .prepare(
      `SELECT id, code, expires_at, used FROM sms_codes WHERE phone = ? ORDER BY id DESC LIMIT 1`
    )
    .get(phone);
  if (!row) return { ok: false, reason: "请先获取验证码" };
  if (row.used) return { ok: false, reason: "验证码已使用,请重新获取" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: "验证码已过期" };
  if (String(row.code) !== String(code).trim()) return { ok: false, reason: "验证码不正确" };
  db.prepare(`UPDATE sms_codes SET used = 1 WHERE id = ?`).run(row.id);
  return { ok: true };
}

// 给 SMS 自动注册用户起一个不冲突的用户名
export function generatePhoneUsername(db, phone) {
  const tail = String(phone).slice(-4);
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = attempt === 0 ? "" : `_${crypto.randomBytes(2).toString("hex")}`;
    const name = `u${tail}${suffix}`;
    const exists = db.prepare(`SELECT id FROM users WHERE username = ? COLLATE NOCASE`).get(name);
    if (!exists) return name;
  }
  // 极端情况:用随机 hex
  return `u_${crypto.randomBytes(4).toString("hex")}`;
}

export function getUserByUsername(db, username) {
  if (!username) return null;
  return db
    .prepare(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`)
    .get(username.trim());
}

export function getUserById(db, id) {
  return db.prepare(`SELECT id, username, email, role, status, created_at, last_seen_at FROM users WHERE id = ?`).get(id);
}

export function listUsers(db) {
  return db
    .prepare(
      `SELECT id, username, email, role, status, created_at, last_seen_at
       FROM users ORDER BY id ASC`
    )
    .all();
}

export function updateUser(db, id, { status, role }) {
  const sets = [];
  const params = [];
  if (status && ["active", "disabled"].includes(status)) {
    sets.push("status = ?");
    params.push(status);
  }
  if (role && ["admin", "user"].includes(role)) {
    sets.push("role = ?");
    params.push(role);
  }
  if (!sets.length) return false;
  params.push(id);
  const result = db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return result.changes > 0;
}

// ---- bootstrap ----

export function bootstrapAdmin(db) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM users`).get();
  if (row.n > 0) return null;

  const username = process.env.ADMIN_BOOTSTRAP_USERNAME;
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!username || !password) {
    console.warn(
      "[auth] users 表为空。请设置 ADMIN_BOOTSTRAP_USERNAME 和 ADMIN_BOOTSTRAP_PASSWORD 环境变量,然后重启,以创建首个管理员。"
    );
    return null;
  }

  const usernameErr = validateUsername(username);
  if (usernameErr) {
    console.error(`[auth] ADMIN_BOOTSTRAP_USERNAME 不合法: ${usernameErr}`);
    return null;
  }
  const passwordErr = validatePassword(password);
  if (passwordErr) {
    console.error(`[auth] ADMIN_BOOTSTRAP_PASSWORD 不合法: ${passwordErr}`);
    return null;
  }

  const user = createUser(db, { username, password, role: "admin" });
  console.log(`[auth] 已创建首个管理员: ${user.username} (id=${user.id})`);
  console.log("[auth] 安全起见,请在确认登录成功后,从环境变量里把 ADMIN_BOOTSTRAP_PASSWORD 清掉。");
  return user;
}

// ---- 历史数据迁移 ----
//
// 旧版业务表没有 user_id;升级到新 schema 时,如果检测到旧版且 users 表非空,
// 把所有旧行归到指定 adminId,同时迁移裸 uploads 文件到 per-user 子目录。
//
// 注意:本函数应该在 ensureUserTables + bootstrapAdmin 之后、initBusinessSchema 之前调用。

export function hasLegacyUploadsTable(db) {
  const cols = db.prepare(`PRAGMA table_info(uploads)`).all();
  if (!cols.length) return false; // 表不存在,新装
  return !cols.some((c) => c.name === "user_id");
}

export function migrateLegacyBusinessTables(db, adminId) {
  // 6 张业务表,每张:rename 旧表为 _old,创建新表(带 user_id),把数据搬过去,drop 旧表
  // PK 改为 (user_id, ...),所有旧行 user_id = adminId
  const migrations = [
    {
      name: "uploads",
      // uploads 主键是自增 id,只加 user_id 列
      createNew: `CREATE TABLE uploads_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        uploaded_at TEXT NOT NULL,
        product_rows INTEGER, ad_item_rows INTEGER, content_rows INTEGER,
        keyword_rows INTEGER, crowd_rows INTEGER,
        date_min TEXT, date_max TEXT,
        note TEXT
      )`,
      copy: `INSERT INTO uploads_new
        (id, user_id, uploaded_at, product_rows, ad_item_rows, content_rows, keyword_rows, crowd_rows, date_min, date_max, note)
        SELECT id, ?, uploaded_at, product_rows, ad_item_rows, content_rows, keyword_rows, crowd_rows, date_min, date_max, note FROM uploads`,
      indexes: [`CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id)`]
    },
    {
      name: "product_daily",
      createNew: `CREATE TABLE product_daily_new (
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
      ) WITHOUT ROWID`,
      copy: `INSERT INTO product_daily_new
        (user_id, date, item_id, item_name, payment, refund, visitors, page_views, pay_buyers, repeat_buyers, repeat_payment, cart_buyers, ad_spend, annual_pay, raw_json, upload_id, last_updated_at)
        SELECT ?, date, item_id, item_name, payment, refund, visitors, page_views, pay_buyers, repeat_buyers, repeat_payment, cart_buyers, ad_spend, annual_pay, raw_json, upload_id, last_updated_at FROM product_daily`,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_product_daily_date  ON product_daily(date)`,
        `CREATE INDEX IF NOT EXISTS idx_product_daily_item  ON product_daily(item_id)`,
        `CREATE INDEX IF NOT EXISTS idx_product_daily_user  ON product_daily(user_id)`
      ]
    },
    {
      name: "ad_item",
      createNew: `CREATE TABLE ad_item_new (
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
      ) WITHOUT ROWID`,
      copy: `INSERT INTO ad_item_new
        (user_id, date, subject_id, plan_id, subject_name, subject_type, plan_name, scene_id, scene_name, spend, gmv, impressions, clicks, orders, cart_count, raw_json, upload_id, last_updated_at)
        SELECT ?, date, subject_id, plan_id, subject_name, subject_type, plan_name, scene_id, scene_name, spend, gmv, impressions, clicks, orders, cart_count, raw_json, upload_id, last_updated_at FROM ad_item`,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_ad_item_date    ON ad_item(date)`,
        `CREATE INDEX IF NOT EXISTS idx_ad_item_subject ON ad_item(subject_id)`,
        `CREATE INDEX IF NOT EXISTS idx_ad_item_user    ON ad_item(user_id)`
      ]
    },
    {
      name: "content",
      createNew: `CREATE TABLE content_new (
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
      ) WITHOUT ROWID`,
      copy: `INSERT INTO content_new
        (user_id, date, subject_id, plan_id, subject_name, subject_type, plan_name, scene_id, scene_name, spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at)
        SELECT ?, date, subject_id, plan_id, subject_name, subject_type, plan_name, scene_id, scene_name, spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at FROM content`,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_content_date    ON content(date)`,
        `CREATE INDEX IF NOT EXISTS idx_content_subject ON content(subject_id)`,
        `CREATE INDEX IF NOT EXISTS idx_content_user    ON content(user_id)`
      ]
    },
    {
      name: "keyword",
      createNew: `CREATE TABLE keyword_new (
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
      ) WITHOUT ROWID`,
      copy: `INSERT INTO keyword_new
        (user_id, date, word_key, plan_id, word_type, word_name, item_id, plan_name, scene_name, spend, gmv, impressions, clicks, orders, avg_rank, raw_json, upload_id, last_updated_at)
        SELECT ?, date, word_key, plan_id, word_type, word_name, item_id, plan_name, scene_name, spend, gmv, impressions, clicks, orders, avg_rank, raw_json, upload_id, last_updated_at FROM keyword`,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_keyword_date ON keyword(date)`,
        `CREATE INDEX IF NOT EXISTS idx_keyword_word ON keyword(word_name)`,
        `CREATE INDEX IF NOT EXISTS idx_keyword_user ON keyword(user_id)`
      ]
    },
    {
      name: "crowd",
      createNew: `CREATE TABLE crowd_new (
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
      ) WITHOUT ROWID`,
      copy: `INSERT INTO crowd_new
        (user_id, date, crowd_key, plan_id, crowd_name, unit_name, subject_name, scene_name, spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at)
        SELECT ?, date, crowd_key, plan_id, crowd_name, unit_name, subject_name, scene_name, spend, gmv, impressions, clicks, orders, raw_json, upload_id, last_updated_at FROM crowd`,
      indexes: [
        `CREATE INDEX IF NOT EXISTS idx_crowd_date ON crowd(date)`,
        `CREATE INDEX IF NOT EXISTS idx_crowd_name ON crowd(crowd_name)`,
        `CREATE INDEX IF NOT EXISTS idx_crowd_user ON crowd(user_id)`
      ]
    }
  ];

  const txn = db.transaction(() => {
    for (const m of migrations) {
      const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`).get(m.name);
      if (!exists) continue;
      db.exec(m.createNew);
      db.prepare(m.copy).run(adminId);
      db.exec(`DROP TABLE ${m.name}`);
      db.exec(`ALTER TABLE ${m.name}_new RENAME TO ${m.name}`);
      for (const idx of m.indexes) db.exec(idx);
    }
  });
  txn();

  console.log(`[migration] 旧业务表已迁移,所有历史数据归属 user_id=${adminId}`);
}

export function migrateLegacyUploadFiles(rootUploadDir, adminId) {
  // 把 rootUploadDir 下的裸文件(不在数字子目录里)移到 rootUploadDir/{adminId}/
  if (!fs.existsSync(rootUploadDir)) return;
  const targetDir = path.join(rootUploadDir, String(adminId));
  let moved = 0;
  const entries = fs.readdirSync(rootUploadDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && !entry.name.startsWith(".")) {
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(path.join(rootUploadDir, entry.name), path.join(targetDir, entry.name));
      moved++;
    }
  }
  if (moved > 0) {
    console.log(`[migration] 已把 ${moved} 个旧上传文件移到 ${targetDir}`);
  }
}
