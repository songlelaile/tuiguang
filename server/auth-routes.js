// /api/auth/* — 注册 / 登录 / 登出 / 当前用户

import express from "express";
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  getUserByUsername,
  redeemInvite,
  setSessionCookie,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyPassword
} from "./auth.js";

export function createAuthRouter(getDb) {
  const router = express.Router();

  router.post("/register", (req, res) => {
    const db = getDb();
    const { username, password, email, invite_code } = req.body || {};

    const usernameErr = validateUsername(username);
    if (usernameErr) return res.status(400).json({ error: usernameErr });
    const passwordErr = validatePassword(password);
    if (passwordErr) return res.status(400).json({ error: passwordErr });
    const emailErr = validateEmail(email);
    if (emailErr) return res.status(400).json({ error: emailErr });
    if (typeof invite_code !== "string" || !invite_code.trim()) {
      return res.status(400).json({ error: "请输入邀请码" });
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
      // 用事务把"核销邀请码"和"建用户"做原子,失败一起回滚
      const txn = db.transaction(() => {
        const redeem = redeemInvite(db, invite_code.trim());
        if (!redeem.ok) throw new Error(`INVITE:${redeem.reason}`);
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

  // 注意:GET /me 不在这里挂,因为它需要 requireAuth 中间件;
  // 由 server/index.js 在 app.use("/api/auth", router) 之后单独注册

  return router;
}
