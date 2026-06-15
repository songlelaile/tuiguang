import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import compression from "compression";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cluster from "node:cluster";
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
  runHistoryMaintenance,
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
import { preflight as baPreflight, mergeFiles as baMergeFiles, workbookBuffer as baWorkbookBuffer } from "./business-advisor-merge.js";

const app = express();
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "0.0.0.0";

// P4.5 rate-limit 要看真实 IP;我们容器前面有 nginx 反代 1 层
// 信任 1 层代理就够,设 true 会把所有 X-Forwarded-For 信任(不安全)
app.set("trust proxy", 1);
const uploadMaxMb = Number(process.env.UPLOAD_MAX_MB || 500);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

// 上传临时目录使用根级 _tmp(与 user 无关,文件落地前不知道是谁的)
const uploadTmpDir = path.join(getRootUploadDir(), "_tmp");

// 崩溃 / 异常落盘:进程级未捕获错误 + 每个 500 都追加到 logs/server-error.log
// 背景:API 进程曾"无声死亡"且 concurrently 不重启,前端只剩
//   "Failed to execute 'json' ...: Unexpected end of JSON input"
// 排查时没有任何栈。落盘后下次崩溃可直接 tail logs/server-error.log 定位。
const crashLogDir = path.join(rootDir, "logs");
const crashLogFile = path.join(crashLogDir, "server-error.log");
function logCrash(context, error) {
  const stamp = new Date().toISOString();
  const detail = error instanceof Error ? error.stack || error.message : String(error);
  const line = `\n[${stamp}] ${context}\n${detail}\n`;
  // 同步写:即使紧接着进程退出也要确保栈落地
  try {
    fsSync.mkdirSync(crashLogDir, { recursive: true });
    fsSync.appendFileSync(crashLogFile, line);
  } catch (writeErr) {
    console.error("[crashlog] 写入失败:", writeErr.message);
  }
  console.error(`[${context}]`, detail);
}

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

// 生意参谋多日表合并：接受多份 .xls/.xlsx，先落到根级临时目录，路由内再归到 job 目录
const baTmpDir = path.join(getRootUploadDir(), "_ba", "_tmp");
const baMaxFiles = Number(process.env.BA_MERGE_MAX_FILES || 400);
const uploadBa = multer({
  storage: multer.diskStorage({
    destination(_req, _file, callback) {
      fsSync.mkdirSync(baTmpDir, { recursive: true });
      callback(null, baTmpDir);
    },
    filename(_req, file, callback) {
      const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      callback(null, `${suffix}${path.extname(file.originalname).toLowerCase()}`);
    }
  }),
  limits: { fileSize: uploadMaxMb * 1024 * 1024, files: baMaxFiles },
  fileFilter(_req, file, callback) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".xls", ".xlsx"].includes(ext)) {
      callback(new Error(`仅支持 .xls / .xlsx 文件（${file.originalname}）`));
      return;
    }
    callback(null, true);
  }
});

// multer 把中文文件名按 latin1 解码，这里还原成 utf8
function decodeOriginalName(name) {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

function baUserRoot(userId) {
  return path.join(getRootUploadDir(), "_ba", String(userId));
}
function baJobDir(userId, jobId) {
  if (!/^[0-9a-z][0-9a-z-]{0,80}$/i.test(String(jobId || ""))) {
    throw new Error("非法的任务编号");
  }
  return path.join(baUserRoot(userId), String(jobId));
}

// 清理超过 24h 的旧 job 目录（尽力而为，失败不影响主流程）
async function cleanupOldBaJobs(userId) {
  const root = baUserRoot(userId);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory())
        .map(async (e) => {
          const dir = path.join(root, e.name);
          try {
            const st = await fs.stat(dir);
            if (st.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
          } catch {
            /* 忽略单个目录的清理失败 */
          }
        })
    );
  } catch {
    /* 目录还不存在等情况，忽略 */
  }
}

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
              // P4.14 普通用户覆盖式留存:非 admin 上传前先清掉其旧历史,只留最新一份;
              // admin 保留全量历史(供跨周期对比 / 归档看板)。
              keepHistory: req.user.role === "admin",
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

// ============ 生意参谋多日表合并 ============

// 预检：上传多份 .xls/.xlsx → 落到 job 目录 → 解析校验 → 返回报告（不合并）
app.post("/api/ba-merge/preflight", uploadBa.array("files", baMaxFiles), async (req, res, next) => {
  const userId = req.user.id;
  const received = req.files || [];
  if (!received.length) {
    res.status(400).json({ error: "请至少选择一份 .xls 文件" });
    return;
  }
  let jobDir;
  try {
    await cleanupOldBaJobs(userId);
    const jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    jobDir = baJobDir(userId, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const manifest = [];
    for (const file of received) {
      const disk = path.basename(file.path);
      const name = decodeOriginalName(file.originalname);
      await fs.rename(file.path, path.join(jobDir, disk));
      manifest.push({ disk, name });
    }
    await fs.writeFile(path.join(jobDir, "manifest.json"), JSON.stringify(manifest), "utf8");

    const start = String(req.query.start || req.body?.start || "").trim();
    const end = String(req.query.end || req.body?.end || "").trim();
    const files = manifest.map((m) => ({ name: m.name, path: path.join(jobDir, m.disk) }));
    const report = await baPreflight(files, { start, end });
    res.json({ jobId, report });
  } catch (error) {
    // 失败时清理已落地的临时文件
    await Promise.all(received.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));
    if (jobDir) await fs.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    next(error);
  }
});

// 应用：按 resolution 合并 job 目录里的文件 → 写出 merged.xlsx → 可选写入「商品维度」源表并入库
app.post("/api/ba-merge/apply", async (req, res, next) => {
  const userId = req.user.id;
  try {
    const { jobId, resolution = {}, start = "", end = "", store = "", applyAsProduct = true } = req.body || {};
    const jobDir = baJobDir(userId, jobId);
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(path.join(jobDir, "manifest.json"), "utf8"));
    } catch {
      res.status(404).json({ error: "任务已过期或不存在，请重新预检" });
      return;
    }

    const files = manifest.map((m) => ({ name: m.name, path: path.join(jobDir, m.disk) }));
    const { aoa, summary } = await baMergeFiles(files, { resolution, start: String(start).trim(), end: String(end).trim() });
    if (!summary.rows) {
      res.status(400).json({ error: "合并结果为空：没有落在日期范围内的有效数据" });
      return;
    }

    const buffer = baWorkbookBuffer(aoa);
    await fs.writeFile(path.join(jobDir, "merged.xlsx"), buffer);

    const safeStore = String(store).trim().replace(/[\\/:*?"<>|]/g, "").slice(0, 40);
    const downloadName = `${safeStore || "生意参谋商品全部"}_${summary.firstDate}至${summary.lastDate}_合并.xlsx`;
    await fs.writeFile(path.join(jobDir, "result.json"), JSON.stringify({ summary, downloadName }), "utf8");

    let meta = null;
    let applied = false;
    if (applyAsProduct) {
      const productPath = getUploadedSourcePath(userId, "product");
      await fs.mkdir(path.dirname(productPath), { recursive: true });
      let backupPath = "";
      if (await fileExists(productPath)) {
        backupPath = `${productPath}.bak-${Date.now()}`;
        await fs.rename(productPath, backupPath);
      }
      try {
        await fs.writeFile(productPath, buffer);
        resetRawCache(userId);
        meta = await buildMeta(userId);
        if (backupPath) await fs.rm(backupPath, { force: true });
        applied = true;
      } catch (err) {
        // 回滚到备份
        if (backupPath && (await fileExists(backupPath))) await fs.rename(backupPath, productPath);
        resetRawCache(userId);
        throw err;
      }

      // 异步双写到历史库（与 /api/uploads/sources 一致；失败仅 log，不影响应用成功）
      getRawSnapshot(userId)
        .then((raw) => {
          try {
            const result = ingestUpload({
              userId,
              keepHistory: req.user.role === "admin",
              product: raw.product || [],
              adItem: raw.adItem || [],
              content: raw.content || [],
              keyword: raw.keyword || [],
              crowd: raw.crowd || []
            });
            console.log(`[ba-merge] user ${userId} merged ${summary.fileCount} files → upload #${result.uploadId}, range ${result.dateMin} ~ ${result.dateMax}`);
          } catch (err) {
            console.error(`[ba-merge] user ${userId} ingest failed:`, err.message);
          }
        })
        .catch((err) => console.error(`[ba-merge] user ${userId} snapshot failed:`, err.message));
    }

    res.json({ ok: true, summary, applied, downloadUrl: `/api/ba-merge/download/${jobId}`, meta });
  } catch (error) {
    next(error);
  }
});

// 下载合并后的 .xlsx
app.get("/api/ba-merge/download/:jobId", async (req, res, next) => {
  const userId = req.user.id;
  try {
    const jobDir = baJobDir(userId, req.params.jobId);
    const mergedPath = path.join(jobDir, "merged.xlsx");
    if (!(await fileExists(mergedPath))) {
      res.status(404).json({ error: "合并文件不存在或已过期，请重新合并" });
      return;
    }
    let downloadName = "生意参谋商品全部_合并.xlsx";
    try {
      const result = JSON.parse(await fs.readFile(path.join(jobDir, "result.json"), "utf8"));
      if (result.downloadName) downloadName = result.downloadName;
    } catch {
      /* 用默认名 */
    }
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`);
    res.sendFile(mergedPath);
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

app.use((error, req, res, _next) => {
  logCrash(`request-error ${req.method} ${req.originalUrl}`, error);
  // P4.10 把 multer "File too large" 翻译成中文 + 告诉用户上限
  if (error?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({
      error: `单个文件不能超过 ${uploadMaxMb} MB。如需上传更大的文件,请联系管理员调高 UPLOAD_MAX_MB 环境变量(同步调高 nginx 的 client_max_body_size)。`
    });
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : "Unknown server error"
  });
});

// ---- 启动 ----

// 启动一个 HTTP 服务进程:单进程模式由主进程调用,集群模式由各 worker 调用。
// 每个真正服务请求的进程都装上 OOM 堆预警 + 进程级异常兜底。
function startServer() {
  // OOM 早期预警:V8 fatal OOM 会直接 SIGABRT,uncaughtException 捕获不到。
  // 定时采样堆用量,逼近上限时往 crash log 写面包屑。(同步 parse 内部爆掉时采样
  // 来不及触发,是已知局限。)
  const heapLimitMb = (() => {
    const m = /max-old-space-size=(\d+)/.exec(process.env.NODE_OPTIONS || "");
    return m ? Number(m[1]) : 0;
  })();
  let heapWarned = false;
  const heapWatchTimer = setInterval(() => {
    if (!heapLimitMb) return;
    const usedMb = process.memoryUsage().heapUsed / 1024 / 1024;
    if (usedMb > heapLimitMb * 0.85) {
      if (!heapWarned) {
        heapWarned = true;
        logCrash(
          "heap-high-water",
          new Error(`堆用量 ${usedMb.toFixed(0)}MB 已超过上限 ${heapLimitMb}MB 的 85%,可能即将 OOM`)
        );
      }
    } else {
      heapWarned = false;
    }
  }, 2000);
  heapWatchTimer.unref();

  // 进程级兜底:未捕获异常 / 未处理 rejection → 落盘并保活(内部 BI 工具,降级服务好过无声消失)
  process.on("uncaughtException", (error) => logCrash("uncaughtException", error));
  process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));

  app.listen(port, host, () => {
    const tag = cluster.isWorker ? `worker pid=${process.pid}` : "单进程";
    console.log(`huopan-bi-api listening on http://${host}:${port} (${tag})`);
  });
}

// P4.13 多进程:WEB_CONCURRENCY>1 时主进程 fork 多个 worker 吃满多核;默认 1 = 单进程(原行为)。
// ⚠️ 每个 worker 各持一份内存缓存,总内存 ≈ worker 数 × 单进程内存,需按服务器内存设 WEB_CONCURRENCY
//    和 RAW_CACHE_ROW_BUDGET / RESULT_CACHE_MAX_MB(见 deploy 文档)。
// 主进程只做一次:DB 初始化(避免多进程 bootstrap 竞争)+ 迁移 + session 定时清理。
const workerCount = (() => {
  const env = Number(process.env.WEB_CONCURRENCY);
  return Number.isFinite(env) && env >= 1 ? Math.floor(env) : 1;
})();

if (cluster.isPrimary) {
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

  // 启动时清一次过期 session
  try {
    const removed = pruneExpiredSessions(getDb());
    if (removed > 0) console.log(`[auth] 启动时清理 ${removed} 条过期 session`);
  } catch (e) {
    console.error("[auth] session 清理失败:", e.message);
  }

  // P4.5 sessions 表定时清过期(只在主进程跑,避免多 worker 重复写)
  const SESSION_PRUNE_INTERVAL_MS = Number(process.env.SESSION_PRUNE_INTERVAL_MS || 60 * 60 * 1000);
  const sessionPruneTimer = setInterval(() => {
    try {
      const removed = pruneExpiredSessions(getDb());
      if (removed > 0) console.log(`[auth] 定时清理 ${removed} 条过期 session`);
    } catch (e) {
      console.error("[auth] 定时 session 清理失败:", e.message);
    }
  }, SESSION_PRUNE_INTERVAL_MS);
  sessionPruneTimer.unref();
  process.on("SIGTERM", () => clearInterval(sessionPruneTimer));
  process.on("SIGINT", () => clearInterval(sessionPruneTimer));

  // P4.14 历史库自动维护:留存清理 + WAL 回收 + VACUUM/增量回收(只在主进程跑)。
  // 启动后 30s 跑一次(首次做一次性 VACUUM 压实历史膨胀),之后每天一次。
  // HISTORY_RETENTION_MONTHS:admin 历史保留月数,0=永久(默认);普通用户已覆盖式,不受影响。
  const HISTORY_RETENTION_MONTHS = Number(process.env.HISTORY_RETENTION_MONTHS || 0);
  const HISTORY_MAINT_INTERVAL_MS = Number(process.env.HISTORY_MAINT_INTERVAL_MS || 24 * 60 * 60 * 1000);
  const historyMaintBoot = setTimeout(() => runHistoryMaintenance(HISTORY_RETENTION_MONTHS), 30 * 1000);
  const historyMaintTimer = setInterval(() => runHistoryMaintenance(HISTORY_RETENTION_MONTHS), HISTORY_MAINT_INTERVAL_MS);
  historyMaintBoot.unref();
  historyMaintTimer.unref();
  process.on("SIGTERM", () => { clearTimeout(historyMaintBoot); clearInterval(historyMaintTimer); });
  process.on("SIGINT", () => { clearTimeout(historyMaintBoot); clearInterval(historyMaintTimer); });

  if (workerCount > 1) {
    console.log(`[cluster] 主进程 ${process.pid} 启动 ${workerCount} 个 worker(各持独立内存缓存)`);
    for (let i = 0; i < workerCount; i++) cluster.fork();
    cluster.on("exit", (worker, code, signal) => {
      console.error(`[cluster] worker ${worker.process.pid} 退出(${signal || code}),自动重启一个`);
      cluster.fork();
    });
  } else {
    // 单进程模式:主进程自己服务(DB 已在上面初始化好)
    startServer();
  }
} else {
  // worker:DB schema 已由主进程建好;WAL 支持多进程连接,首次 getDb() 自开本进程连接
  startServer();
}
