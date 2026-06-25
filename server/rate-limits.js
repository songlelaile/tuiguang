// 限流策略 — 防暴力破解 / 撞库 / 注册风暴
//
// 计数器在进程内存里。多实例部署需要换 redis-store(rate-limit-redis),
// 单进程 / docker compose 单容器场景这个版本足够。
//
// 注:Express 顶部要 `app.set('trust proxy', 1)`,否则代理后所有 IP = 127.0.0.1
// 我们容器前面有 nginx 反代,所以必须信任 1 层代理。

import rateLimit from "express-rate-limit";

// 登录:15 分钟内同 IP 最多 20 次失败(成功登录不消耗配额);LOGIN_RATE_MAX 可覆盖
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.LOGIN_RATE_MAX || 20),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: "尝试过于频繁,请 15 分钟后再试" }
});

// 注册:1 小时同 IP 最多 5 次
export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "注册请求过于频繁,请稍后再试" }
});

// SMS 发送:1 分钟同 IP 最多 3 次(已有 phone 维度限流,这是 IP 维度叠加)
export const smsSendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 3,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "请稍后再试" }
});
