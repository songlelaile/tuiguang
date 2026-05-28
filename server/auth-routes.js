// /api/auth/* — 注册 / 登录 / 登出 / 当前用户

import express from "express";
import {
  SESSION_COOKIE_NAME,
  checkSmsRateLimit,
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  generatePhoneUsername,
  generateSmsCode,
  getUserByPhone,
  getUserByUsername,
  recordSmsCode,
  redeemInvite,
  setSessionCookie,
  validateEmail,
  validatePassword,
  validatePhone,
  validateUsername,
  verifyPassword,
  verifySmsCode
} from "./auth.js";
import { issueCaptcha, verifyCaptcha } from "./captcha.js";
import { activeProvider, sendSms } from "./sms.js";

// 功能开关:env "false" 关闭,缺省/其它值为开
// AUTH_OPEN_REGISTRATION=false → 必须邀请码才能注册
// AUTH_SMS_LOGIN=false         → 隐藏手机短信入口,/api/auth/sms/* 返回 404
function isOpenRegistrationEnabled() {
  return process.env.AUTH_OPEN_REGISTRATION !== "false";
}
function isSmsLoginEnabled() {
  return process.env.AUTH_SMS_LOGIN !== "false";
}

export function createAuthRouter(getDb) {
  const router = express.Router();

  // GET /api/auth/features — 前端用此决定哪些 UI 显示;无需登录
  router.get("/features", (_req, res) => {
    res.json({
      open_registration: isOpenRegistrationEnabled(),
      sms_login: isSmsLoginEnabled(),
      sms_provider: activeProvider()
    });
  });

  // GET /api/auth/captcha — 取一道算术题,前端把答案 + id 回带
  router.get("/captcha", (_req, res) => {
    if (!isOpenRegistrationEnabled()) {
      return res.status(403).json({ error: "开放注册当前未启用" });
    }
    res.json(issueCaptcha());
  });

  router.post("/register", (req, res) => {
    const db = getDb();
    const { username, password, email, invite_code, captcha_id, captcha_answer } = req.body || {};

    const usernameErr = validateUsername(username);
    if (usernameErr) return res.status(400).json({ error: usernameErr });
    const passwordErr = validatePassword(password);
    if (passwordErr) return res.status(400).json({ error: passwordErr });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });

    const usingInvite = typeof invite_code === "string" && invite_code.trim().length > 0;

    if (!usingInvite) {
      if (!isOpenRegistrationEnabled()) {
        return res.status(403).json({ error: "当前为邀请注册模式,请填写邀请码" });
      }
      if (!verifyCaptcha(captcha_id, captcha_answer)) {
        return res.status(400).json({ error: "验证码不正确或已过期,请刷新重试" });
      }
    }

    if (getUserByUsername(db, username)) {
      return res.status(409).json({ error: "用户名已被使用" });
    }
    if (email && email.trim()) {
      const existingByEmail = db
        .prepare(`SELECT id FROM users WHERE email = ? COLLATE NOCASE`)
        .get(email.trim());
      if (existingByEmail) return res.status(409).json({ error: "邮箱已被使用" });
    }

    let user;
    try {
      const txn = db.transaction(() => {
        if (usingInvite) {
          const redeem = redeemInvite(db, invite_code.trim());
          if (!redeem.ok) throw new Error(`INVITE:${redeem.reason}`);
        }
        return createUser(db, { username, email, password, role: "user" });
      });
      user = txn();
    } catch (e) {
      if (typeof e.message === "string" && e.message.startsWith("INVITE:")) {
        return res.status(400).json({ error: e.message.slice("INVITE:".length) });
      }
      throw e;
    }

    const session = createSession(db, user.id);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({ user });
  });

  router.post("/login", (req, res) => {
    const db = getDb();
    const { username, password } = req.body || {};
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "请输入用户名和密码" });
    }
    const user = getUserByUsername(db, username);
    // 用相同的话术,不暴露用户存在与否
    const fail = () => res.status(401).json({ error: "用户名或密码错误" });
    if (!user) return fail();
    if (user.status !== "active") return res.status(403).json({ error: "账号已被禁用" });
    if (!verifyPassword(password, user.password_hash)) return fail();
    const session = createSession(db, user.id);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({
      user: { id: user.id, username: user.username, email: user.email, role: user.role, status: user.status }
    });
  });

  router.post("/logout", (req, res) => {
    const db = getDb();
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    destroySession(db, token);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // ---- P4.1 手机号 + SMS 登录 ----

  router.post("/sms/send", async (req, res, next) => {
    if (!isSmsLoginEnabled()) return res.status(404).json({ error: "短信登录暂未启用" });
    const db = getDb();
    const { phone } = req.body || {};
    const phoneErr = validatePhone(phone);
    if (phoneErr) return res.status(400).json({ error: phoneErr });
    const trimmedPhone = phone.trim();

    const rate = checkSmsRateLimit(db, trimmedPhone);
    if (!rate.ok) return res.status(429).json({ error: rate.reason });

    const code = generateSmsCode();
    recordSmsCode(db, trimmedPhone, code);
    try {
      await sendSms({ phone: trimmedPhone, code });
    } catch (e) {
      console.error("[sms] send failed:", e.message);
      return res.status(502).json({ error: `验证码发送失败:${e.message}` });
    }
    // dev provider 把 code 也返回(便于本地测试),生产 provider 永远不返回 code
    const provider = activeProvider();
    res.json({ ok: true, provider, ...(provider === "dev" ? { devCode: code } : {}) });
  });

  router.post("/sms/login", (req, res) => {
    if (!isSmsLoginEnabled()) return res.status(404).json({ error: "短信登录暂未启用" });
    const db = getDb();
    const { phone, code } = req.body || {};
    const phoneErr = validatePhone(phone);
    if (phoneErr) return res.status(400).json({ error: phoneErr });
    const trimmedPhone = phone.trim();

    const verify = verifySmsCode(db, trimmedPhone, code);
    if (!verify.ok) return res.status(400).json({ error: verify.reason });

    let user = getUserByPhone(db, trimmedPhone);
    if (!user) {
      // 自动注册:用户名 = "u<phone-tail4>";SMS-only 用户没有密码,createUser 写随机不可登 hash
      const username = generatePhoneUsername(db, trimmedPhone);
      const created = createUser(db, { username, phone: trimmedPhone, password: null, role: "user" });
      user = { ...created, password_hash: null };
    } else if (user.status !== "active") {
      return res.status(403).json({ error: "账号已被禁用" });
    }

    const session = createSession(db, user.id);
    setSessionCookie(req, res, session.token, session.expiresAt);
    res.json({
      user: { id: user.id, username: user.username, email: user.email, phone: user.phone, role: user.role, status: user.status }
    });
  });

  // 注意:GET /me 不在这里挂,因为它需要 requireAuth 中间件;
  // 由 server/index.js 在 app.use("/api/auth", router) 之后单独注册

  return router;
}
