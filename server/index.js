import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
import XLSX from "xlsx";
import {
  buildAdProductsView,
  buildContentView,
  buildCrowdView,
  buildKeywordView,
  buildMeta,
  buildProductView,
  clearSourceData,
  getRawSnapshot,
  getRootUploadDir,
  getUploadedSourcePath,
  resetRawCache,
  sourceUploadSlots
} from "./metrics.js";
import {
  computeCompareRange,
  getCoverage,
  getDbHandle,
  getFirstAdminId,
  ingestUpload,
  initDatabase,
  iterateTableRaw,
  listUploads,
  queryAdSummary,
  queryProductHistory,
  querySeries,
  tableExportName
} from "./history.js";
import { ZipArchive } from "archiver";
import { stringify as csvStringify } from "csv-stringify/sync";
import {
  buildAuthMiddleware,
  migrateLegacyUploadFiles,
  pruneExpiredSessions,
  requireAdmin
} from "./auth.js";
import { createAuthRouter } from "./auth-routes.js";
import { createAdminRouter } from "./admin-routes.js";

const app = express();
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "0.0.0.0";
const uploadMaxMb = Number(process.env.UPLOAD_MAX_MB || 100);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// 上传临时目录使用根级 _tmp(与 user 无关,文件落地前不知道是谁的)
const uploadTmpDir = path.join(getRootUploadDir(), "_tmp");

// auth 中间件 + 业务路由共用 history.js 的同一个 SQLite 连接
const getDb = getDbHandle;

const upload = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fsSync.mkdirSync(uploadTmpDir, { recursive: true });
      callback(null, uploadTmpDir);
    },
    filename(_req, file, callback) {
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      callback(null, `${suffix}${path.extname(file.originalname).toLowerCase()}`);
    }
  }),
  limits: { fileSize: uploadMaxMb * 1024 * 1024 },
  fileFilter(_req, file, callback) {
    const slot = sourceUploadSlots.find((item) => item.id === file.fieldname);
    if (!slot) {
      callback(new Error(`不支持的源表字段: ${file.fieldname}`));
      return;
    }
    const ext = path.extname(file.originalname).toLowerCase();
    if (!slot.extensions.includes(ext)) {
      callback(new Error(`${slot.name} 仅支持 ${slot.extensions.join(" / ")} 文件`));
      return;
    }
    callback(null, true);
  }
});

const corsOriginEnv = process.env.CORS_ORIGIN || "";
const corsAllowlist = corsOriginEnv
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
app.use(
  cors({
    origin: corsAllowlist.length ? corsAllowlist : false,
    credentials: true
  })
);
app.use(express.json({ limit: "16mb" }));
app.use(cookieParser());

// P4.3 性能:gzip 压缩响应,JSON / HTML / JS / CSS 体积通常降 70-85%
// 注意:若前置 nginx 也开了 gzip 会双重压缩,二选一(我们用 Node 这层)
app.use(
  compression({
    threshold: 1024, // < 1KB 不压(开销不值)
    level: 6,
    filter(req, res) {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    }
  })
);

// ---- 路由顺序 ----
//
//   1) /api/health         免鉴权(健康检查 / 监控 / certbot 探活)
//   2) /api/auth/register|login|logout  免鉴权(本来就是用来获取 session 的)
//   3) /api/auth/me        过 requireAuth(由前端判断是否登录;未登录返回 401)
//   4) 其它 /api/*         过 requireAuth
//   5) /api/admin/*        额外过 requireAdmin

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "huopan-bi-api" });
});

app.use("/api/auth", createAuthRouter(getDb));

const requireAuth = buildAuthMiddleware(getDb);

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// 此处之后的所有 /api/* 必须先登录
app.use("/api", requireAuth);

app.use("/api/admin", requireAdmin, createAdminRouter(getDb));

// ---- 业务路由(全部已被 requireAuth 拦) ----

function queryRange(req) {
  return {
    start: typeof req.query.start === "string" ? req.query.start : "",
    end: typeof req.query.end === "string" ? req.query.end : "",
    scene: typeof req.query.scene === "string" ? req.query.scene : "",
    q: typeof req.query.q === "string" ? req.query.q.trim() : ""
  };
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

app.get("/api/meta", async (req, res, next) => {
  try {
    res.json(await buildMeta(req.user.id));
  } catch (error) {
    next(error);
  }
});

app.post(
  "/api/uploads/sources",
  upload.fields(sourceUploadSlots.map((slot) => ({ name: slot.id, maxCount: 1 }))),
  async (req, res, next) => {
    const userId = req.user.id;
    const filesByField = req.files || {};
    const receivedFiles = sourceUploadSlots.flatMap((slot) => filesByField[slot.id] || []);
    if (!receivedFiles.length) {
      res.status(400).json({ error: "请至少选择一张源表" });
      return;
    }

    const backups = [];
    const moved = [];
    try {
      const userUploadDir = path.dirname(getUploadedSourcePath(userId, sourceUploadSlots[0].id));
      await fs.mkdir(userUploadDir, { recursive: true });
      for (const slot of sourceUploadSlots) {
        const file = filesByField[slot.id]?.[0];
        if (!file) continue;

        const targetPath = getUploadedSourcePath(userId, slot.id);
        const backupPath = `${targetPath}.bak-${Date.now()}`;
        if (await fileExists(targetPath)) {
          await fs.rename(targetPath, backupPath);
          backups.push({ targetPath, backupPath });
        }

        await fs.rename(file.path, targetPath);
        moved.push({ id: slot.id, name: slot.name, file: targetPath });
      }

      resetRawCache(userId);
      const meta = await buildMeta(userId);
      await Promise.all(backups.map((backup) => fs.rm(backup.backupPath, { force: true })));

      // P1.2 异步双写到 SQLite 历史库;失败 log 不影响上传成功
      getRawSnapshot(userId)
        .then((raw) => {
          try {
            const result = ingestUpload({
              userId,
              product: raw.product || [],
              adItem: raw.adItem || [],
              content: raw.content || [],
              keyword: raw.keyword || [],
              crowd: raw.crowd || []
            });
            console.log(`[history] user ${userId} upload #${result.uploadId} ingested, range ${result.dateMin} ~ ${result.dateMax}`);
          } catch (err) {
            console.error(`[history] user ${userId} ingest failed:`, err.message);
          }
        })
        .catch((err) => console.error(`[history] user ${userId} snapshot failed:`, err.message));

      res.json({ ok: true, updated: moved, meta });
    } catch (error) {
      await Promise.all(moved.map((item) => fs.rm(item.file, { force: true })));
      for (const backup of backups.reverse()) {
        if (await fileExists(backup.backupPath)) {
          await fs.rename(backup.backupPath, backup.targetPath);
        }
      }
      resetRawCache(userId);
      next(error);
    } finally {
      await Promise.all(receivedFiles.map((file) => fs.rm(file.path, { force: true })));
    }
  }
);

app.delete("/api/uploads/sources", async (req, res, next) => {
  try {
    await clearSourceData(req.user.id);
    res.json({ ok: true, meta: await buildMeta(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.get("/api/product", async (req, res, next) => {
  try { res.json(await buildProductView(req.user.id, queryRange(req))); } catch (e) { next(e); }
});

app.get("/api/ad-products", async (req, res, next) => {
  try { res.json(await buildAdProductsView(req.user.id, queryRange(req))); } catch (e) { next(e); }
});

app.get("/api/keywords", async (req, res, next) => {
  try { res.json(await buildKeywordView(req.user.id, queryRange(req))); } catch (e) { next(e); }
});

app.get("/api/crowds", async (req, res, next) => {
  try { res.json(await buildCrowdView(req.user.id, queryRange(req))); } catch (e) { next(e); }
});

app.get("/api/contents", async (req, res, next) => {
  try { res.json(await buildContentView(req.user.id, queryRange(req))); } catch (e) { next(e); }
});

// ---- Excel 导出 ----

function sendXlsx(res, sheets, filename) {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    if (!rows || !rows.length) continue;
    const ws = XLSX.utils.json_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send(buf);
}

function rangeTag(range) {
  if (range.start && range.end) return `${range.start}_${range.end}`;
  if (range.start) return `${range.start}起`;
  if (range.end) return `截至${range.end}`;
  return "全周期";
}

app.get("/api/product/export", async (req, res, next) => {
  try {
    const range = queryRange(req);
    const view = await buildProductView(req.user.id, range);
    const s = view.summary || {};
    const summary = [
      { 指标: "商品分组", 数值: s.groups },
      { 指标: "投了推广的商品数", 数值: s.promotedItemCount },
      { 指标: "全店支付金额", 数值: s.totalPay },
      { 指标: "全店退款金额", 数值: s.totalRefund },
      { 指标: "退款金额占比(%)", 数值: s.refundRatio != null ? (s.refundRatio * 100).toFixed(2) : null },
      { 指标: "全店推广花费", 数值: s.totalSpend },
      { 指标: "已分摊推广花费", 数值: s.allocatedSpend },
      { 指标: "未分摊内容推广", 数值: s.unallocatedSpend },
      { 指标: "全店净费比(%)", 数值: s.netFeeRatio != null ? (s.netFeeRatio * 100).toFixed(2) : null }
    ];
    const detail = (view.table || []).map((row, i) => ({
      序号: i + 1,
      主体编码: row.subjectCode,
      支付金额: row.pay,
      退款金额: row["成功退款金额"],
      推广消耗: row["推广消耗"],
      商品访客数: row.visitors,
      转化率: row.conversionRate,
      客单价: row.customerPrice,
      年累计支付金额: row.annualPay,
      年累计支付金额占比: row.annualPayShare,
      费比: row.feeRatio,
      退款金额占比: row.refundRatio,
      复购率: row.repeatRate,
      复购金额占比: row.repeatPayRatio,
      加购率: row.cartRate,
      人均浏览量: row.pvPerVisitor,
      链接净ROI: row.netRoi
    }));
    sendXlsx(res, [["汇总", summary], ["商品经营明细", detail]], `商品维度_${rangeTag(range)}.xlsx`);
  } catch (error) { next(error); }
});

app.get("/api/ad-products/export", async (req, res, next) => {
  try {
    const range = queryRange(req);
    const view = await buildAdProductsView(req.user.id, range);
    const s = view.summary || {};
    const summary = [
      { 指标: "原始行数", 数值: s.rows },
      { 指标: "主体数", 数值: s.subjects },
      { 指标: "计划数", 数值: s.plans },
      { 指标: "总花费", 数值: s.totalSpend },
      { 指标: "总GMV", 数值: s.totalGmv },
      { 指标: "总ROI", 数值: s.roi }
    ];
    const detail = (view.planTable || []).map((row, i) => ({
      序号: i + 1, 计划编码: row.planCode, 花费: row.spend, GMV: row.gmv, ROI: row.roi,
      CPC: row.cpc, CTR: row.ctr, CVR: row.cvr, 客单价: row.customerPrice, CPM: row.cpm,
      展现量: row["展现量"], 点击量: row["点击量"], 成交笔数: row["总成交笔数"], 购物车数: row["总购物车数"]
    }));
    sendXlsx(res, [["汇总", summary], ["计划维度明细", detail]], `推广商品_${rangeTag(range)}.xlsx`);
  } catch (error) { next(error); }
});

app.get("/api/keywords/export", async (req, res, next) => {
  try {
    const range = queryRange(req);
    const view = await buildKeywordView(req.user.id, range);
    const s = view.summary || {};
    const summary = [
      { 指标: "原始行数", 数值: s.rows },
      { 指标: "关键词分组数", 数值: s.groups },
      { 指标: "总花费", 数值: s.totalSpend }
    ];
    const detail = (view.table || []).map((row, i) => ({
      序号: i + 1, 关键词编码: row.keywordCode, 词类型: row.type, 词: row.word,
      花费: row.spend, GMV: row.gmv, ROI: row.roi, CPC: row.cpc, CTR: row.ctr, CVR: row.cvr,
      平均展现排名: row.avgRank, 展现量: row["展现量"], 点击量: row["点击量"], 成交笔数: row["总成交笔数"]
    }));
    sendXlsx(res, [["汇总", summary], ["关键词明细", detail]], `推广关键词_${rangeTag(range)}.xlsx`);
  } catch (error) { next(error); }
});

app.get("/api/crowds/export", async (req, res, next) => {
  try {
    const range = queryRange(req);
    const view = await buildCrowdView(req.user.id, range);
    const s = view.summary || {};
    const summary = [
      { 指标: "原始行数", 数值: s.rows },
      { 指标: "人群分组数", 数值: s.groups },
      { 指标: "总花费", 数值: s.totalSpend }
    ];
    const detail = (view.table || []).map((row, i) => ({
      序号: i + 1, 人群编码: row.crowdCode, 花费: row.spend, GMV: row.gmv, ROI: row.roi,
      CPC: row.cpc, CTR: row.ctr, CVR: row.cvr, 展现量: row["展现量"], 点击量: row["点击量"], 成交笔数: row["总成交笔数"]
    }));
    sendXlsx(res, [["汇总", summary], ["人群明细", detail]], `推广人群_${rangeTag(range)}.xlsx`);
  } catch (error) { next(error); }
});

app.get("/api/contents/export", async (req, res, next) => {
  try {
    const range = queryRange(req);
    const view = await buildContentView(req.user.id, range);
    const s = view.summary || {};
    const summary = [
      { 指标: "原始行数", 数值: s.rows },
      { 指标: "内容分组数", 数值: s.groups },
      { 指标: "总花费", 数值: s.totalSpend }
    ];
    const detail = (view.table || []).map((row, i) => ({
      序号: i + 1, 内容编码: row.contentCode, 主体类型: row.type,
      花费: row.spend, GMV: row.gmv, ROI: row.roi, CPC: row.cpc, CTR: row.ctr, CVR: row.cvr,
      展现量: row["展现量"], 点击量: row["点击量"], 成交笔数: row["总成交笔数"]
    }));
    sendXlsx(res, [["汇总", summary], ["内容明细", detail]], `推广内容_${rangeTag(range)}.xlsx`);
  } catch (error) { next(error); }
});

// ---- P1.3 History (跨周期) ----

app.get("/api/history/coverage", (req, res, next) => {
  try { res.json(getCoverage(req.user.id)); } catch (e) { next(e); }
});

app.get("/api/history/uploads", (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    res.json(listUploads(req.user.id, limit));
  } catch (e) { next(e); }
});

app.get("/api/history/product", (req, res, next) => {
  try {
    const start = typeof req.query.start === "string" ? req.query.start : "";
    const end = typeof req.query.end === "string" ? req.query.end : "";
    const itemId = typeof req.query.itemId === "string" ? req.query.itemId : "";
    res.json(queryProductHistory({ userId: req.user.id, start, end, itemId }));
  } catch (e) { next(e); }
});

app.get("/api/history/ad-summary", (req, res, next) => {
  try {
    const start = typeof req.query.start === "string" ? req.query.start : "";
    const end = typeof req.query.end === "string" ? req.query.end : "";
    res.json(queryAdSummary({ userId: req.user.id, start, end }));
  } catch (e) { next(e); }
});

app.get("/api/history/compare", (req, res, next) => {
  try {
    const userId = req.user.id;
    const view = req.query.view === "product" ? "product" : "ad";
    const metric = typeof req.query.metric === "string" ? req.query.metric : "spend";
    const start = typeof req.query.start === "string" ? req.query.start : "";
    const end = typeof req.query.end === "string" ? req.query.end : "";
    const preset = typeof req.query.preset === "string" ? req.query.preset : "";
    const compareStart = typeof req.query.compareStart === "string" ? req.query.compareStart : "";
    const compareEnd = typeof req.query.compareEnd === "string" ? req.query.compareEnd : "";

    const main = querySeries({ userId, view, metric, start, end });
    let compareInfo = null;
    let compare = null;
    if (preset === "custom" && compareStart && compareEnd) {
      compareInfo = { start: compareStart, end: compareEnd, preset: "custom" };
      compare = querySeries({ userId, view, metric, start: compareStart, end: compareEnd });
    } else if (preset && preset !== "none") {
      const range = computeCompareRange(start, end, preset);
      if (range) {
        compareInfo = { ...range, preset };
        compare = querySeries({ userId, view, metric, ...range });
      }
    }
    res.json({
      view,
      metric,
      main: { start, end, days: main },
      compare: compareInfo ? { ...compareInfo, days: compare || [] } : null
    });
  } catch (e) { next(e); }
});

app.get("/api/history/export", (req, res, next) => {
  try {
    const userId = req.user.id;
    const start = typeof req.query.start === "string" ? req.query.start : "";
    const end = typeof req.query.end === "string" ? req.query.end : "";
    const tag = start || end ? `${start || "起点"}_${end || "至今"}` : "全周期";
    const filename = `tuiguang-历史归档_${tag}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);

    const archive = new ZipArchive({ zlib: { level: 6 } });
    archive.on("warning", (err) => { if (err.code !== "ENOENT") next(err); });
    archive.on("error", (err) => next(err));
    archive.pipe(res);

    const tables = ["product_daily", "ad_item", "content", "keyword", "crowd"];
    for (const table of tables) {
      const rows = [];
      let header = null;
      for (const raw of iterateTableRaw(userId, table, { start, end })) {
        if (!header) header = Object.keys(raw);
        rows.push(raw);
      }
      if (!rows.length) continue;
      const csvText = csvStringify(rows, { header: true, columns: header });
      archive.append("﻿" + csvText, { name: tableExportName[table] });
    }

    archive.finalize();
  } catch (e) {
    next(e);
  }
});

// ---- 静态资源 + SPA fallback ----

app.use(
  express.static(path.join(rootDir, "dist"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        // SPA 入口必须及时拿到新版本,不缓存
        res.set("Cache-Control", "no-store");
      } else if (/\.(js|css|woff2?|png|jpe?g|svg|webp|ico)$/.test(filePath)) {
        // Vite 打包产物名带 hash → 可以长期缓存,immutable 减少 If-None-Match 校验
        res.set("Cache-Control", "public, max-age=31536000, immutable");
      }
    }
  })
);
app.use((req, res, next) => {
  if (req.method !== "GET" || req.path.startsWith("/api")) {
    next();
    return;
  }
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(rootDir, "dist", "index.html"));
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : "Unknown server error"
  });
});

// ---- 启动 ----

try {
  // 同步触发完整 DB init:auth 表 + bootstrap admin + 老数据迁移 + 业务 schema
  initDatabase();
} catch (e) {
  console.error("[startup] DB 初始化失败,无法启动:", e.message);
  process.exit(1);
}

// 把旧版 uploads/source-data/*.{xlsx,csv} 裸文件归到 first admin(幂等)
try {
  const adminId = getFirstAdminId();
  if (adminId) migrateLegacyUploadFiles(getRootUploadDir(), adminId);
} catch (e) {
  console.error("[migration] 上传文件迁移失败(已忽略):", e.message);
}

// 清理过期 session
try {
  const removed = pruneExpiredSessions(getDb());
  if (removed > 0) console.log(`[auth] 启动时清理 ${removed} 条过期 session`);
} catch (e) {
  console.error("[auth] session 清理失败:", e.message);
}

app.listen(port, host, () => {
  console.log(`huopan-bi-api listening on http://${host}:${port}`);
});
