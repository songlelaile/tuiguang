// /api/admin/* — 仅 admin 可访问;邀请码、用户列表管理

import express from "express";
import {
  createInvite,
  deleteInvite,
  listInvites,
  listUsers,
  updateUser
} from "./auth.js";
import { getCoverage, getSetting, iterateTableRaw, listUploads, pruneOldHistory, setSetting } from "./history.js";
import { buildViewWithRows } from "./metrics.js";

// 视图 → 它依赖的历史表(注入 key → 历史表名)
const VIEW_HISTORY_TABLES = {
  product: { product: "product_daily", adItem: "ad_item", content: "content" },
  "ad-products": { adItem: "ad_item", content: "content" },
  keywords: { keyword: "keyword" },
  crowds: { crowd: "crowd" },
  contents: { content: "content" }
};

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

  // ---- P4.15 历史数据看板(留存配置 + 归档列表)----

  // 看板数据:当前留存设置 + admin 自己的上传归档 + 覆盖区间
  router.get("/history", (req, res, next) => {
    try {
      const stored = getSetting("retention_months", "");
      res.json({
        retentionMonths: stored === "" || stored == null ? null : Number(stored),
        uploads: listUploads(req.user.id, 100),
        coverage: getCoverage(req.user.id)
      });
    } catch (e) {
      next(e);
    }
  });

  // 设留存月数(0=永久);立即按新策略 prune 一次(磁盘在下次 VACUUM 回收)
  router.put("/history/retention", (req, res, next) => {
    try {
      const m = Number(req.body?.months);
      if (!Number.isInteger(m) || m < 0 || m > 120) {
        return res.status(400).json({ error: "留存月数应为 0~120 的整数(0 = 永久保留)" });
      }
      setSetting("retention_months", m);
      const pruned = pruneOldHistory(m);
      res.json({ ok: true, retentionMonths: m, pruned });
    } catch (e) {
      next(e);
    }
  });

  // P4.15(二)按日期区间从历史库在线构建某个分析视图(管理员历史浏览)。
  // 复用正常视图的全部聚合逻辑,只是数据源换成历史库该区间的行。
  router.get("/history/view/:name", async (req, res, next) => {
    try {
      const map = VIEW_HISTORY_TABLES[req.params.name];
      if (!map) return res.status(400).json({ error: "未知视图" });
      const range = {
        start: typeof req.query.start === "string" ? req.query.start : "",
        end: typeof req.query.end === "string" ? req.query.end : "",
        scene: typeof req.query.scene === "string" ? req.query.scene : "",
        q: typeof req.query.q === "string" ? req.query.q.trim() : ""
      };
      const uid = req.user.id;
      const injected = {};
      for (const [key, table] of Object.entries(map)) {
        injected[key] = [...iterateTableRaw(uid, table, { start: range.start, end: range.end })];
      }
      res.json(await buildViewWithRows(req.params.name, uid, range, injected));
    } catch (e) {
      next(e);
    }
  });

  return router;
}
