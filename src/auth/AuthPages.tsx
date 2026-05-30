// 未登录态下的两个页面:LoginView + RegisterView
//
// 跟 main.tsx 解耦后,RootApp 不再直接知道它们的实现细节,只看 props
// RegisterView 从 URL hash 里解析 ?invite=XXX 自动预填邀请码字段

import React from "react";
import {
  authBtn,
  authCard,
  authError,
  authField,
  authInput,
  authLabel,
  authLink,
  authShell,
  authSub,
  authTitle
} from "./shared";
import type { AuthFeatures } from "./shared";

// ============ Login ============

export function LoginView({
  onAuthChange,
  features
}: {
  onAuthChange: () => Promise<void>;
  features: AuthFeatures;
}) {
  const [tab, setTab] = React.useState<"password" | "sms">("password");
  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1,
    padding: "10px 0",
    textAlign: "center",
    cursor: "pointer",
    borderBottom: active ? "2px solid #f5c877" : "2px solid transparent",
    color: active ? "#f5c877" : "rgba(245, 240, 223, 0.5)",
    fontWeight: 600,
    fontSize: 14,
    userSelect: "none"
  });
  return (
    <div style={authShell}>
      <div style={authCard}>
        <h1 style={authTitle}>货盘分析 BI</h1>
        <p style={authSub}>商品经营 / 推广投放 — 请登录</p>
        {features.sms_login && (
          <div style={{ display: "flex", marginBottom: 18, borderBottom: "1px solid rgba(245, 200, 119, 0.15)" }}>
            <div style={tabStyle(tab === "password")} onClick={() => setTab("password")}>
              账号密码
            </div>
            <div style={tabStyle(tab === "sms")} onClick={() => setTab("sms")}>
              手机短信
            </div>
          </div>
        )}
        {features.sms_login && tab === "sms" ? (
          <SmsLoginForm onAuthChange={onAuthChange} />
        ) : (
          <PasswordLoginForm onAuthChange={onAuthChange} />
        )}
        {features.open_registration && (
          <a href="#/register" style={authLink}>
            没有账号? 立即注册 →
          </a>
        )}
      </div>
    </div>
  );
}

function PasswordLoginForm({ onAuthChange }: { onAuthChange: () => Promise<void> }) {
  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [err, setErr] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || `登录失败 (HTTP ${res.status})`);
        return;
      }
      await onAuthChange();
      window.location.hash = "#product";
    } finally {
      setSubmitting(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <label style={authField}>
        <span style={authLabel}>用户名</span>
        <input style={authInput} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label style={authField}>
        <span style={authLabel}>密码</span>
        <input
          style={authInput}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {err && <div style={authError}>{err}</div>}
      <button type="submit" style={authBtn} disabled={submitting}>
        {submitting ? "登录中..." : "登录"}
      </button>
    </form>
  );
}

function SmsLoginForm({ onAuthChange }: { onAuthChange: () => Promise<void> }) {
  const [phone, setPhone] = React.useState("");
  const [code, setCode] = React.useState("");
  const [err, setErr] = React.useState("");
  const [info, setInfo] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [sending, setSending] = React.useState(false);
  const [cooldown, setCooldown] = React.useState(0);

  React.useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode() {
    setErr("");
    setInfo("");
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) {
      setErr("手机号格式不正确(11 位中国大陆号码)");
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/auth/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: phone.trim() })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || `发送失败 (HTTP ${res.status})`);
        return;
      }
      setCooldown(60);
      if (json.provider === "dev" && json.devCode) {
        setInfo(`[dev 模式] 验证码已生成:${json.devCode}(生产环境会发到手机)`);
      } else {
        setInfo("验证码已发送,请查收短信");
      }
    } finally {
      setSending(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr("");
    try {
      const res = await fetch("/api/auth/sms/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || `登录失败 (HTTP ${res.status})`);
        return;
      }
      await onAuthChange();
      window.location.hash = "#product";
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label style={authField}>
        <span style={authLabel}>手机号</span>
        <input
          style={authInput}
          autoFocus
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="11 位手机号"
          inputMode="numeric"
        />
      </label>
      <label style={authField}>
        <span style={authLabel}>短信验证码</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ ...authInput, flex: 1 }}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6 位验证码"
            inputMode="numeric"
            maxLength={6}
          />
          <button
            type="button"
            onClick={sendCode}
            disabled={sending || cooldown > 0}
            style={{
              padding: "10px 12px",
              borderRadius: 6,
              border: "1px solid rgba(245, 200, 119, 0.4)",
              background: "transparent",
              color: cooldown > 0 ? "rgba(245, 200, 119, 0.4)" : "#f5c877",
              fontSize: 13,
              cursor: cooldown > 0 ? "default" : "pointer",
              whiteSpace: "nowrap"
            }}
          >
            {cooldown > 0 ? `${cooldown}s` : sending ? "发送中..." : "获取验证码"}
          </button>
        </div>
      </label>
      {info && (
        <div
          style={{
            ...authError,
            background: "rgba(120, 200, 120, 0.12)",
            border: "1px solid rgba(120, 200, 120, 0.4)",
            color: "#a8d8a8"
          }}
        >
          {info}
        </div>
      )}
      {err && <div style={authError}>{err}</div>}
      <button type="submit" style={authBtn} disabled={submitting}>
        {submitting ? "登录中..." : "登录 / 注册"}
      </button>
    </form>
  );
}

// ============ Register ============

export function RegisterView({
  onAuthChange,
  features
}: {
  onAuthChange: () => Promise<void>;
  features: AuthFeatures;
}) {
  // URL `#/register?invite=XXX` 自动预填邀请码
  const initialInvite = React.useMemo(() => {
    const m = window.location.hash.match(/[?&]invite=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "";
  }, []);
  const inviteOnlyMode = !features.open_registration;

  const [username, setUsername] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [invite, setInvite] = React.useState(initialInvite);
  const [showInvite, setShowInvite] = React.useState(inviteOnlyMode || Boolean(initialInvite));
  const [captcha, setCaptcha] = React.useState<{ id: string; question: string } | null>(null);
  const [captchaAnswer, setCaptchaAnswer] = React.useState("");
  const [err, setErr] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const refreshCaptcha = React.useCallback(async () => {
    if (inviteOnlyMode) return;
    try {
      const res = await fetch("/api/auth/captcha", { credentials: "include" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setCaptcha({ id: json.id, question: json.question });
      setCaptchaAnswer("");
    } catch {
      setCaptcha(null);
    }
  }, [inviteOnlyMode]);

  React.useEffect(() => {
    refreshCaptcha();
  }, [refreshCaptcha]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setErr("两次输入的密码不一致");
      return;
    }
    if (inviteOnlyMode && !invite.trim()) {
      setErr("当前为邀请注册模式,请输入邀请码");
      return;
    }
    setSubmitting(true);
    setErr("");
    try {
      const body: Record<string, unknown> = { username, password, email: email || undefined };
      if (invite.trim()) {
        body.invite_code = invite.trim();
      } else {
        if (!captcha) {
          setErr("验证码尚未加载,请稍候");
          return;
        }
        body.captcha_id = captcha.id;
        body.captcha_answer = captchaAnswer;
      }
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(body)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(json.error || `注册失败 (HTTP ${res.status})`);
        if (!invite.trim() && !inviteOnlyMode) refreshCaptcha();
        return;
      }
      await onAuthChange();
      window.location.hash = "#product";
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={authShell}>
      <form onSubmit={submit} style={authCard}>
        <h1 style={{ ...authTitle, marginBottom: 24 }}>注册新账号</h1>
        <label style={authField}>
          <span style={authLabel}>用户名</span>
          <input
            style={authInput}
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </label>
        <label style={authField}>
          <span style={authLabel}>邮箱 (选填,用于将来密码找回)</span>
          <input
            style={authInput}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label style={authField}>
          <span style={authLabel}>密码 (至少 8 位)</span>
          <input
            style={authInput}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label style={authField}>
          <span style={authLabel}>确认密码</span>
          <input
            style={authInput}
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>

        {!inviteOnlyMode && !invite.trim() && (
          <label style={authField}>
            <span style={authLabel}>验证码 (回答下面的算术题)</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: 6,
                  border: "1px solid rgba(245, 200, 119, 0.2)",
                  background: "#10140c",
                  color: "#f5c877",
                  fontFamily: "monospace",
                  fontSize: 16,
                  minWidth: 110,
                  textAlign: "center"
                }}
              >
                {captcha?.question || "加载中..."}
              </div>
              <input
                style={{ ...authInput, flex: 1 }}
                value={captchaAnswer}
                onChange={(e) => setCaptchaAnswer(e.target.value)}
                placeholder="答案"
                inputMode="numeric"
              />
              <button
                type="button"
                onClick={refreshCaptcha}
                title="换一题"
                style={{
                  padding: "10px 12px",
                  borderRadius: 6,
                  border: "1px solid rgba(245, 200, 119, 0.3)",
                  background: "transparent",
                  color: "#f5c877",
                  cursor: "pointer",
                  fontSize: 13
                }}
              >
                换一题
              </button>
            </div>
          </label>
        )}

        {showInvite ? (
          <label style={authField}>
            <span style={authLabel}>
              {inviteOnlyMode ? "邀请码 (必填)" : "邀请码 (选填,有邀请码时优先用此通道)"}
            </span>
            <input style={authInput} value={invite} onChange={(e) => setInvite(e.target.value)} />
          </label>
        ) : (
          <a
            onClick={() => setShowInvite(true)}
            style={{ ...authLink, marginTop: 0, marginBottom: 10, cursor: "pointer" }}
          >
            有邀请码? 点这里填 →
          </a>
        )}

        {err && <div style={authError}>{err}</div>}
        <button type="submit" style={authBtn} disabled={submitting}>
          {submitting ? "注册中..." : "注册并登录"}
        </button>
        <a href="#/login" style={authLink}>
          已有账号? 去登录 →
        </a>
      </form>
    </div>
  );
}
