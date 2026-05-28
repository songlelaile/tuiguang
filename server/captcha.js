// 注册防刷验证码:服务端生成简单算术题,id 关联答案存内存,客户端把答案回带验证
//
// 算术题 vs 图形:文字题足够挡住普通脚本,实现零依赖,服务端无 canvas
// TTL 5 分钟;过期自动清理

import crypto from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const store = new Map(); // id -> { answer: number, expiresAt: number }

// 容易混淆的字符去掉(I/O/0/1)
const ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function genId() {
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

function prune() {
  const now = Date.now();
  for (const [id, item] of store.entries()) {
    if (item.expiresAt < now) store.delete(id);
  }
}

export function issueCaptcha() {
  prune();
  // 范围 1..20,加减乘三种;避免负数(减法做大减小);乘法两位数 ≤ 50
  const a = 1 + Math.floor(Math.random() * 20);
  const b = 1 + Math.floor(Math.random() * 20);
  const ops = ["+", "-", "×"];
  const op = ops[Math.floor(Math.random() * ops.length)];
  let x = a, y = b, answer;
  switch (op) {
    case "+": answer = a + b; break;
    case "-": if (a < b) { x = b; y = a; } answer = x - y; break;
    case "×": x = 1 + Math.floor(Math.random() * 9); y = 1 + Math.floor(Math.random() * 9); answer = x * y; break;
    default: answer = a + b;
  }
  const id = genId();
  store.set(id, { answer, expiresAt: Date.now() + TTL_MS });
  return { id, question: `${x} ${op} ${y} = ?` };
}

export function verifyCaptcha(id, answer) {
  if (!id || answer === undefined || answer === null) return false;
  const item = store.get(id);
  if (!item) return false;
  // 一次性:无论对错都删,避免暴力试同一题
  store.delete(id);
  if (item.expiresAt < Date.now()) return false;
  const parsed = typeof answer === "number" ? answer : Number(String(answer).trim());
  if (!Number.isFinite(parsed)) return false;
  return parsed === item.answer;
}

export function size() {
  return store.size;
}
