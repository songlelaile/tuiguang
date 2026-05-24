import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAdProductsView, buildContentView, buildCrowdView, buildKeywordView, buildMeta, buildProductView } from "./metrics.js";

const app = express();
const port = Number(process.env.PORT || 5174);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

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
