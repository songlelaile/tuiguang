// SMS 网关适配器
//
// 通过环境变量选 provider:
//   SMS_PROVIDER=dev      (默认) — 不发短信,验证码打到 console;给本地/没接网关时用
//   SMS_PROVIDER=aliyun   — 阿里云 dysmsapi;需 SMS_ALIYUN_* 系列 env
//
// 切换 provider 只需改 env,无需改业务代码。生产部署文档里说明对应 env。
//
// sendSms({ phone, code }) → { ok: boolean, dev?: boolean, error?: string }
//   失败时 throw,调用方拿到 5xx;成功不抛。

const PROVIDER = (process.env.SMS_PROVIDER || "dev").toLowerCase();

export async function sendSms({ phone, code }) {
  switch (PROVIDER) {
    case "aliyun":
      return await sendAliyun({ phone, code });
    case "dev":
    default:
      return sendDev({ phone, code });
  }
}

function sendDev({ phone, code }) {
  // 注意:仅 dev/本地用;生产务必切到真实 provider,否则验证码不会发到用户手机
  console.log(`[SMS:dev] → ${phone}  code=${code}  (10 分钟内有效;切到真实 provider 请设置 SMS_PROVIDER=aliyun + 凭据)`);
  return { ok: true, dev: true };
}

// ---- 阿里云 dysmsapi 适配器 ----
//
// 启用所需 env:
//   SMS_PROVIDER=aliyun
//   SMS_ALIYUN_ACCESS_KEY_ID=
//   SMS_ALIYUN_ACCESS_KEY_SECRET=
//   SMS_ALIYUN_SIGN_NAME=     例如 "货盘BI"(需在阿里云签名管理中申请通过)
//   SMS_ALIYUN_TEMPLATE_CODE= 例如 SMS_123456789(需在阿里云模板管理中申请通过)
//   SMS_ALIYUN_REGION=        默认 cn-hangzhou
//
// 模板示例:"您的验证码是 ${code},10 分钟内有效。"
//
// 实现:用阿里云 RPC v2 风格签名,无需安装 SDK。
//
// 文档:https://help.aliyun.com/document_detail/101343.html

async function sendAliyun({ phone, code }) {
  const accessKeyId = process.env.SMS_ALIYUN_ACCESS_KEY_ID;
  const accessKeySecret = process.env.SMS_ALIYUN_ACCESS_KEY_SECRET;
  const signName = process.env.SMS_ALIYUN_SIGN_NAME;
  const templateCode = process.env.SMS_ALIYUN_TEMPLATE_CODE;
  const region = process.env.SMS_ALIYUN_REGION || "cn-hangzhou";
  if (!accessKeyId || !accessKeySecret || !signName || !templateCode) {
    throw new Error("阿里云 SMS 配置不全:请检查 SMS_ALIYUN_ACCESS_KEY_ID/SECRET/SIGN_NAME/TEMPLATE_CODE");
  }

  const crypto = await import("node:crypto");
  const endpoint = `https://dysmsapi.aliyuncs.com/`;
  const params = {
    Format: "JSON",
    Version: "2017-05-25",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomBytes(16).toString("hex"),
    Timestamp: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    Action: "SendSms",
    RegionId: region,
    PhoneNumbers: phone,
    SignName: signName,
    TemplateCode: templateCode,
    TemplateParam: JSON.stringify({ code })
  };

  // 阿里云 V1 签名:percent-encode + 排序后拼串,HMAC-SHA1(keySecret&)
  const percentEncode = (s) =>
    encodeURIComponent(s)
      .replace(/!/g, "%21")
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29")
      .replace(/\*/g, "%2A");
  const sortedKeys = Object.keys(params).sort();
  const canonical = sortedKeys.map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join("&");
  const stringToSign = `GET&${percentEncode("/")}&${percentEncode(canonical)}`;
  const signature = crypto.createHmac("sha1", `${accessKeySecret}&`).update(stringToSign).digest("base64");

  const qs = `${canonical}&Signature=${percentEncode(signature)}`;
  const resp = await fetch(`${endpoint}?${qs}`, { method: "GET" });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!resp.ok || json.Code !== "OK") {
    throw new Error(`阿里云 SMS 失败:${json.Code || resp.status} ${json.Message || text}`);
  }
  return { ok: true };
}

export function activeProvider() {
  return PROVIDER;
}
