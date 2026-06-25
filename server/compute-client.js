// 主线程侧:把数据计算请求转发给 compute-worker,保持和 metrics.js 同名签名,
// 这样 index.js 只需把 import 来源从 ./metrics.js 换成 ./compute-client.js。
//
// 单 worker 独占解析缓存:重活在 worker 串行跑,主线程永远响应。
// (多用户高并发再上多进程/worker 池;当前单 worker 已能消除"整页冻结"。)

import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, "compute-worker.js");

let worker = null;
let seq = 0;
const pending = new Map();

function spawn() {
  const w = new Worker(WORKER_PATH, {
    // 不继承父进程 execArgv(避免 --input-type 等 flag 冲突);堆上限走 resourceLimits
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: Number(process.env.COMPUTE_WORKER_HEAP_MB || 8192) }
  });
  w.on("message", (msg) => {
    if (msg && msg.ready) return; // 就绪信号,忽略
    const { id, result, error } = msg || {};
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(result);
  });
  const fail = (err) => {
    // worker 崩溃:让所有在途请求失败,下次调用自动重启
    for (const p of pending.values()) p.reject(err instanceof Error ? err : new Error(String(err)));
    pending.clear();
    if (worker === w) worker = null;
  };
  w.on("error", fail);
  w.on("exit", (code) => {
    if (code !== 0) fail(new Error(`compute-worker 退出,code=${code}`));
    if (worker === w) worker = null;
  });
  return w;
}

function ensureWorker() {
  if (!worker) worker = spawn();
  return worker;
}

function call(op, ...args) {
  const w = ensureWorker();
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      w.postMessage({ id, op, args });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
}

// 与 metrics.js 同名签名(均返回 Promise)
export const buildMeta = (userId) => call("buildMeta", userId);
export const buildProductView = (userId, range = {}) => call("product", userId, range);
export const buildAdProductsView = (userId, range = {}) => call("adProducts", userId, range);
export const buildKeywordView = (userId, range = {}) => call("keyword", userId, range);
export const buildCrowdView = (userId, range = {}) => call("crowd", userId, range);
export const buildContentView = (userId, range = {}) => call("content", userId, range);
export const resetRawCache = (userId) => call("resetCache", userId);
export const clearSourceData = (userId) => call("clearSource", userId);
export const ingestCurrent = (userId, keepHistory) => call("ingestCurrent", userId, keepHistory);
export const prewarm = (userId) => call("prewarm", userId);

// 进程退出时清理 worker
function shutdown() {
  if (worker) {
    worker.terminate().catch(() => {});
    worker = null;
  }
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
