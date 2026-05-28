import express from "express";
import cors from "cors";
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
  getUploadedSourcePath,
  getUploadDir,
  resetRawCache,
  sourceUploadSlots
} from "./metrics.js";

const app = express();
const port = Number(process.env.PORT || 5174);
const host = process.env.HOST || "0.0.0.0";
const uploadMaxMb = Number(process.env.UPLOAD_MAX_MB || 100);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const uploadTmpDir = path.join(getUploadDir(), "_tmp");

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
    credentials: false
  })
);
app.use(express.json({ limit: "16mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "huopan-bi-api" });
});

function queryRange(req) {
  return {
    start: typeof req.query.start === "string" ? req.query.start : "",
    end: typeof req.query.end === "string" ? req.query.end : "",
    scene: typeof req.query.scene === "string" ? req.query.scene : "",
    q: typeof req.query.q === "string" ? req.query.q.trim() : ""
  };
}

app.get("/api/meta", async (_req, res, next) => {
  try {
    res.json(await buildMeta());
  } catch (error) {
    next(error);
  }
});

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

app.post(
  "/api/uploads/sources",
  upload.fields(sourceUploadSlots.map((slot) => ({ name: slot.id, maxCount: 1 }))),
  async (req, res, next) => {
    const filesByField = req.files || {};
    const receivedFiles = sourceUploadSlots.flatMap((slot) => filesByField[slot.id] || []);
    if (!receivedFiles.length) {
      res.status(400).json({ error: "请至少选择一张源表" });
      return;
    }

    const backups = [];
    const moved = [];
    try {
      await fs.mkdir(getUploadDir(), { recursive: true });
      for (const slot of sourceUploadSlots) {
        const file = filesByField[slot.id]?.[0];
        if (!file) continue;

        const targetPath = getUploadedSourcePath(slot.id);
        const backupPath = `${targetPath}.bak-${Date.now()}`;
        if (await fileExists(targetPath)) {
          await fs.rename(targetPath, backupPath);
          backups.push({ targetPath, backupPath });
        }

        await fs.rename(file.path, targetPath);
        moved.push({ id: slot.id, name: slot.name, file: targetPath });
      }

      resetRawCache();
      const meta = await buildMeta();
      await Promise.all(backups.map((backup) => fs.rm(backup.backupPath, { force: true })));
      res.json({ ok: true, updated: moved, meta });
    } catch (error) {
      await Promise.all(moved.map((item) => fs.rm(item.file, { force: true })));
      for (const backup of backups.reverse()) {
        if (await fileExists(backup.backupPath)) {
          await fs.rename(backup.backupPath, backup.targetPath);
        }
      }
      resetRawCache();
      next(error);
    } finally {
      await Promise.all(receivedFiles.map((file) => fs.rm(file.path, { force: true })));
    }
  }
);

app.delete("/api/uploads/sources", async (_req, res, next) => {
  try {
    await clearSourceData();
    res.json({ ok: true, meta: await buildMeta() });
  } catch (error) {
    next(error);
  }
});

app.get("/api/product", async (req, res, next) => {
  try {
    res.json(await buildProductView(queryRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/ad-products", async (req, res, next) => {
  try {
    res.json(await buildAdProductsView(queryRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/keywords", async (req, res, next) => {
  try {
    res.json(await buildKeywordView(queryRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/crowds", async (req, res, next) => {
  try {
    res.json(await buildCrowdView(queryRange(req)));
  } catch (error) {
    next(error);
  }
});

app.get("/api/contents", async (req, res, next) => {
  try {
    res.json(await buildContentView(queryRange(req)));
  } catch (error) {
    next(error);
  }
});

// ---- P0.3 Excel 导出 ----
// 把 view 数据塑形成清晰的中文列后输出 xlsx；每个文件含 2 张 sheet：汇总 + 明细
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
    const view = await buildProductView(range);
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
    const view = await buildAdProductsView(range);
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
    const view = await buildKeywordView(range);
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
    const view = await buildCrowdView(range);
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
    const view = await buildContentView(range);
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

app.use(
  express.static(path.join(rootDir, "dist"), {
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) {
        res.set("Cache-Control", "no-store");
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

app.listen(port, host, () => {
  console.log(`huopan-bi-api listening on http://${host}:${port}`);
});
