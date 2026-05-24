import express from "express";
import cors from "cors";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multer from "multer";
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
  limits: { fileSize: 80 * 1024 * 1024 },
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

app.use(cors());
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

app.listen(port, "127.0.0.1", () => {
  console.log(`huopan-bi-api listening on http://127.0.0.1:${port}`);
});
