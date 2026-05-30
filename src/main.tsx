import React from "react";
import ReactDOM from "react-dom/client";
import { BarChart3, Boxes, Brain, FileSpreadsheet, Megaphone, Search, Upload, Users, WandSparkles, X } from "lucide-react";
import "./styles.css";
import { EChart } from "./ui/EChart";
import { DataTable, type ColumnDef } from "./ui/DataTable";
import { MetricCard } from "./ui/MetricCard";
import { WeeklyMatrix, type WeeklyMetric } from "./ui/WeeklyMatrix";
import { fmtInt, fmtMoney, fmtNumber, fmtPercent } from "./utils/format";

type ViewKey = "product" | "ad-products" | "keywords" | "crowds" | "contents" | "sources" | "admin";

type MetaSource = {
  id: string;
  name: string;
  file: string;
  rows: number;
  dateField: string;
  start: string;
  end: string;
  uploaded?: boolean;
  mode?: "default" | "uploaded" | "empty";
  cleared?: boolean;
};

type AlignmentStatus = "aligned" | "partial" | "mismatch" | "incomplete";

type AlignmentWarning = {
  table: string;
  label: string;
  kind: "extends_start" | "extends_end" | "missing";
  diffDays: number;
  message: string;
};

type Alignment = {
  status: AlignmentStatus;
  intersection: { start: string; end: string };
  union: { start: string; end: string };
  perTable: Record<string, { start: string; end: string }>;
  missing: string[];
  warnings: AlignmentWarning[];
};

type Meta = {
  dataDir: string;
  uploadDir?: string;
  sourceDataCleared?: boolean;
  sources: MetaSource[];
  alignment?: Alignment;
  scenes: string[];
  scenesByView?: Partial<Record<ViewKey, string[]>>;
};

type AnyRecord = Record<string, unknown>;
type ProductDrilldown = "payDaily" | "netFeeDaily";
type AdProductDrilldown = "spendDaily" | "gmvDaily" | "roiDaily";
type KeywordDrilldown = "spendDaily";
type CrowdDrilldown = "spendDaily";
type ContentDrilldown = "spendDaily";

const navItems: Array<{ key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }>; adminOnly?: boolean }> = [
  { key: "product", label: "商品维度分析", icon: Boxes },
  { key: "ad-products", label: "推广商品分析", icon: Megaphone },
  { key: "keywords", label: "推广关键词分析", icon: Search },
  { key: "crowds", label: "推广人群分析", icon: Users },
  { key: "contents", label: "推广内容分析", icon: WandSparkles },
  { key: "sources", label: "源数据", icon: FileSpreadsheet },
  { key: "admin", label: "管理", icon: Brain, adminOnly: true }
];

const sourceUploadSlots = [
  { id: "product", label: "商品维度", accept: ".xlsx,.xls", hint: "XLSX / XLS" },
  { id: "adItem", label: "推广商品", accept: ".csv", hint: "CSV" },
  { id: "keyword", label: "推广关键词", accept: ".csv", hint: "CSV" },
  { id: "crowd", label: "推广人群", accept: ".csv", hint: "CSV" },
  { id: "content", label: "推广内容", accept: ".csv", hint: "CSV" }
];

const endpoints: Partial<Record<ViewKey, string>> = {
  product: "/api/product",
  "ad-products": "/api/ad-products",
  keywords: "/api/keywords",
  crowds: "/api/crowds",
  contents: "/api/contents"
};

function viewFromHash(): ViewKey {
  const key = window.location.hash.replace(/^#\/?/, "");
  return navItems.some((item) => item.key === key) ? (key as ViewKey) : "product";
}

// ---- P0.2 + P2.2 时间窗口 + 多种对比方式 -----------------------------------

type ComparePreset = "" | "prev" | "WoW" | "MoM" | "YoY";

const comparePresetLabels: Record<ComparePreset, string> = {
  "": "关闭对比",
  prev: "前一周期",
  WoW: "上周同期 (WoW)",
  MoM: "上月同期 (MoM)",
  YoY: "去年同期 (YoY)"
};

function DrillToolbar({
  total,
  windowSize,
  setWindowSize,
  preset,
  setPreset,
  canPrev,
  remoteAvailable,
  remoteLoading,
  remoteEmpty,
  presets = [7, 14, 30]
}: {
  total: number;
  windowSize: number;
  setWindowSize: (n: number) => void;
  preset: ComparePreset;
  setPreset: (p: ComparePreset) => void;
  canPrev: boolean;
  remoteAvailable: boolean;
  remoteLoading?: boolean;
  remoteEmpty?: boolean;
  presets?: number[];
}) {
  const options = Array.from(new Set([...presets.filter((p) => p < total), total])).sort((a, b) => a - b);
  return (
    <div className="drillToolbar">
      <div className="drillWindowGroup">
        {options.map((w) => (
          <button
            key={w}
            type="button"
            className={`drillWindowBtn ${w === windowSize ? "active" : ""}`}
            onClick={() => setWindowSize(w)}
          >
            {w === total ? `全部 ${total} 天` : `近 ${w} 天`}
          </button>
        ))}
      </div>
      <div className="drillCompareSelector">
        <span className="drillCompareLabel">对比</span>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as ComparePreset)}
          className="drillCompareSelect"
        >
          <option value="">{comparePresetLabels[""]}</option>
          <option value="prev" disabled={!canPrev}>{comparePresetLabels.prev}{canPrev ? "" : "（前段不足）"}</option>
          <option value="WoW" disabled={!remoteAvailable}>{comparePresetLabels.WoW}{remoteAvailable ? "" : "（需历史库）"}</option>
          <option value="MoM" disabled={!remoteAvailable}>{comparePresetLabels.MoM}{remoteAvailable ? "" : "（需历史库）"}</option>
          <option value="YoY" disabled={!remoteAvailable}>{comparePresetLabels.YoY}{remoteAvailable ? "" : "（需历史库）"}</option>
        </select>
        {remoteLoading && <span className="drillCompareHint">加载中…</span>}
        {remoteEmpty && !remoteLoading && <span className="drillCompareHint warn">该时段历史库无数据</span>}
      </div>
    </div>
  );
}

type ExtraMetric = {
  key: string;
  label: string;
  axis: "money" | "ratio";
  color: string;
};

type DrillWindowSlice = {
  main: AnyRecord[];
  compare: AnyRecord[] | null;
  extras?: ExtraMetric[];
  windowSize: number;
};

function sliceDrillWindow(rows: AnyRecord[], windowSize: number, compare: boolean): DrillWindowSlice {
  const total = rows.length;
  const actual = windowSize > 0 && windowSize < total ? windowSize : total;
  const main = actual >= total ? rows : rows.slice(-actual);
  const compareRows = compare && actual * 2 <= total ? rows.slice(-actual * 2, -actual) : null;
  return { main, compare: compareRows, windowSize: actual };
}

function buildCompareLineSeries(
  name: string,
  compareRows: AnyRecord[] | null,
  mainLength: number,
  getValue: (row: AnyRecord) => number | null,
  options: { color?: string; yAxisIndex?: number } = {}
): unknown[] {
  if (!compareRows || !compareRows.length) return [];
  const padding = Array(Math.max(0, mainLength - compareRows.length)).fill(null);
  const values = compareRows.map(getValue);
  return [
    {
      name: `对比·${name}`,
      type: "line",
      smooth: true,
      symbol: "none",
      yAxisIndex: options.yAxisIndex ?? 0,
      lineStyle: { color: options.color || "rgba(245, 240, 223, 0.5)", width: 2, type: "dashed" },
      itemStyle: { color: options.color || "rgba(245, 240, 223, 0.5)" },
      data: [...padding, ...values]
    }
  ];
}

type CompareEndpoint = {
  view: "ad" | "product";
  metric: string;
  metricKey: string;  // 远端返回 {date, value}；前端 reshape 成 {date, [metricKey]: value} 以兼容 buildOption
};

function DrillChart({
  rows,
  buildOption,
  defaultWindow = 0,
  compareEndpoint,
  availableExtras
}: {
  rows: AnyRecord[];
  buildOption: (slice: DrillWindowSlice) => unknown;
  defaultWindow?: number;
  compareEndpoint?: CompareEndpoint;
  availableExtras?: ExtraMetric[];
}) {
  const [windowSize, setWindowSize] = React.useState(defaultWindow);
  const [preset, setPreset] = React.useState<ComparePreset>("");
  const [remoteCompare, setRemoteCompare] = React.useState<AnyRecord[] | null>(null);
  const [remoteLoading, setRemoteLoading] = React.useState(false);
  const [selectedExtras, setSelectedExtras] = React.useState<string[]>([]);

  const localSlice = sliceDrillWindow(rows, windowSize, preset === "prev");
  const mainStart = localSlice.main[0]?.date as string | undefined;
  const mainEnd = localSlice.main[localSlice.main.length - 1]?.date as string | undefined;
  const canPrev = localSlice.windowSize * 2 <= rows.length;
  const remoteAvailable = Boolean(compareEndpoint && mainStart && mainEnd);

  React.useEffect(() => {
    if (!remoteAvailable || !compareEndpoint || preset === "" || preset === "prev") {
      setRemoteCompare(null);
      setRemoteLoading(false);
      return;
    }
    setRemoteLoading(true);
    const ctrl = new AbortController();
    const params = new URLSearchParams({
      view: compareEndpoint.view,
      metric: compareEndpoint.metric,
      start: String(mainStart),
      end: String(mainEnd),
      preset
    });
    fetch(`/api/history/compare?${params}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((json) => {
        const days = (json.compare?.days || []) as Array<{ date: string; value: number | null }>;
        const remapped = days.map((d) => ({ date: d.date, [compareEndpoint.metricKey]: d.value }));
        setRemoteCompare(remapped);
        setRemoteLoading(false);
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setRemoteCompare([]);
          setRemoteLoading(false);
        }
      });
    return () => ctrl.abort();
  }, [preset, mainStart, mainEnd, remoteAvailable, compareEndpoint?.view, compareEndpoint?.metric, compareEndpoint?.metricKey]);

  // 自动回退：若用户选择 prev 但前段不足，强制回到关闭
  React.useEffect(() => {
    if (preset === "prev" && !canPrev) setPreset("");
  }, [preset, canPrev]);

  const finalCompare = preset === "prev"
    ? localSlice.compare
    : (preset === "WoW" || preset === "MoM" || preset === "YoY")
      ? remoteCompare
      : null;

  const activeExtras = availableExtras?.filter((m) => selectedExtras.includes(m.key)) ?? [];
  const sliceForBuild: DrillWindowSlice = {
    main: localSlice.main,
    compare: finalCompare,
    extras: activeExtras,
    windowSize: localSlice.windowSize
  };
  const option = buildOption(sliceForBuild);
  const remoteEmpty = Boolean(
    (preset === "WoW" || preset === "MoM" || preset === "YoY") && !remoteLoading && remoteCompare && remoteCompare.length === 0
  );

  return (
    <div className="drillChartWrap">
      <DrillToolbar
        total={rows.length}
        windowSize={localSlice.windowSize}
        setWindowSize={setWindowSize}
        preset={preset}
        setPreset={setPreset}
        canPrev={canPrev}
        remoteAvailable={remoteAvailable}
        remoteLoading={remoteLoading}
        remoteEmpty={remoteEmpty}
      />
      {availableExtras && availableExtras.length > 0 && (
        <div className="drillExtrasRow">
          <span className="drillExtrasLabel">叠加指标</span>
          {availableExtras.map((metric) => {
            const active = selectedExtras.includes(metric.key);
            return (
              <button
                key={metric.key}
                type="button"
                className={`drillExtrasChip ${active ? "active" : ""}`}
                style={active ? { borderColor: metric.color, color: metric.color, background: `${metric.color}1a` } : undefined}
                onClick={() =>
                  setSelectedExtras((prev) =>
                    prev.includes(metric.key) ? prev.filter((k) => k !== metric.key) : [...prev, metric.key]
                  )
                }
              >
                {metric.label}
              </button>
            );
          })}
        </div>
      )}
      <EChart height={420} option={option} />
    </div>
  );
}

const productWeeklyMetrics: WeeklyMetric[] = [
  { key: "pay", label: "支付金额", format: fmtMoney },
  { key: "visitors", label: "商品访客", format: fmtInt },
  { key: "conversionRate", label: "转化率", format: fmtPercent },
  { key: "customerPrice", label: "客单价", format: fmtNumber },
  { key: "netFeeRatio", label: "去退费比", format: fmtPercent },
  { key: "refundRatio", label: "退款金额占比", format: fmtPercent },
  { key: "repeatRate", label: "复购率", format: fmtPercent },
  { key: "repeatPayRatio", label: "复购金额占比", format: fmtPercent },
  { key: "cartRate", label: "加购率", format: fmtPercent },
  { key: "pvPerVisitor", label: "人均浏览量", format: fmtNumber },
  { key: "netRoi", label: "链接净ROI", format: fmtNumber }
];

function buildQuery(filters: Filters) {
  const params = new URLSearchParams();
  if (filters.start) params.set("start", filters.start);
  if (filters.end) params.set("end", filters.end);
  if (filters.scene) params.set("scene", filters.scene);
  if (filters.q) params.set("q", filters.q);
  const text = params.toString();
  return text ? `?${text}` : "";
}

type Filters = {
  start: string;
  end: string;
  scene: string;
  q: string;
};

function useApi<T>(active: ViewKey, filters: Filters) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const endpoint = endpoints[active];
    if (!endpoint) {
      setData(null);
      setError("");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    setData(null);
    fetch(`${endpoint}${buildQuery(filters)}`)
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        return res.json();
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active, filters.start, filters.end, filters.scene, filters.q]);

  return { data, loading, error };
}

// =============================================================
// 账号系统 (P4):登录 / 邀请码注册 / 管理员后台
// =============================================================

type User = {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: "active" | "disabled";
};

type AuthFeatures = {
  open_registration: boolean;
  sms_login: boolean;
  sms_provider: string;
};

const DEFAULT_FEATURES: AuthFeatures = { open_registration: true, sms_login: true, sms_provider: "dev" };

type AuthState = {
  user: User | null;
  loading: boolean;
  features: AuthFeatures;
  refresh: () => Promise<void>;
};

function useAuth(): AuthState {
  const [user, setUser] = React.useState<User | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [features, setFeatures] = React.useState<AuthFeatures>(DEFAULT_FEATURES);
  const refresh = React.useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      if (res.ok) {
        const json = await res.json();
        setUser(json.user || null);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  React.useEffect(() => {
    refresh();
    fetch("/api/auth/features", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => { if (json) setFeatures({ ...DEFAULT_FEATURES, ...json }); })
      .catch(() => { /* 失败时维持默认全开,体验最差不过是个按钮无效 */ });
  }, [refresh]);
  return { user, loading, features, refresh };
}

const authShell: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "#10140c",
  padding: 16
};
const authCard: React.CSSProperties = {
  width: 380,
  padding: 32,
  borderRadius: 12,
  border: "1px solid rgba(245, 200, 119, 0.22)",
  background: "#151808",
  boxShadow: "0 18px 40px rgba(0,0,0,0.45)"
};
const authTitle: React.CSSProperties = { margin: 0, marginBottom: 4, fontSize: 22, color: "#f5c877" };
const authSub: React.CSSProperties = { margin: 0, marginBottom: 24, fontSize: 13, color: "rgba(245, 240, 223, 0.65)" };
const authField: React.CSSProperties = { display: "block", marginBottom: 14 };
const authLabel: React.CSSProperties = { display: "block", marginBottom: 6, fontSize: 12, color: "rgba(245, 240, 223, 0.7)" };
const authInput: React.CSSProperties = {
  width: "100%", padding: "10px 12px", borderRadius: 6,
  border: "1px solid rgba(245, 200, 119, 0.2)", background: "#10140c", color: "#f5f0df", fontSize: 14
};
const authBtn: React.CSSProperties = {
  width: "100%", padding: "11px 12px", borderRadius: 6, border: "none",
  background: "#f5c877", color: "#10140c", fontWeight: 600, fontSize: 14, cursor: "pointer", marginTop: 8
};
const authLink: React.CSSProperties = {
  display: "block", textAlign: "center", marginTop: 16, fontSize: 13, color: "#f5c877", textDecoration: "none"
};
const authError: React.CSSProperties = {
  marginTop: 8, marginBottom: 4, padding: "8px 10px", borderRadius: 6,
  background: "rgba(229, 80, 80, 0.12)", border: "1px solid rgba(229, 80, 80, 0.4)", color: "#ffb3b3", fontSize: 13
};

function LoginView({ onAuthChange, features }: { onAuthChange: () => Promise<void>; features: AuthFeatures }) {
  const [tab, setTab] = React.useState<"password" | "sms">("password");
  const tabStyle = (active: boolean): React.CSSProperties => ({
    flex: 1, padding: "10px 0", textAlign: "center", cursor: "pointer",
    borderBottom: active ? "2px solid #f5c877" : "2px solid transparent",
    color: active ? "#f5c877" : "rgba(245, 240, 223, 0.5)",
    fontWeight: 600, fontSize: 14, userSelect: "none"
  });
  return (
    <div style={authShell}>
      <div style={authCard}>
        <h1 style={authTitle}>货盘分析 BI</h1>
        <p style={authSub}>商品经营 / 推广投放 — 请登录</p>
        {features.sms_login && (
          <div style={{ display: "flex", marginBottom: 18, borderBottom: "1px solid rgba(245, 200, 119, 0.15)" }}>
            <div style={tabStyle(tab === "password")} onClick={() => setTab("password")}>账号密码</div>
            <div style={tabStyle(tab === "sms")} onClick={() => setTab("sms")}>手机短信</div>
          </div>
        )}
        {features.sms_login && tab === "sms" ? <SmsLoginForm onAuthChange={onAuthChange} /> : <PasswordLoginForm onAuthChange={onAuthChange} />}
        {features.open_registration && <a href="#/register" style={authLink}>没有账号? 立即注册 →</a>}
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
      if (!res.ok) { setErr(json.error || `登录失败 (HTTP ${res.status})`); return; }
      await onAuthChange();
      window.location.hash = "#product";
    } finally { setSubmitting(false); }
  }
  return (
    <form onSubmit={submit}>
      <label style={authField}>
        <span style={authLabel}>用户名</span>
        <input style={authInput} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
      </label>
      <label style={authField}>
        <span style={authLabel}>密码</span>
        <input style={authInput} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
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
    setErr(""); setInfo("");
    if (!/^1[3-9]\d{9}$/.test(phone.trim())) { setErr("手机号格式不正确(11 位中国大陆号码)"); return; }
    setSending(true);
    try {
      const res = await fetch("/api/auth/sms/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: phone.trim() })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error || `发送失败 (HTTP ${res.status})`); return; }
      setCooldown(60);
      if (json.provider === "dev" && json.devCode) {
        setInfo(`[dev 模式] 验证码已生成:${json.devCode}(生产环境会发到手机)`);
      } else {
        setInfo("验证码已发送,请查收短信");
      }
    } finally { setSending(false); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true); setErr("");
    try {
      const res = await fetch("/api/auth/sms/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ phone: phone.trim(), code: code.trim() })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(json.error || `登录失败 (HTTP ${res.status})`); return; }
      await onAuthChange();
      window.location.hash = "#product";
    } finally { setSubmitting(false); }
  }

  return (
    <form onSubmit={submit}>
      <label style={authField}>
        <span style={authLabel}>手机号</span>
        <input style={authInput} autoFocus value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11 位手机号" inputMode="numeric" />
      </label>
      <label style={authField}>
        <span style={authLabel}>短信验证码</span>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ ...authInput, flex: 1 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="6 位验证码" inputMode="numeric" maxLength={6} />
          <button type="button" onClick={sendCode} disabled={sending || cooldown > 0}
            style={{
              padding: "10px 12px", borderRadius: 6, border: "1px solid rgba(245, 200, 119, 0.4)",
              background: "transparent", color: cooldown > 0 ? "rgba(245, 200, 119, 0.4)" : "#f5c877",
              fontSize: 13, cursor: cooldown > 0 ? "default" : "pointer", whiteSpace: "nowrap"
            }}>
            {cooldown > 0 ? `${cooldown}s` : sending ? "发送中..." : "获取验证码"}
          </button>
        </div>
      </label>
      {info && <div style={{ ...authError, background: "rgba(120, 200, 120, 0.12)", border: "1px solid rgba(120, 200, 120, 0.4)", color: "#a8d8a8" }}>{info}</div>}
      {err && <div style={authError}>{err}</div>}
      <button type="submit" style={authBtn} disabled={submitting}>
        {submitting ? "登录中..." : "登录 / 注册"}
      </button>
    </form>
  );
}

function RegisterView({ onAuthChange, features }: { onAuthChange: () => Promise<void>; features: AuthFeatures }) {
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
    } catch (e) {
      setCaptcha(null);
    }
  }, [inviteOnlyMode]);

  React.useEffect(() => { refreshCaptcha(); }, [refreshCaptcha]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setErr("两次输入的密码不一致"); return; }
    if (inviteOnlyMode && !invite.trim()) { setErr("当前为邀请注册模式,请输入邀请码"); return; }
    setSubmitting(true);
    setErr("");
    try {
      const body: Record<string, unknown> = { username, password, email: email || undefined };
      if (invite.trim()) {
        body.invite_code = invite.trim();
      } else {
        if (!captcha) { setErr("验证码尚未加载,请稍候"); return; }
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
    } finally { setSubmitting(false); }
  }

  return (
    <div style={authShell}>
      <form onSubmit={submit} style={authCard}>
        <h1 style={{ ...authTitle, marginBottom: 24 }}>注册新账号</h1>
        <label style={authField}>
          <span style={authLabel}>用户名</span>
          <input style={authInput} autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <label style={authField}>
          <span style={authLabel}>邮箱 (选填,用于将来密码找回)</span>
          <input style={authInput} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label style={authField}>
          <span style={authLabel}>密码 (至少 8 位)</span>
          <input style={authInput} type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label style={authField}>
          <span style={authLabel}>确认密码</span>
          <input style={authInput} type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>

        {!inviteOnlyMode && !invite.trim() && (
          <label style={authField}>
            <span style={authLabel}>验证码 (回答下面的算术题)</span>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                padding: "10px 14px", borderRadius: 6,
                border: "1px solid rgba(245, 200, 119, 0.2)", background: "#10140c",
                color: "#f5c877", fontFamily: "monospace", fontSize: 16, minWidth: 110, textAlign: "center"
              }}>{captcha?.question || "加载中..."}</div>
              <input style={{ ...authInput, flex: 1 }} value={captchaAnswer}
                onChange={(e) => setCaptchaAnswer(e.target.value)}
                placeholder="答案" inputMode="numeric" />
              <button type="button" onClick={refreshCaptcha} title="换一题"
                style={{
                  padding: "10px 12px", borderRadius: 6, border: "1px solid rgba(245, 200, 119, 0.3)",
                  background: "transparent", color: "#f5c877", cursor: "pointer", fontSize: 13
                }}>换一题</button>
            </div>
          </label>
        )}

        {showInvite ? (
          <label style={authField}>
            <span style={authLabel}>{inviteOnlyMode ? "邀请码 (必填)" : "邀请码 (选填,有邀请码时优先用此通道)"}</span>
            <input style={authInput} value={invite} onChange={(e) => setInvite(e.target.value)} />
          </label>
        ) : (
          <a onClick={() => setShowInvite(true)} style={{ ...authLink, marginTop: 0, marginBottom: 10, cursor: "pointer" }}>
            有邀请码? 点这里填 →
          </a>
        )}

        {err && <div style={authError}>{err}</div>}
        <button type="submit" style={authBtn} disabled={submitting}>
          {submitting ? "注册中..." : "注册并登录"}
        </button>
        <a href="#/login" style={authLink}>已有账号? 去登录 →</a>
      </form>
    </div>
  );
}

type Invite = {
  code: string; created_by: number; created_at: string;
  expires_at: string | null; max_uses: number; used_count: number;
  note: string | null; created_by_username: string | null;
};

type AdminUser = User & { created_at?: string; last_seen_at?: string | null };

function AdminView() {
  const [tab, setTab] = React.useState<"invites" | "users">("invites");
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [note, setNote] = React.useState("");
  const [maxUses, setMaxUses] = React.useState(1);

  const reload = React.useCallback(async () => {
    setLoading(true); setErr("");
    try {
      if (tab === "invites") {
        const res = await fetch("/api/admin/invites", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setInvites(json.invites || []);
      } else {
        const res = await fetch("/api/admin/users", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setUsers(json.users || []);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally { setLoading(false); }
  }, [tab]);
  React.useEffect(() => { reload(); }, [reload]);

  async function createInvite() {
    setErr("");
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ max_uses: maxUses, note: note || undefined })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      setNote(""); setMaxUses(1); await reload();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "操作失败"); }
  }
  async function deleteInvite(code: string) {
    if (!window.confirm(`确定删除邀请码 ${code}?`)) return;
    setErr("");
    try {
      const res = await fetch(`/api/admin/invites/${encodeURIComponent(code)}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await reload();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "操作失败"); }
  }
  async function updateUserStatus(id: number, status: "active" | "disabled") {
    setErr("");
    try {
      const res = await fetch(`/api/admin/users/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await reload();
    } catch (e: unknown) { setErr(e instanceof Error ? e.message : "操作失败"); }
  }
  const registerUrlFor = (code: string) =>
    `${window.location.origin}/#/register?invite=${encodeURIComponent(code)}`;

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "8px 14px", borderRadius: 6,
    border: "1px solid rgba(245, 200, 119, 0.3)",
    background: active ? "#f5c877" : "transparent",
    color: active ? "#10140c" : "#f5f0df",
    cursor: "pointer", fontWeight: 600
  });
  const th: React.CSSProperties = { textAlign: "left", padding: "10px 8px" };
  const td: React.CSSProperties = { padding: "10px 8px" };
  const muted: React.CSSProperties = { fontSize: 12, color: "rgba(245,240,223,0.7)" };

  return (
    <div style={{ padding: "8px 0 32px" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <button onClick={() => setTab("invites")} style={tabBtn(tab === "invites")}>邀请码</button>
        <button onClick={() => setTab("users")} style={tabBtn(tab === "users")}>用户列表</button>
      </div>
      {err && <div style={authError}>{err}</div>}

      {tab === "invites" && (
        <div>
          <div style={{
            padding: 16, borderRadius: 10, border: "1px solid rgba(245, 200, 119, 0.18)",
            background: "#151808", marginBottom: 18,
            display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap"
          }}>
            <label style={{ flex: 1, minWidth: 200 }}>
              <span style={authLabel}>说明 (选填)</span>
              <input style={authInput} value={note} onChange={(e) => setNote(e.target.value)} placeholder="给谁用 / 备注" />
            </label>
            <label style={{ width: 140 }}>
              <span style={authLabel}>可用次数</span>
              <input style={authInput} type="number" min={1} value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <button onClick={createInvite} style={{ ...authBtn, width: "auto", padding: "10px 18px", marginTop: 0 }}>
              生成邀请码
            </button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.2)", color: "rgba(245, 240, 223, 0.7)", fontSize: 12 }}>
                <th style={th}>邀请码</th><th style={th}>注册链接</th><th style={th}>用量</th>
                <th style={th}>创建时间</th><th style={th}>说明</th><th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} style={td}>加载中...</td></tr>}
              {!loading && invites.length === 0 && (
                <tr><td colSpan={6} style={{ ...td, color: "rgba(245,240,223,0.5)" }}>还没有邀请码,点上方按钮生成一个</td></tr>
              )}
              {invites.map((inv) => (
                <tr key={inv.code} style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.08)" }}>
                  <td style={{ ...td, fontFamily: "monospace", color: "#f5c877" }}>{inv.code}</td>
                  <td style={td}>
                    <button onClick={() => navigator.clipboard?.writeText(registerUrlFor(inv.code))}
                      style={{
                        border: "1px solid rgba(245, 200, 119, 0.3)", background: "transparent",
                        color: "#f5c877", padding: "4px 8px", borderRadius: 4, cursor: "pointer", fontSize: 12
                      }}>复制注册链接</button>
                  </td>
                  <td style={td}>{inv.used_count} / {inv.max_uses}</td>
                  <td style={{ ...td, ...muted }}>{inv.created_at.slice(0, 19).replace("T", " ")}</td>
                  <td style={{ ...td, fontSize: 12 }}>{inv.note || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => deleteInvite(inv.code)}
                      style={{
                        border: "1px solid rgba(229, 80, 80, 0.4)", background: "transparent",
                        color: "#ffb3b3", padding: "4px 10px", borderRadius: 4, cursor: "pointer"
                      }}>删除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === "users" && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.2)", color: "rgba(245, 240, 223, 0.7)", fontSize: 12 }}>
              <th style={th}>ID</th><th style={th}>用户名</th><th style={th}>邮箱</th>
              <th style={th}>角色</th><th style={th}>状态</th>
              <th style={th}>注册时间</th><th style={th}>最近登录</th><th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={td}>加载中...</td></tr>}
            {!loading && users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.08)" }}>
                <td style={td}>{u.id}</td>
                <td style={td}>{u.username}</td>
                <td style={{ ...td, ...muted }}>{u.email || "—"}</td>
                <td style={td}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 4,
                    background: u.role === "admin" ? "rgba(245, 200, 119, 0.15)" : "rgba(245, 240, 223, 0.08)",
                    color: u.role === "admin" ? "#f5c877" : "#f5f0df", fontSize: 12
                  }}>{u.role}</span>
                </td>
                <td style={td}>
                  <span style={{
                    padding: "2px 8px", borderRadius: 4,
                    background: u.status === "active" ? "rgba(120, 200, 120, 0.15)" : "rgba(229, 80, 80, 0.15)",
                    color: u.status === "active" ? "#a8d8a8" : "#ffb3b3", fontSize: 12
                  }}>{u.status}</span>
                </td>
                <td style={{ ...td, ...muted }}>{u.created_at?.slice(0, 10) || "—"}</td>
                <td style={{ ...td, ...muted }}>{u.last_seen_at?.slice(0, 19).replace("T", " ") || "—"}</td>
                <td style={{ ...td, textAlign: "right" }}>
                  <button onClick={() => updateUserStatus(u.id, u.status === "active" ? "disabled" : "active")}
                    style={{
                      border: "1px solid rgba(245, 200, 119, 0.3)", background: "transparent",
                      color: "#f5c877", padding: "4px 10px", borderRadius: 4, cursor: "pointer", fontSize: 12
                    }}>{u.status === "active" ? "禁用" : "启用"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RootApp() {
  const auth = useAuth();
  const [hash, setHash] = React.useState(window.location.hash);
  React.useEffect(() => {
    const onHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (auth.loading) {
    return (
      <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#10140c", color: "#f5c877" }}>
        <span>正在加载...</span>
      </div>
    );
  }
  if (!auth.user) {
    const route = hash.replace(/^#\/?/, "").split("?")[0];
    if (route === "register") return <RegisterView onAuthChange={auth.refresh} features={auth.features} />;
    return <LoginView onAuthChange={auth.refresh} features={auth.features} />;
  }
  return <App auth={auth} />;
}

async function logout(refresh: () => Promise<void>) {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
  await refresh();
  window.location.hash = "#/login";
}

function App({ auth }: { auth: AuthState }) {
  const [active, setActive] = React.useState<ViewKey>(() => viewFromHash());
  const [filters, setFilters] = React.useState<Filters>({ start: "", end: "", scene: "", q: "" });
  const [meta, setMeta] = React.useState<Meta | null>(null);
  // useApi 内部对 endpoints[active] 不存在的 view (sources / admin) 会短路,不发请求
  const { data, loading, error } = useApi<Record<string, unknown>>(active, filters);

  // 守卫:非 admin 闯入 #admin → 弹回商品页
  React.useEffect(() => {
    if (active === "admin" && auth.user?.role !== "admin") {
      window.location.hash = "#product";
    }
  }, [active, auth.user?.role]);

  React.useEffect(() => {
    fetch("/api/meta", { credentials: "include" })
      .then((res) => res.json())
      .then(setMeta)
      .catch(() => setMeta(null));
  }, []);

  React.useEffect(() => {
    const handleHashChange = () => setActive(viewFromHash());
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  const activeTitle = navItems.find((item) => item.key === active)?.label || "货盘分析 BI";
  const sceneOptions = meta?.scenesByView?.[active] || [];

  React.useEffect(() => {
    if (filters.scene && !sceneOptions.includes(filters.scene)) {
      setFilters((prev) => ({ ...prev, scene: "" }));
    }
  }, [active, filters.scene, sceneOptions]);

  function activateView(key: ViewKey) {
    setActive(key);
    setFilters((prev) => ({ ...prev, q: "" }));
    if (window.location.hash !== `#${key}`) {
      window.location.hash = key;
    }
  }

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">
            <BarChart3 size={22} />
          </div>
          <div>
            <strong>货盘分析 BI</strong>
            <span>商品经营 / 推广投放</span>
          </div>
        </div>
        <nav className="navList" aria-label="主导航">
          {navItems
            .filter((item) => !item.adminOnly || auth.user?.role === "admin")
            .map((item) => {
              const Icon = item.icon;
              return (
                <button key={item.key} className={active === item.key ? "navItem active" : "navItem"} onClick={() => activateView(item.key)}>
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
        </nav>
        <div className="sourceBadge">
          <Upload size={16} />
          <span>{meta ? `${meta.sources.length} 张源表已接入` : "读取源表中"}</span>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Web 端展示</p>
            <h1>{activeTitle}</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginRight: 16, fontSize: 13 }}>
            <span style={{ color: "rgba(245, 240, 223, 0.6)" }}>登录:</span>
            <strong style={{ color: "#f5c877" }}>{auth.user?.username}</strong>
            {auth.user?.role === "admin" && (
              <span style={{
                fontSize: 11, padding: "2px 8px", borderRadius: 4,
                background: "rgba(245, 200, 119, 0.18)", color: "#f5c877"
              }}>admin</span>
            )}
            <button
              onClick={() => logout(auth.refresh)}
              style={{
                marginLeft: 8, padding: "4px 10px", borderRadius: 4, cursor: "pointer",
                border: "1px solid rgba(245, 200, 119, 0.3)", background: "transparent",
                color: "#f5f0df", fontSize: 12
              }}
            >退出</button>
          </div>
          <div className="filters">
            <label>
              <span>开始</span>
              <input type="date" value={filters.start} onChange={(event) => setFilters((prev) => ({ ...prev, start: event.target.value }))} />
            </label>
            <label>
              <span>结束</span>
              <input type="date" value={filters.end} onChange={(event) => setFilters((prev) => ({ ...prev, end: event.target.value }))} />
            </label>
            {sceneOptions.length > 0 && (
              <label>
                <span>场景</span>
                <select value={filters.scene} onChange={(event) => setFilters((prev) => ({ ...prev, scene: event.target.value }))}>
                  <option value="">全部</option>
                  {sceneOptions.map((scene) => (
                    <option key={scene} value={scene}>
                      {scene}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="searchBox">
              <span>搜索</span>
              <input value={filters.q} placeholder="商品 / 计划 / 人群 / 词" onChange={(event) => setFilters((prev) => ({ ...prev, q: event.target.value }))} />
            </label>
            {endpoints[active] && (
              <a
                className="exportButton"
                href={`${endpoints[active]}/export${buildQuery(filters)}`}
                download
                title="按当前筛选导出 xlsx"
              >
                导出 Excel
              </a>
            )}
          </div>
        </header>

        {loading && <div className="stateLine">正在按当前筛选重算指标...</div>}
        {error && <div className="stateLine error">数据服务异常：{error}</div>}
        {!error && active === "sources" && <SourcesView meta={meta} onMetaChange={setMeta} />}
        {!error && active === "admin" && auth.user?.role === "admin" && <AdminView />}
        {!error && active === "product" && data && <ProductView data={data} />}
        {!error && active === "ad-products" && data && <AdProductsView data={data} />}
        {!error && active === "keywords" && data && <KeywordView data={data} />}
        {!error && active === "crowds" && data && <CrowdView data={data} />}
        {!error && active === "contents" && data && <ContentView data={data} />}
      </main>
    </div>
  );
}

const alignmentStatusInfo: Record<AlignmentStatus, { label: string; tone: string; hint: string }> = {
  aligned: { label: "对齐", tone: "ok", hint: "5 张源表的日期区间完全一致，可放心联表分析。" },
  partial: { label: "部分对齐", tone: "warn", hint: "各表日期区间存在差异，共同区间内的联表分析最可靠；差异部分仅单表数据。" },
  mismatch: { label: "未对齐", tone: "danger", hint: "至少两张源表日期区间没有重叠，联表分析可能为空。请检查导出范围是否一致。" },
  incomplete: { label: "未齐", tone: "muted", hint: "尚未上齐 5 张源表，或某张表无有效日期。" }
};

function daysBetween(startIso: string, endIso: string): number {
  if (!startIso || !endIso) return 0;
  const start = Date.parse(`${startIso}T00:00:00Z`);
  const end = Date.parse(`${endIso}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.round((end - start) / 86400000);
}

const timelineSlotOrder: Array<{ id: string; label: string }> = [
  { id: "product", label: "商品维度" },
  { id: "adItem", label: "推广商品" },
  { id: "content", label: "推广内容" },
  { id: "keyword", label: "推广关键词" },
  { id: "crowd", label: "推广人群" }
];

function AlignmentTimeline({ alignment }: { alignment?: Alignment }) {
  const [open, setOpen] = React.useState(false);
  if (!alignment) {
    return (
      <div className="timeline timelineEmpty">
        <span className="timelineBadge muted">未齐</span>
        <span>上传源表后将自动展示时间线对齐情况</span>
      </div>
    );
  }
  const { status, intersection, union, perTable, warnings } = alignment;
  const info = alignmentStatusInfo[status];
  const unionStart = union.start;
  const unionEnd = union.end;
  const unionSpan = daysBetween(unionStart, unionEnd);
  const headerText = (() => {
    if (status === "incomplete") return "尚未上齐源表";
    if (!unionStart || !unionEnd) return "无可用日期";
    if (intersection.start && intersection.end) {
      return `共同区间 ${intersection.start} ~ ${intersection.end}（并集 ${unionStart} ~ ${unionEnd}）`;
    }
    return `并集 ${unionStart} ~ ${unionEnd}（无共同区间）`;
  })();

  return (
    <div className={`timeline timeline-${info.tone}`}>
      <div className="timelineHeader">
        <button
          type="button"
          className={`timelineBadge ${info.tone}`}
          onClick={() => setOpen((value) => !value)}
          title={info.hint}
        >
          时间线 · {info.label}
          {warnings.length > 0 && <span className="timelineBadgeCount">{warnings.length}</span>}
        </button>
        <span className="timelineHeaderText">{headerText}</span>
      </div>
      <div className="timelineRows">
        {timelineSlotOrder.map((slot) => {
          const range = perTable[slot.id] || { start: "", end: "" };
          const hasRange = Boolean(range.start && range.end && unionStart && unionEnd && unionSpan >= 0);
          const offsetPercent = hasRange && unionSpan > 0 ? (daysBetween(unionStart, range.start) / unionSpan) * 100 : 0;
          const lengthPercent = hasRange
            ? unionSpan > 0
              ? (Math.max(daysBetween(range.start, range.end), 0) / unionSpan) * 100
              : 100
            : 0;
          const isectStart = intersection.start;
          const isectEnd = intersection.end;
          const hasIsect = Boolean(hasRange && isectStart && isectEnd && isectStart <= isectEnd);
          const isectOffset = hasIsect && unionSpan > 0 ? (daysBetween(unionStart, isectStart) / unionSpan) * 100 : 0;
          const isectLength = hasIsect && unionSpan > 0 ? (Math.max(daysBetween(isectStart, isectEnd), 0) / unionSpan) * 100 : 0;
          return (
            <div key={slot.id} className="timelineRow">
              <span className="timelineLabel">{slot.label}</span>
              <div className="timelineTrack">
                {hasRange ? (
                  <>
                    <div
                      className="timelineSpan"
                      style={{ left: `${offsetPercent}%`, width: `${Math.max(lengthPercent, 1.2)}%` }}
                    />
                    {hasIsect && (
                      <div
                        className="timelineIntersect"
                        style={{ left: `${isectOffset}%`, width: `${Math.max(isectLength, 0.6)}%` }}
                      />
                    )}
                  </>
                ) : (
                  <div className="timelineSpan timelineSpanEmpty" />
                )}
              </div>
              <span className="timelineRange">{range.start && range.end ? `${range.start} ~ ${range.end}` : "—"}</span>
            </div>
          );
        })}
      </div>
      <div className="timelineAxis">
        <span>{unionStart || "—"}</span>
        <span>{unionEnd || "—"}</span>
      </div>
      {open && warnings.length > 0 && (
        <ul className="timelineWarnings">
          {warnings.map((warning, index) => (
            <li key={`${warning.table}-${warning.kind}-${index}`}>{warning.message}</li>
          ))}
        </ul>
      )}
      {open && warnings.length === 0 && status === "aligned" && (
        <div className="timelineWarnings timelineWarningsEmpty">5 张表起止日期完全一致，无需关注。</div>
      )}
    </div>
  );
}

function SourcesView({ meta, onMetaChange }: { meta: Meta | null; onMetaChange: (meta: Meta) => void }) {
  const [files, setFiles] = React.useState<Record<string, File | null>>({});
  const [uploading, setUploading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [inputKey, setInputKey] = React.useState(0);
  const selectedCount = Object.values(files).filter(Boolean).length;
  const columns: ColumnDef<MetaSource>[] = [
    { key: "name", label: "来源表", width: "220px" },
    { key: "mode", label: "数据模式", format: sourceModeLabel },
    { key: "rows", label: "行数", format: fmtInt },
    { key: "dateField", label: "日期字段" },
    { key: "start", label: "开始日期" },
    { key: "end", label: "结束日期" },
    { key: "file", label: "文件路径", width: "460px" }
  ];

  async function readApiMessage(response: Response) {
    const payload = await response.json().catch(() => null);
    return payload?.error || response.statusText;
  }

  async function uploadSources() {
    if (!selectedCount) return;
    const formData = new FormData();
    Object.entries(files).forEach(([key, file]) => {
      if (file) formData.append(key, file);
    });

    setUploading(true);
    setMessage("");
    try {
      const response = await fetch("/api/uploads/sources", { method: "POST", body: formData });
      if (!response.ok) throw new Error(await readApiMessage(response));
      const payload = await response.json();
      onMetaChange(payload.meta);
      setFiles({});
      setInputKey((key) => key + 1);
      setMessage(`已更新 ${fmtInt(payload.updated?.length || 0)} 张源表`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "上传失败");
    } finally {
      setUploading(false);
    }
  }

  async function clearSources() {
    setUploading(true);
    setMessage("");
    try {
      const response = await fetch("/api/uploads/sources", { method: "DELETE" });
      if (!response.ok) throw new Error(await readApiMessage(response));
      const payload = await response.json();
      onMetaChange(payload.meta);
      setFiles({});
      setInputKey((key) => key + 1);
      setMessage("已清空源数据");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清空失败");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section className="viewStack">
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">数据接入</p>
            <h2>自定义上传源表</h2>
          </div>
          <span className="pill">{meta?.sourceDataCleared ? "当前为空数据" : `上传目录: ${meta?.uploadDir || "uploads/source-data"}`}</span>
        </div>
        <div className="uploadGrid">
          {sourceUploadSlots.map((slot) => {
            const file = files[slot.id];
            return (
              <label key={`${slot.id}-${inputKey}`} className="uploadSlot">
                <span>{slot.label}</span>
                <strong>{file?.name || "选择文件"}</strong>
                <em>{slot.hint}</em>
                <input
                  type="file"
                  accept={slot.accept}
                  onChange={(event) => {
                    const fileValue = event.target.files?.[0] || null;
                    setFiles((prev) => ({ ...prev, [slot.id]: fileValue }));
                  }}
                />
              </label>
            );
          })}
        </div>
        <div className="uploadActions">
          <button type="button" className="primaryButton" disabled={!selectedCount || uploading} onClick={uploadSources}>
            {uploading ? "处理中" : "上传并重算"}
          </button>
          <button type="button" className="iconTextButton" disabled={uploading} onClick={clearSources}>
            清空源数据
          </button>
        </div>
        {message && <div className="uploadNotice">{message}</div>}
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">数据接入</p>
            <h2>源表状态</h2>
          </div>
          <span className="pill">{meta?.dataDir || "等待数据目录"}</span>
        </div>
        <AlignmentTimeline alignment={meta?.alignment} />
        <DataTable rows={meta?.sources || []} columns={columns} pageSize={20} />
      </div>
      <HistoryArchivePanel />
    </section>
  );
}

type CoverageInfo = {
  uploads: number;
  product_rows: number; ad_item_rows: number; content_rows: number;
  keyword_rows: number; crowd_rows: number;
  product_date_min: string | null; product_date_max: string | null;
  ad_item_date_min: string | null; ad_item_date_max: string | null;
  content_date_min: string | null; content_date_max: string | null;
  keyword_date_min: string | null; keyword_date_max: string | null;
  crowd_date_min: string | null; crowd_date_max: string | null;
};

function HistoryArchivePanel() {
  const [coverage, setCoverage] = React.useState<CoverageInfo | null>(null);
  const [error, setError] = React.useState("");
  const [exportStart, setExportStart] = React.useState("");
  const [exportEnd, setExportEnd] = React.useState("");

  React.useEffect(() => {
    fetch("/api/history/coverage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setCoverage(data);
        // 默认填入库覆盖范围
        const start = data.product_date_min || data.ad_item_date_min || "";
        const end = data.product_date_max || data.ad_item_date_max || "";
        setExportStart(start || "");
        setExportEnd(end || "");
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, []);

  const coverageStart = coverage
    ? [coverage.product_date_min, coverage.ad_item_date_min, coverage.content_date_min, coverage.keyword_date_min, coverage.crowd_date_min].filter(Boolean).sort()[0] || ""
    : "";
  const coverageEnd = coverage
    ? [coverage.product_date_max, coverage.ad_item_date_max, coverage.content_date_max, coverage.keyword_date_max, coverage.crowd_date_max].filter(Boolean).sort().reverse()[0] || ""
    : "";

  const totalRows = coverage
    ? coverage.product_rows + coverage.ad_item_rows + coverage.content_rows + coverage.keyword_rows + coverage.crowd_rows
    : 0;

  const exportUrl = (() => {
    const params = new URLSearchParams();
    if (exportStart) params.set("start", exportStart);
    if (exportEnd) params.set("end", exportEnd);
    const qs = params.toString();
    return `/api/history/export${qs ? `?${qs}` : ""}`;
  })();

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">长期存储 · 历史归档</p>
          <h2>跨周期下载</h2>
        </div>
        <span className="pill">
          {coverage ? `${coverage.uploads} 次上传 · ${fmtInt(totalRows)} 行` : "加载中..."}
        </span>
      </div>
      {error && <div className="uploadNotice">{error}</div>}
      {coverage && (
        <>
          <div className="historyMeta">
            <span>库覆盖范围 <strong>{coverageStart || "—"}</strong> ~ <strong>{coverageEnd || "—"}</strong></span>
            <span>商品维度 <strong>{fmtInt(coverage.product_rows)}</strong> 行</span>
            <span>推广商品 <strong>{fmtInt(coverage.ad_item_rows)}</strong> 行</span>
            <span>推广内容 <strong>{fmtInt(coverage.content_rows)}</strong> 行</span>
            <span>关键词 <strong>{fmtInt(coverage.keyword_rows)}</strong> 行</span>
            <span>人群 <strong>{fmtInt(coverage.crowd_rows)}</strong> 行</span>
          </div>
          <div className="historyExportRow">
            <label>
              <span>开始日期</span>
              <input type="date" value={exportStart} onChange={(e) => setExportStart(e.target.value)} min={coverageStart} max={coverageEnd} />
            </label>
            <label>
              <span>结束日期</span>
              <input type="date" value={exportEnd} onChange={(e) => setExportEnd(e.target.value)} min={coverageStart} max={coverageEnd} />
            </label>
            <a className="exportButton" href={exportUrl} download title="下载该时段对齐的 5 张表 zip（生参原始 csv 格式）">
              下载 ZIP（5 张对齐 csv）
            </a>
          </div>
          <div className="historyHint">
            导出的 zip 包含 5 个 csv（utf-8 + BOM，Excel 可直接打开），字段顺序跟生参原始导出完全一致，可重新上传或直接用 Excel 分析。
          </div>
        </>
      )}
    </div>
  );
}

function sourceModeLabel(value: unknown) {
  if (value === "uploaded") return "自定义";
  if (value === "empty") return "已清空";
  return "默认";
}

function ProductRowDrilldown({ row }: { row: AnyRecord }) {
  const daily = (row.daily as AnyRecord[]) || [];
  const dates = daily.map((d) => String(d.date || ""));
  const payments = daily.map((d) => Number(d.payment) || 0);
  const refunds = daily.map((d) => Number(d.refund) || 0);
  const spends = daily.map((d) => Number(d.spend) || 0);
  const netFeeRatios = daily.map((d) => (typeof d.netFeeRatio === "number" ? d.netFeeRatio : null));
  const totalPay = payments.reduce((a, b) => a + b, 0);
  const totalRefund = refunds.reduce((a, b) => a + b, 0);
  const totalSpend = spends.reduce((a, b) => a + b, 0);
  const netPay = totalPay - totalRefund;

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20,24,16,0.95)",
      borderColor: "rgba(245,200,119,0.4)",
      textStyle: { color: "#f5f0df" },
      valueFormatter: (value: unknown, _i: unknown, idx: number) => {
        // ECharts 不提供 series 上下文给 valueFormatter，靠 formatter 自定义比较 verbose；
        // 直接让金额按 money 显示、费比按 % 显示，混排无所谓——前端拿到结构后做总览
        return typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : "-";
      }
    },
    legend: { textStyle: { color: "#d9d4c4" }, top: 0 },
    grid: { left: 64, right: 64, top: 32, bottom: dates.length > 30 ? 56 : 28 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#d9d4c4", rotate: dates.length > 14 ? 38 : 0 } },
    yAxis: [
      { type: "value", name: "金额", axisLabel: { color: "#d9d4c4", formatter: (v: number) => fmtMoney(v) }, splitLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } } },
      { type: "value", name: "净费比", axisLabel: { color: "#d9d4c4", formatter: (v: number) => fmtPercent(v) }, splitLine: { show: false }, position: "right" }
    ],
    series: [
      { name: "支付", type: "line", yAxisIndex: 0, smooth: true, symbol: "circle", symbolSize: 5, itemStyle: { color: "#f5c877" }, lineStyle: { color: "#f5c877", width: 2 }, areaStyle: { color: "rgba(245,200,119,0.14)" }, data: payments },
      { name: "退款", type: "line", yAxisIndex: 0, smooth: true, symbol: "circle", symbolSize: 4, itemStyle: { color: "#e56e60" }, lineStyle: { color: "#e56e60", width: 2 }, data: refunds },
      { name: "推广花费", type: "line", yAxisIndex: 0, smooth: true, symbol: "circle", symbolSize: 4, itemStyle: { color: "#60c7bc" }, lineStyle: { color: "#60c7bc", width: 2 }, data: spends },
      { name: "净费比", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", lineStyle: { color: "#d9ee62", width: 2, type: "dashed" }, data: netFeeRatios }
    ]
  };

  return (
    <div className="expandPanel">
      <div className="expandPanelTitle">
        <strong>{String(row.subjectCode || "").slice(0, 80)}</strong>
        <span>分日走势（{daily.length} 天有活跃数据）</span>
      </div>
      <div className="expandPanelMeta">
        <span>区间合计 · 支付 <strong>{fmtMoney(totalPay)}</strong></span>
        <span>退款 <strong>{fmtMoney(totalRefund)}</strong></span>
        <span>推广花费 <strong>{fmtMoney(totalSpend)}</strong></span>
        <span>区间净费比 <strong>{totalSpend > 0 && netPay !== 0 ? fmtPercent(totalSpend / netPay) : "未推广"}</strong></span>
        <span>区间净ROI <strong>{totalSpend > 0 ? fmtNumber(netPay / totalSpend) : "未推广"}</strong></span>
      </div>
      <EChart height={280} option={option} />
    </div>
  );
}

function AdRowDrilldown({ row }: { row: AnyRecord }) {
  const daily = (row.daily as AnyRecord[]) || [];
  const title = String(row.planCode || row.keywordCode || row.crowdCode || row.contentCode || row.subjectCode || row.word || "");
  const dates = daily.map((d) => String(d.date || ""));
  const spends = daily.map((d) => Number(d.spend) || 0);
  const gmvs = daily.map((d) => Number(d.gmv) || 0);
  const rois = daily.map((d) => (typeof d.roi === "number" ? d.roi : null));
  const ctrs = daily.map((d) => (typeof d.ctr === "number" ? d.ctr : null));
  const cvrs = daily.map((d) => (typeof d.cvr === "number" ? d.cvr : null));
  const totalSpend = spends.reduce((a, b) => a + b, 0);
  const totalGmv = gmvs.reduce((a, b) => a + b, 0);
  const totalClicks = daily.reduce((a, d) => a + (Number(d.clicks) || 0), 0);
  const totalOrders = daily.reduce((a, d) => a + (Number(d.orders) || 0), 0);

  const option = {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20,24,16,0.95)",
      borderColor: "rgba(245,200,119,0.4)",
      textStyle: { color: "#f5f0df" },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const idx = (arr[0] as { dataIndex: number }).dataIndex;
        const d = daily[idx] || {};
        const lines = arr.map((p: any) => `<div>${p.marker} ${p.seriesName}: <strong>${typeof p.value === "number" ? (p.seriesName === "ROI" ? fmtNumber(p.value) : fmtMoney(p.value)) : "-"}</strong></div>`);
        const extra = `
          <div style="margin-top:6px; padding-top:6px; border-top:1px dashed rgba(245,200,119,0.3); color:rgba(245,240,223,0.78); font-size:11px">
            CTR ${typeof d.ctr === "number" ? fmtPercent(d.ctr) : "-"}　·　CVR ${typeof d.cvr === "number" ? fmtPercent(d.cvr) : "-"}　·　点击 ${fmtInt(d.clicks)}　·　订单 ${fmtInt(d.orders)}
          </div>`;
        return `<div><strong>${(arr[0] as { axisValue: string }).axisValue}</strong>${lines.join("")}${extra}</div>`;
      }
    },
    legend: { textStyle: { color: "#d9d4c4" }, top: 0 },
    grid: { left: 64, right: 64, top: 32, bottom: dates.length > 30 ? 56 : 28 },
    xAxis: { type: "category", data: dates, axisLabel: { color: "#d9d4c4", rotate: dates.length > 14 ? 38 : 0 } },
    yAxis: [
      { type: "value", name: "金额", axisLabel: { color: "#d9d4c4", formatter: (v: number) => fmtMoney(v) }, splitLine: { lineStyle: { color: "rgba(255,255,255,0.08)" } } },
      { type: "value", name: "ROI", axisLabel: { color: "#d9d4c4", formatter: (v: number) => fmtNumber(v) }, splitLine: { show: false }, position: "right" }
    ],
    series: [
      { name: "花费", type: "line", yAxisIndex: 0, smooth: true, symbol: "circle", symbolSize: 5, itemStyle: { color: "#60c7bc" }, lineStyle: { color: "#60c7bc", width: 2 }, areaStyle: { color: "rgba(96,199,188,0.12)" }, data: spends },
      { name: "GMV", type: "line", yAxisIndex: 0, smooth: true, symbol: "circle", symbolSize: 4, itemStyle: { color: "#f5c877" }, lineStyle: { color: "#f5c877", width: 2 }, data: gmvs },
      { name: "ROI", type: "line", yAxisIndex: 1, smooth: true, symbol: "none", lineStyle: { color: "#d9ee62", width: 2, type: "dashed" }, data: rois }
    ]
  };
  void ctrs;
  void cvrs;

  return (
    <div className="expandPanel">
      <div className="expandPanelTitle">
        <strong>{title.slice(0, 80)}</strong>
        <span>分日走势（{daily.length} 天有活跃数据）</span>
      </div>
      <div className="expandPanelMeta">
        <span>区间花费 <strong>{fmtMoney(totalSpend)}</strong></span>
        <span>GMV <strong>{fmtMoney(totalGmv)}</strong></span>
        <span>ROI <strong>{totalSpend > 0 ? fmtNumber(totalGmv / totalSpend) : "—"}</strong></span>
        <span>点击 <strong>{fmtInt(totalClicks)}</strong></span>
        <span>订单 <strong>{fmtInt(totalOrders)}</strong></span>
      </div>
      <EChart height={280} option={option} />
    </div>
  );
}

// 商品级"费比 / 链接净ROI"在 spend=0 或 pay=0 时数学上无定义，
// 用业务语义字样区分，避免把 0% / "-" 误读为"推广高效"或"数据缺失"
function formatPromoMetric(value: unknown, row: AnyRecord, formatter: (v: unknown) => string) {
  const pay = Number(row.pay) || 0;
  const spend = Number(row["推广消耗"]) || 0;
  if (spend === 0) return "未推广";
  if (pay === 0) return "无销售";
  return formatter(value);
}

function ProductView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<ProductDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const weekly = (data.weekly as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig =
    drilldown === "payDaily"
      ? { title: "全店支付金额分日走势", build: (s: DrillWindowSlice) => dailyPayOption(s.main, s.compare), endpoint: { view: "product" as const, metric: "pay", metricKey: "pay" }, extras: undefined as ExtraMetric[] | undefined }
      : drilldown === "netFeeDaily"
        ? {
            title: "全店净费比分日走势",
            build: (s: DrillWindowSlice) => dailyNetFeeOption(s.main, s.compare, s.extras),
            endpoint: { view: "product" as const, metric: "netFeeRatio", metricKey: "netFeeRatio" },
            extras: [
              { key: "支付金额", label: "支付", axis: "money" as const, color: "#f5c877" },
              { key: "成功退款金额", label: "退款", axis: "money" as const, color: "#e56e60" },
              { key: "推广消耗", label: "推广花费", axis: "money" as const, color: "#60c7bc" },
              { key: "refundRatio", label: "退款率", axis: "ratio" as const, color: "#c084fc" },
              { key: "netRoi", label: "净 ROI", axis: "ratio" as const, color: "#d9ee62" }
            ]
          }
        : null;
  const columns: ColumnDef<AnyRecord>[] = [
    { key: "subjectCode", label: "主体编码", width: "300px" },
    { key: "pay", label: "支付金额", format: fmtMoney },
    { key: "visitors", label: "商品访客数", format: fmtInt },
    { key: "conversionRate", label: "转化率", format: fmtPercent },
    { key: "customerPrice", label: "客单价", format: fmtNumber },
    { key: "annualPay", label: "年累计支付金额", format: fmtMoney },
    { key: "annualPayShare", label: "年累计支付金额占比", format: fmtPercent },
    { key: "feeRatio", label: "费比", format: (value, row) => formatPromoMetric(value, row, fmtPercent) },
    { key: "refundRatio", label: "退款金额占比", format: fmtPercent },
    { key: "repeatRate", label: "复购率", format: fmtPercent },
    { key: "repeatPayRatio", label: "复购金额占比", format: fmtPercent },
    { key: "cartRate", label: "加购率", format: fmtPercent },
    { key: "pvPerVisitor", label: "人均浏览量", format: fmtNumber },
    { key: "netRoi", label: "链接净ROI", format: (value, row) => formatPromoMetric(value, row, fmtNumber) }
  ];

  return (
    <section className="viewStack">
      <div className="kpiGrid">
        <MetricCard label="商品分组" value={fmtInt(summary.groups)} />
        <MetricCard
          label="全店支付金额"
          value={fmtMoney(summary.totalPay)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "payDaily" ? null : "payDaily"))}
        />
        <MetricCard label="全店退款金额占比" value={fmtPercent(summary.refundRatio)} />
        <MetricCard
          label="全店净费比"
          value={fmtPercent(summary.netFeeRatio)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "netFeeDaily" ? null : "netFeeDaily"))}
        />
      </div>
      {drillConfig && (
        <div className="panel drillPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">点击下钻分析</p>
              <h2>{drillConfig.title}</h2>
            </div>
            <button type="button" className="iconTextButton" onClick={() => setDrilldown(null)}>
              <X size={16} />
              <span>关闭</span>
            </button>
          </div>
          <DrillChart rows={daily} buildOption={drillConfig.build} compareEndpoint={drillConfig.endpoint} availableExtras={(drillConfig as { extras?: ExtraMetric[] }).extras} />
        </div>
      )}
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-商品维度分析表</p>
            <h2>商品支付金额树图</h2>
          </div>
          <span className="pill">面积=支付金额 / 色彩=费比</span>
        </div>
        <EChart height={520} option={treemapOption(data.treemap as AnyRecord[], "支付金额", "费比")} />
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-商品维度分析表</p>
            <h2>周趋势指标矩阵</h2>
          </div>
          <span className="pill">去退费比=推广消耗 / 扣退款支付金额</span>
        </div>
        <WeeklyMatrix rows={weekly} metrics={productWeeklyMetrics} />
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-商品维度分析表</p>
            <h2>商品经营明细</h2>
          </div>
          <span className="pill">共 {fmtInt(table.length)} 条数据</span>
        </div>
        <DataTable
          rows={table}
          columns={columns}
          pageSize={15}
          isExpandable={(row) => Array.isArray(row.daily) && (row.daily as unknown[]).length > 0}
          renderExpand={(row) => <ProductRowDrilldown row={row} />}
        />
      </div>
    </section>
  );
}

function AdProductsView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<AdProductDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const scene = (data.scene as AnyRecord[]) || [];
  const weekly = (data.weekly as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const planTable = (data.planTable as AnyRecord[]) || [];
  const drillConfig =
    drilldown === "spendDaily"
      ? { title: "推广花费分日走势", build: (s: DrillWindowSlice) => dailySpendOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "spend", metricKey: "spend" } }
      : drilldown === "gmvDaily"
        ? { title: "推广成交金额分日走势", build: (s: DrillWindowSlice) => dailyGmvOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "gmv", metricKey: "gmv" } }
        : drilldown === "roiDaily"
          ? { title: "推广整体投产分日走势", build: (s: DrillWindowSlice) => dailyRoiOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "roi", metricKey: "roi" } }
          : null;
  const columns: ColumnDef<AnyRecord>[] = [
    { key: "planCode", label: "计划编码", width: "520px" },
    { key: "spend", label: "花费", format: fmtMoney },
    { key: "gmv", label: "总成交金额", format: fmtMoney },
    { key: "roi", label: "投产", format: fmtNumber },
    { key: "cpc", label: "点击单价", format: fmtNumber },
    { key: "cvr", label: "转化率", format: fmtPercent },
    { key: "customerPrice", label: "客单价", format: fmtNumber },
    { key: "leadRatio", label: "引潜比", format: fmtPercent },
    { key: "cartCost", label: "加购成本", format: fmtNumber }
  ];

  return (
    <section className="viewStack">
      <div className="kpiGrid">
        <MetricCard
          label="花费"
          value={fmtMoney(summary.totalSpend)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "spendDaily" ? null : "spendDaily"))}
        />
        <MetricCard
          label="成交金额"
          value={fmtMoney(summary.totalGmv)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "gmvDaily" ? null : "gmvDaily"))}
        />
        <MetricCard
          label="整体投产"
          value={fmtNumber(summary.roi)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "roiDaily" ? null : "roiDaily"))}
        />
        <MetricCard label="计划分组" value={fmtInt(summary.plans)} />
      </div>
      {drillConfig && (
        <div className="panel drillPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">点击下钻分析</p>
              <h2>{drillConfig.title}</h2>
            </div>
            <button type="button" className="iconTextButton" onClick={() => setDrilldown(null)}>
              <X size={16} />
              <span>关闭</span>
            </button>
          </div>
          <DrillChart rows={daily} buildOption={drillConfig.build} compareEndpoint={drillConfig.endpoint} availableExtras={(drillConfig as { extras?: ExtraMetric[] }).extras} />
        </div>
      )}
      <div className="splitGrid">
        <div className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">图表-推广商品分析表</p>
              <h2>推广主体树图</h2>
            </div>
            <span className="pill">面积=花费 / 色彩=投产</span>
          </div>
          <EChart height={520} option={treemapOption(data.treemap as AnyRecord[], "花费", "投产")} />
        </div>
        <div className="panel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">图表-推广商品分析表</p>
              <h2>场景花费与效率</h2>
            </div>
            <span className="pill">柱=花费 / 线=投产与引潜比</span>
          </div>
          <EChart height={520} option={sceneOption(scene)} />
        </div>
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-推广商品分析表</p>
            <h2>周趋势指标矩阵</h2>
          </div>
          <span className="pill">按周一至周日汇总</span>
        </div>
        <WeeklyMatrix rows={weekly} />
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-推广商品分析表</p>
            <h2>推广计划明细</h2>
          </div>
          <span className="pill">共 {fmtInt(planTable.length)} 条数据</span>
        </div>
        <DataTable
          rows={planTable}
          columns={columns}
          pageSize={18}
          isExpandable={(row) => Array.isArray(row.daily) && (row.daily as unknown[]).length > 0}
          renderExpand={(row) => <AdRowDrilldown row={row} />}
        />
      </div>
    </section>
  );
}

function KeywordView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<KeywordDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "关键词花费分日走势", build: (s: DrillWindowSlice) => dailySpendOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "spend", metricKey: "spend" } } : null;
  const columns = keywordColumns("keywordCode");

  return (
    <section className="viewStack">
      <div className="kpiGrid">
        <MetricCard label="关键词分组" value={fmtInt(summary.groups)} />
        <MetricCard
          label="花费"
          value={fmtMoney(summary.totalSpend)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "spendDaily" ? null : "spendDaily"))}
        />
        <MetricCard label="源记录" value={fmtInt(summary.rows)} />
        <MetricCard label="TOP 关键词" value={String(table[0]?.word || "-")} />
      </div>
      {drillConfig && (
        <div className="panel drillPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">点击下钻分析</p>
              <h2>{drillConfig.title}</h2>
            </div>
            <button type="button" className="iconTextButton" onClick={() => setDrilldown(null)}>
              <X size={16} />
              <span>关闭</span>
            </button>
          </div>
          <DrillChart rows={daily} buildOption={drillConfig.build} compareEndpoint={drillConfig.endpoint} availableExtras={(drillConfig as { extras?: ExtraMetric[] }).extras} />
        </div>
      )}
      <div className="threeGrid">
        <div className="panel">
          <div className="panelHeader"><h2>关键词词云</h2></div>
          <EChart height={360} option={wordCloudOption(data.wordCloud as AnyRecord[])} />
        </div>
        <div className="panel">
          <div className="panelHeader"><h2>词类型占比</h2></div>
          <EChart height={360} option={pieOption(data.typePie as AnyRecord[])} />
        </div>
        <div className="panel">
          <div className="panelHeader"><h2>关键词花费气泡</h2></div>
          <EChart height={360} option={bubbleOption(data.bubble as AnyRecord[])} />
        </div>
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-推广关键词分析表</p>
            <h2>关键词明细</h2>
          </div>
          <span className="pill">共 {fmtInt(table.length)} 条数据</span>
        </div>
        <DataTable
          rows={table}
          columns={columns}
          pageSize={18}
          isExpandable={(row) => Array.isArray(row.daily) && (row.daily as unknown[]).length > 0}
          renderExpand={(row) => <AdRowDrilldown row={row} />}
        />
      </div>
    </section>
  );
}

function CrowdView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<CrowdDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "人群花费分日走势", build: (s: DrillWindowSlice) => dailySpendOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "spend", metricKey: "spend" } } : null;
  const columns = keywordColumns("crowdCode");

  return (
    <section className="viewStack">
      <div className="kpiGrid">
        <MetricCard label="人群分组" value={fmtInt(summary.groups)} />
        <MetricCard
          label="花费"
          value={fmtMoney(summary.totalSpend)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "spendDaily" ? null : "spendDaily"))}
        />
        <MetricCard label="源记录" value={fmtInt(summary.rows)} />
        <MetricCard label="TOP 人群" value={String(table[0]?.crowdCode || "-")} />
      </div>
      {drillConfig && (
        <div className="panel drillPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">点击下钻分析</p>
              <h2>{drillConfig.title}</h2>
            </div>
            <button type="button" className="iconTextButton" onClick={() => setDrilldown(null)}>
              <X size={16} />
              <span>关闭</span>
            </button>
          </div>
          <DrillChart rows={daily} buildOption={drillConfig.build} compareEndpoint={drillConfig.endpoint} availableExtras={(drillConfig as { extras?: ExtraMetric[] }).extras} />
        </div>
      )}
      <div className="splitGrid">
        <div className="panel">
          <div className="panelHeader"><h2>场景词云</h2></div>
          <EChart height={420} option={wordCloudOption(data.sceneWords as AnyRecord[])} />
        </div>
        <div className="panel">
          <div className="panelHeader"><h2>人群词云</h2></div>
          <EChart height={420} option={wordCloudOption(data.crowdWords as AnyRecord[])} />
        </div>
      </div>
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-推广人群分析表</p>
            <h2>人群投放明细</h2>
          </div>
          <span className="pill">共 {fmtInt(table.length)} 条数据</span>
        </div>
        <DataTable
          rows={table}
          columns={columns}
          pageSize={18}
          isExpandable={(row) => Array.isArray(row.daily) && (row.daily as unknown[]).length > 0}
          renderExpand={(row) => <AdRowDrilldown row={row} />}
        />
      </div>
    </section>
  );
}

function ContentView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<ContentDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "内容花费分日走势", build: (s: DrillWindowSlice) => dailySpendOption(s.main, s.compare), endpoint: { view: "ad" as const, metric: "spend", metricKey: "spend" } } : null;
  const columns = keywordColumns("contentCode");

  return (
    <section className="viewStack">
      <div className="kpiGrid">
        <MetricCard label="内容分组" value={fmtInt(summary.groups)} />
        <MetricCard
          label="花费"
          value={fmtMoney(summary.totalSpend)}
          actionLabel="点击下钻: 分日走势"
          onClick={() => setDrilldown((prev) => (prev === "spendDaily" ? null : "spendDaily"))}
        />
        <MetricCard label="源记录" value={fmtInt(summary.rows)} />
        <MetricCard label="TOP 内容" value={String(table[0]?.contentCode || "-")} />
      </div>
      {drillConfig && (
        <div className="panel drillPanel">
          <div className="panelHeader">
            <div>
              <p className="eyebrow">点击下钻分析</p>
              <h2>{drillConfig.title}</h2>
            </div>
            <button type="button" className="iconTextButton" onClick={() => setDrilldown(null)}>
              <X size={16} />
              <span>关闭</span>
            </button>
          </div>
          <DrillChart rows={daily} buildOption={drillConfig.build} compareEndpoint={drillConfig.endpoint} availableExtras={(drillConfig as { extras?: ExtraMetric[] }).extras} />
        </div>
      )}
      <div className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">图表-推广内容分析表</p>
            <h2>内容花费树图</h2>
          </div>
          <span className="pill">面积=花费 / 色彩=投产</span>
        </div>
        <EChart height={520} option={treemapOption(data.treemap as AnyRecord[], "花费", "投产")} />
      </div>
      <div className="panel">
        <div className="panelHeader">
          <h2>内容明细</h2>
          <span className="pill">共 {fmtInt(table.length)} 条数据</span>
        </div>
        <DataTable
          rows={table}
          columns={columns}
          pageSize={18}
          isExpandable={(row) => Array.isArray(row.daily) && (row.daily as unknown[]).length > 0}
          renderExpand={(row) => <AdRowDrilldown row={row} />}
        />
      </div>
    </section>
  );
}

function keywordColumns(labelKey: string): ColumnDef<AnyRecord>[] {
  return [
    { key: labelKey, label: "编码", width: "520px" },
    { key: "spend", label: "花费", format: fmtMoney },
    { key: "roi", label: "投产", format: fmtNumber },
    { key: "cpc", label: "点击单价", format: fmtNumber },
    { key: "cvr", label: "转化率", format: fmtPercent },
    { key: "customerPrice", label: "客单价", format: fmtNumber },
    { key: "leadRatio", label: "引潜比", format: fmtPercent },
    { key: "cartCost", label: "加购成本", format: fmtNumber }
  ];
}

function treemapOption(rows: AnyRecord[] = [], valueLabel: string, colorLabel: string) {
  return {
    tooltip: {
      formatter: (params: { data: AnyRecord }) => {
        const data = params.data;
        return `<b>${data.name}</b><br/>${valueLabel}: ${fmtMoney(data.value)}<br/>${colorLabel}: ${colorLabel === "费比" ? fmtPercent(data.feeRatio) : fmtNumber(data.roi)}<br/>占比: ${fmtPercent(data.share)}`;
      }
    },
    series: [
      {
        type: "treemap",
        roam: false,
        breadcrumb: { show: false },
        nodeClick: false,
        label: {
          show: true,
          formatter: (params: { data: AnyRecord }) => `${shortText(String(params.data.name), 36)}\n${fmtMoney(params.data.value)}\n${fmtPercent(params.data.share)}`,
          color: "#fff",
          fontSize: 12
        },
        itemStyle: {
          borderColor: "#10140c",
          borderWidth: 1,
          gapWidth: 2
        },
        levels: [
          {
            color: ["#f5b343", "#f47c2c", "#8da64a", "#64c6bd", "#87a7ff", "#d44f3e", "#f2df45", "#9fd1d7"]
          }
        ],
        data: rows.slice(0, 140)
      }
    ]
  };
}

function sceneOption(rows: AnyRecord[] = []) {
  return {
    tooltip: { trigger: "axis" },
    legend: { textStyle: { color: "#d9d4c4" } },
    grid: { left: 58, right: 56, top: 42, bottom: 48 },
    xAxis: { type: "category", data: rows.map((row) => row.scene), axisLabel: { color: "#d9d4c4" } },
    yAxis: [
      { type: "value", name: "花费", axisLabel: { color: "#d9d4c4" }, splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } } },
      { type: "value", name: "效率", axisLabel: { color: "#d9d4c4" }, splitLine: { show: false } }
    ],
    series: [
      {
        name: "花费",
        type: "bar",
        barWidth: 58,
        itemStyle: { color: "#f5c877", borderRadius: [4, 4, 0, 0] },
        label: { show: true, position: "top", color: "#f5c877", formatter: (p: { value: number }) => fmtMoney(p.value) },
        data: rows.map((row) => row.spend)
      },
      {
        name: "投产",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        itemStyle: { color: "#ffae25" },
        lineStyle: { width: 3 },
        label: { show: true, color: "#ffae25", formatter: (p: { value: number }) => fmtNumber(p.value) },
        data: rows.map((row) => row.roi)
      },
      {
        name: "引潜比",
        type: "line",
        yAxisIndex: 1,
        smooth: true,
        itemStyle: { color: "#5ed0c4" },
        lineStyle: { width: 2 },
        label: { show: true, color: "#5ed0c4", formatter: (p: { value: number }) => fmtPercent(p.value) },
        data: rows.map((row) => row.leadRatio)
      }
    ]
  };
}

function dailyPayOption(rows: AnyRecord[] = [], compareRows: AnyRecord[] | null = null) {
  return dailyMoneyOption(rows, "pay", "支付金额", compareRows);
}

function dailySpendOption(rows: AnyRecord[] = [], compareRows: AnyRecord[] | null = null) {
  return dailyMoneyOption(rows, "spend", "花费", compareRows);
}

function dailyGmvOption(rows: AnyRecord[] = [], compareRows: AnyRecord[] | null = null) {
  return dailyMoneyOption(rows, "gmv", "成交金额", compareRows);
}

function dailyRoiOption(rows: AnyRecord[] = [], compareRows: AnyRecord[] | null = null) {
  return dailyNumberOption(rows, "roi", "投产", compareRows);
}

function dailyMoneyOption(rows: AnyRecord[] = [], valueKey: string, metricLabel: string, compareRows: AnyRecord[] | null = null) {
  const dates = rows.map((row) => String(row.date || ""));
  const values = rows.map((row) => Number(row[valueKey]) || 0);
  const startValue = Math.max(0, dates.length - 45);

  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: unknown) => fmtMoney(value)
    },
    legend: { top: 0, textStyle: { color: "#d9d4c4" } },
    grid: { left: 72, right: 24, top: 46, bottom: dates.length > 45 ? 78 : 56 },
    dataZoom:
      dates.length > 45
        ? [
            { type: "inside", startValue, endValue: dates.length - 1 },
            {
              type: "slider",
              startValue,
              endValue: dates.length - 1,
              height: 22,
              bottom: 18,
              borderColor: "rgba(245, 200, 119, 0.25)",
              textStyle: { color: "#d9d4c4" },
              fillerColor: "rgba(100, 198, 189, 0.22)",
              handleStyle: { color: "#f5c877" }
            }
          ]
        : [{ type: "inside" }],
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { color: "#d9d4c4", rotate: 38 },
      axisLine: { lineStyle: { color: "rgba(245, 200, 119, 0.35)" } }
    },
    yAxis: {
      type: "value",
      name: metricLabel,
      axisLabel: { color: "#d9d4c4", formatter: (value: number) => fmtMoney(value) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } }
    },
    series: [
      {
        name: metricLabel,
        type: "bar",
        barMaxWidth: 20,
        itemStyle: { color: "#f5c877", borderRadius: [4, 4, 0, 0] },
        data: values
      },
      {
        name: "7日均线",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 5,
        itemStyle: { color: "#60c7bc" },
        lineStyle: { color: "#60c7bc", width: 3 },
        data: movingAverage(values, 7)
      },
      ...buildCompareLineSeries(metricLabel, compareRows, dates.length, (r) => Number(r[valueKey]) || 0)
    ]
  };
}

function dailyNumberOption(rows: AnyRecord[] = [], valueKey: string, metricLabel: string, compareRows: AnyRecord[] | null = null) {
  const dates = rows.map((row) => String(row.date || ""));
  const values = rows.map((row) => {
    const value = Number(row[valueKey]);
    return Number.isFinite(value) ? value : null;
  });
  const startValue = Math.max(0, dates.length - 45);

  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: unknown) => fmtNumber(typeof value === "number" ? value : Number(value))
    },
    legend: { top: 0, textStyle: { color: "#d9d4c4" } },
    grid: { left: 64, right: 24, top: 46, bottom: dates.length > 45 ? 78 : 56 },
    dataZoom:
      dates.length > 45
        ? [
            { type: "inside", startValue, endValue: dates.length - 1 },
            {
              type: "slider",
              startValue,
              endValue: dates.length - 1,
              height: 22,
              bottom: 18,
              borderColor: "rgba(245, 200, 119, 0.25)",
              textStyle: { color: "#d9d4c4" },
              fillerColor: "rgba(100, 198, 189, 0.22)",
              handleStyle: { color: "#f5c877" }
            }
          ]
        : [{ type: "inside" }],
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { color: "#d9d4c4", rotate: 38 },
      axisLine: { lineStyle: { color: "rgba(245, 200, 119, 0.35)" } }
    },
    yAxis: {
      type: "value",
      name: metricLabel,
      axisLabel: { color: "#d9d4c4", formatter: (value: number) => fmtNumber(value) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } }
    },
    series: [
      {
        name: metricLabel,
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        itemStyle: { color: "#f5c877" },
        lineStyle: { color: "#f5c877", width: 3 },
        areaStyle: { color: "rgba(245, 200, 119, 0.16)" },
        data: values
      },
      {
        name: "7日均线",
        type: "line",
        smooth: true,
        symbol: "none",
        itemStyle: { color: "#60c7bc" },
        lineStyle: { color: "#60c7bc", width: 3 },
        data: movingAverage(values, 7)
      },
      ...buildCompareLineSeries(metricLabel, compareRows, dates.length, (r) => {
        const v = Number(r[valueKey]);
        return Number.isFinite(v) ? v : null;
      })
    ]
  };
}

function dailyNetFeeOption(rows: AnyRecord[] = [], compareRows: AnyRecord[] | null = null, extras: ExtraMetric[] = []) {
  const dates = rows.map((row) => String(row.date || ""));
  const ratios = rows.map((row) => {
    const value = Number(row.netFeeRatio);
    return Number.isFinite(value) ? value : null;
  });
  const anomalies = rows.map((row) => Boolean(row.anomalous));
  const startValue = Math.max(0, dates.length - 45);

  return {
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(20, 24, 16, 0.95)",
      borderColor: "rgba(245, 200, 119, 0.4)",
      textStyle: { color: "#f5f0df" },
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : [params];
        const first = arr[0] as { dataIndex: number; axisValue: string } | undefined;
        if (!first) return "";
        const i = first.dataIndex;
        const row = rows[i] || {};
        const lines = arr.map((p: any) => {
          const v = typeof p.value === "object" && p.value !== null ? p.value.value : p.value;
          return `<div style="margin:2px 0">${p.marker} ${p.seriesName}: <strong>${fmtPercent(Number(v))}</strong></div>`;
        });
        let extra = "";
        const flags = Array.isArray(row.flags) ? (row.flags as AnyRecord[]) : [];
        if (flags.length > 0) {
          const flagLines = flags.map((flag) => {
            const color = flag.severity === "warning" ? "#ff8a2a" : "#f5d27d";
            return `
              <div style="margin-top:6px; padding-top:5px; border-top:1px dashed rgba(245,200,119,0.2)">
                <div style="color:${color}; font-size:12px; font-weight:600">⚠️ ${flag.label}</div>
                <div style="color:#d9d4c4; margin-top:2px; font-size:11px; max-width:300px">${flag.hint}</div>
              </div>`;
          });
          extra = flagLines.join("");
        }
        return `<div><strong>${first.axisValue}</strong>${lines.join("")}${extra}</div>`;
      }
    },
    legend: { top: 0, textStyle: { color: "#d9d4c4" } },
    grid: { left: 64, right: 24, top: 46, bottom: dates.length > 45 ? 78 : 56 },
    dataZoom:
      dates.length > 45
        ? [
            { type: "inside", startValue, endValue: dates.length - 1 },
            {
              type: "slider",
              startValue,
              endValue: dates.length - 1,
              height: 22,
              bottom: 18,
              borderColor: "rgba(245, 200, 119, 0.25)",
              textStyle: { color: "#d9d4c4" },
              fillerColor: "rgba(100, 198, 189, 0.22)",
              handleStyle: { color: "#f5c877" }
            }
          ]
        : [{ type: "inside" }],
    xAxis: {
      type: "category",
      data: dates,
      axisLabel: { color: "#d9d4c4", rotate: 38 },
      axisLine: { lineStyle: { color: "rgba(245, 200, 119, 0.35)" } }
    },
    yAxis: [
      {
        type: "value",
        name: "净费比",
        axisLabel: { color: "#d9d4c4", formatter: (value: number) => fmtPercent(value) },
        splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } }
      },
      {
        type: "value",
        name: "金额",
        position: "right",
        show: extras.some((m) => m.axis === "money"),
        axisLabel: { color: "#d9d4c4", formatter: (value: number) => fmtMoney(value) },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "净费比",
        type: "line",
        yAxisIndex: 0,
        smooth: true,
        symbol: "circle",
        symbolSize: (_value: unknown, params: { dataIndex: number }) => (anomalies[params.dataIndex] ? 13 : 6),
        itemStyle: {
          color: (params: { dataIndex: number }) => (anomalies[params.dataIndex] ? "#ff5b4d" : "#f5c877")
        },
        lineStyle: { color: "#f5c877", width: 3 },
        areaStyle: { color: "rgba(245, 200, 119, 0.16)" },
        data: ratios.map((value, index) =>
          anomalies[index]
            ? {
                value,
                itemStyle: {
                  color: "#ff5b4d",
                  borderColor: "#fff5e6",
                  borderWidth: 2,
                  shadowColor: "rgba(255, 91, 77, 0.65)",
                  shadowBlur: 10
                }
              }
            : value
        ),
        markPoint: anomalies.some(Boolean)
          ? {
              symbol: "pin",
              symbolSize: 32,
              itemStyle: { color: "#ff5b4d" },
              label: { color: "#fff5e6", fontSize: 11, formatter: "异常" },
              data: anomalies
                .map((flag, index) => (flag ? { coord: [dates[index], ratios[index]] } : null))
                .filter(Boolean) as Array<{ coord: [string, number | null] }>
            }
          : undefined
      },
      {
        name: "7日均线",
        type: "line",
        smooth: true,
        symbol: "none",
        itemStyle: { color: "#60c7bc" },
        lineStyle: { color: "#60c7bc", width: 3 },
        data: movingAverage(ratios, 7, 4)
      },
      ...buildCompareLineSeries("净费比", compareRows, dates.length, (r) => {
        const v = Number(r.netFeeRatio);
        return Number.isFinite(v) ? v : null;
      }),
      // P3.1 用户勾选叠加指标
      ...extras.map((m) => ({
        name: m.label,
        type: "line",
        yAxisIndex: m.axis === "money" ? 1 : 0,
        smooth: true,
        symbol: "none",
        lineStyle: { color: m.color, width: 2, type: "dotted" },
        itemStyle: { color: m.color },
        data: rows.map((r) => {
          const v = Number(r[m.key]);
          return Number.isFinite(v) ? v : null;
        })
      }))
    ]
  };
}

function movingAverage(values: Array<number | null>, windowSize: number, digits = 2) {
  return values.map((_, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = values.slice(start, index + 1).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    if (!window.length) return null;
    const sum = window.reduce((total, value) => total + value, 0);
    return Number((sum / window.length).toFixed(digits));
  });
}

function wordCloudOption(rows: AnyRecord[] = []) {
  const palette = ["#f5c877", "#ff8a2a", "#d9ee62", "#60c7bc", "#72b6e8", "#d65a48"];
  const data = rows
    .map((row, index) => ({ ...row, value: Number(row.value) || 0, itemStyle: { color: palette[index % palette.length] } }))
    .filter((row) => row.value > 0)
    .slice(0, 120);

  return {
    tooltip: { formatter: (params: { name: string; value: number }) => `${params.name}<br/>花费: ${fmtMoney(params.value)}` },
    series: [
      {
        type: "wordCloud",
        shape: "circle",
        left: "center",
        top: "center",
        width: "92%",
        height: "92%",
        sizeRange: [12, 52],
        rotationRange: [-10, 10],
        gridSize: 8,
        data
      }
    ]
  };
}

function pieOption(rows: AnyRecord[] = []) {
  return {
    tooltip: { trigger: "item", formatter: "{b}<br/>{c} ({d}%)" },
    series: [
      {
        type: "pie",
        radius: ["42%", "72%"],
        label: { color: "#d9d4c4", formatter: "{b}\n{d}%" },
        itemStyle: { borderColor: "#10140c", borderWidth: 2 },
        data: rows
      }
    ]
  };
}

function bubbleOption(rows: AnyRecord[] = []) {
  return {
    tooltip: {
      formatter: (params: { data: AnyRecord }) => {
        const value = params.data.value as number[];
        return `${params.data.name}<br/>转化率: ${fmtPercent(value[0])}<br/>花费: ${fmtMoney(value[1])}<br/>成交: ${fmtMoney(value[2])}`;
      }
    },
    grid: { left: 58, right: 24, top: 24, bottom: 42 },
    xAxis: { name: "转化率", axisLabel: { color: "#d9d4c4", formatter: (v: number) => fmtPercent(v) }, splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } } },
    yAxis: { name: "花费", axisLabel: { color: "#d9d4c4" }, splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } } },
    series: [
      {
        type: "scatter",
        data: rows,
        symbolSize: (value: number[]) => Math.max(8, Math.min(64, Math.sqrt(value[2] || 0) / 18)),
        itemStyle: { color: "rgba(245, 200, 119, .72)", borderColor: "#f5c877" },
        label: { show: true, formatter: (p: { data: AnyRecord }) => shortText(String(p.data.name), 8), color: "#f5c877", fontSize: 11 }
      }
    ]
  };
}

function shortText(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootApp />
  </React.StrictMode>
);
