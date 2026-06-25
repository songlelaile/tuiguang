// 计算 worker:独占源数据解析缓存 + 聚合,主线程通过 compute-client 转发请求。
//
// 背景:源文件巨大(keyword.csv 270MB / 21万行),原本在主线程同步解析+聚合,
// 单次冷计算 8~20s 阻塞事件循环 → 整页冻结、健康检查超时。
// 把这部分搬到 worker:主线程永远响应,冷计算在 worker 里跑(对用户是"转圈加载"而非"卡死")。
//
// ingest 也在 worker 内做(getRawSnapshot 是 4GB 级数据,不能 postMessage 回主线程)。

import { parentPort } from "node:worker_threads";
import * as metrics from "./metrics.js";
import { ingestUpload } from "./history.js";

const handlers = {
  buildMeta: (userId) => metrics.buildMeta(userId),
  product: (userId, range) => metrics.buildProductView(userId, range),
  adProducts: (userId, range) => metrics.buildAdProductsView(userId, range),
  keyword: (userId, range) => metrics.buildKeywordView(userId, range),
  crowd: (userId, range) => metrics.buildCrowdView(userId, range),
  content: (userId, range) => metrics.buildContentView(userId, range),
  resetCache: (userId) => {
    metrics.resetRawCache(userId);
    return { ok: true };
  },
  clearSource: (userId) => metrics.clearSourceData(userId),
  // 上传后入历史库:在 worker 内 getRawSnapshot(已在本线程缓存)+ ingestUpload,
  // 避免把全量原始数据传回主线程。
  ingestCurrent: async (userId, keepHistory) => {
    const raw = await metrics.getRawSnapshot(userId);
    return ingestUpload({
      userId,
      keepHistory,
      product: raw.product || [],
      adItem: raw.adItem || [],
      content: raw.content || [],
      keyword: raw.keyword || [],
      crowd: raw.crowd || []
    });
  },
  // 预热:后台依次构建各视图,把解析缓存 + 结果缓存填满,首个用户请求即命中。
  prewarm: async (userId) => {
    const steps = [
      () => metrics.buildMeta(userId),
      () => metrics.buildProductView(userId, {}),
      () => metrics.buildAdProductsView(userId, {}),
      () => metrics.buildKeywordView(userId, {}),
      () => metrics.buildCrowdView(userId, {}),
      () => metrics.buildContentView(userId, {})
    ];
    for (const step of steps) {
      try {
        await step();
      } catch {
        /* 预热单步失败不影响其它,忽略 */
      }
    }
    return { ok: true };
  }
};

parentPort.on("message", async (msg) => {
  const { id, op, args } = msg;
  const handler = handlers[op];
  if (!handler) {
    parentPort.postMessage({ id, error: `unknown op: ${op}` });
    return;
  }
  try {
    const result = await handler(...(args || []));
    parentPort.postMessage({ id, result });
  } catch (e) {
    parentPort.postMessage({ id, error: e?.stack || e?.message || String(e) });
  }
});

// 让主线程知道 worker 已就绪
parentPort.postMessage({ ready: true });
