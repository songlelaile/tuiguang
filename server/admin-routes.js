// /api/admin/* — 仅 admin 可访问;邀请码、用户列表管理

import express from "express";
import {
  createInvite,
  deleteInvite,
  listInvites,
  listUsers,
  updateUser
} from "./auth.js";

export function createAdminRouter(getDb) {
  const router = express.Router();

  // ---- 邀请码 ----

  router.get("/invites", (req, res) => {
    const db = getDb();
    res.json({ invites: listInvites(db) });
  });

  router.post("/invites", (req, res) => {
    const db = getDb();
    const { max_uses, expires_at, note } = req.body || {};
    const maxUses = Number.isInteger(max_uses) && max_uses > 0 ? max_uses : 1;
    const expiresAt = typeof expires_at === "string" && expires_at ? expires_at : null;
    const code = createInvite(db, {
      createdBy: req.user.id,
      maxUses,
      expiresAt,
      note: typeof note === "string" && note ? note : null
    });
    res.json({ code });
  });

  router.delete("/invites/:code", (req, res) => {
    const db = getDb();
    const ok = deleteInvite(db, req.params.code);
    if (!ok) return res.status(404).json({ error: "邀请码不存在" });
    res.json({ ok: true });
  });

  // ---- 用户 ----

  router.get("/users", (req, res) => {
    const db = getDb();
    res.json({ users: listUsers(db) });
  });

  router.patch("/users/:id", (req, res) => {
    const db = getDb();
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "无效的 user id" });
    }
    if (id === req.user.id) {
      // 不允许 admin 自己改自己角色/状态,避免锁死
      return res.status(400).json({ error: "不允许修改自己" });
    }
    const ok = updateUser(db, id, { status: req.body?.status, role: req.body?.role });
    if (!ok) return res.status(404).json({ error: "用户不存在或没有可改字段" });
    res.json({ ok: true });
  });

  return router;
}
