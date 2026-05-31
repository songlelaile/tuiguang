import React from "react";
import ReactDOM from "react-dom/client";
import { BarChart3, Boxes, Brain, FileSpreadsheet, Megaphone, Search, Upload, Users, WandSparkles, X } from "lucide-react";
import "./styles.css";
import { EChart } from "./ui/EChart";
import { DataTable, type ColumnDef } from "./ui/DataTable";
import { MetricCard } from "./ui/MetricCard";
import { WeeklyMatrix, type WeeklyMetric } from "./ui/WeeklyMatrix";
import { fmtInt, fmtMoney, fmtNumber, fmtPercent } from "./utils/format";
import { readApiError } from "./lib/api";

// P4.6 账号系统拆出来,单独 chunk
//   - LoginView / RegisterView 跟着主 bundle(未登录用户首屏就要)
//   - AdminView 用 React.lazy,只有 admin 点"管理"才下载
import { LoginView, RegisterView } from "./auth/AuthPages";
import { logout, useAuth } from "./auth/useAuth";
import type { AuthState } from "./auth/shared";
import type { Meta } from "./types/sources";
import { LazyView, lazyWithRetry } from "./components/LazyBoundary";

// P4.6/4.7 lazy chunk;P4.8 加 retry + ErrorBoundary;P4.9 加 nav hover 时的 prefetch
const AdminView = lazyWithRetry(() => import("./auth/AdminView"));
const SourcesView = lazyWithRetry(() => import("./views/Sources"));

// nav 鼠标 hover 就开始下载,等用户真正点击时 chunk 已经在浏览器 cache 里
const prefetchers: Partial<Record<string, () => void>> = {
  admin: () => { import("./auth/AdminView"); },
  sources: () => { import("./views/Sources"); }
};

type ViewKey = "product" | "ad-products" | "keywords" | "crowds" | "contents" | "sources" | "admin";

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
        // readApiError 兜底空 body 的 5xx,避免直接 res.json() 抛
        // "Unexpected end of JSON input"(后端进程挂掉时代理回的空 500)
        if (!res.ok) throw new Error(await readApiError(res));
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
      .then((res) => (res.ok ? res.json() : null))
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
                <button
                  key={item.key}
                  className={active === item.key ? "navItem active" : "navItem"}
                  onClick={() => activateView(item.key)}
                  onMouseEnter={prefetchers[item.key]}
                  onFocus={prefetchers[item.key]}
                >
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
        <LazyView when={!error && active === "sources"} fallback={<div className="stateLine">加载源数据页...</div>}>
          <SourcesView meta={meta} onMetaChange={setMeta} />
        </LazyView>
        <LazyView
          when={!error && active === "admin" && auth.user?.role === "admin"}
          fallback={<div className="stateLine">加载管理后台...</div>}
        >
          <AdminView />
        </LazyView>
        {!error && active === "product" && data && <ProductView data={data} />}
        {!error && active === "ad-products" && data && <AdProductsView data={data} />}
        {!error && active === "keywords" && data && <KeywordView data={data} />}
        {!error && active === "crowds" && data && <CrowdView data={data} />}
        {!error && active === "contents" && data && <ContentView data={data} />}
      </main>
    </div>
  );
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
