import React from "react";
import ReactDOM from "react-dom/client";
import { BarChart3, Boxes, Brain, FileSpreadsheet, Megaphone, Search, Upload, Users, WandSparkles, X } from "lucide-react";
import "./styles.css";
import { EChart } from "./ui/EChart";
import { DataTable, type ColumnDef } from "./ui/DataTable";
import { MetricCard } from "./ui/MetricCard";
import { WeeklyMatrix, type WeeklyMetric } from "./ui/WeeklyMatrix";
import { fmtInt, fmtMoney, fmtNumber, fmtPercent } from "./utils/format";

type ViewKey = "product" | "ad-products" | "keywords" | "crowds" | "contents" | "sources";

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

type Meta = {
  dataDir: string;
  uploadDir?: string;
  sourceDataCleared?: boolean;
  sources: MetaSource[];
  scenes: string[];
  scenesByView?: Partial<Record<ViewKey, string[]>>;
};

type AnyRecord = Record<string, unknown>;
type ProductDrilldown = "payDaily" | "netFeeDaily";
type AdProductDrilldown = "spendDaily" | "gmvDaily" | "roiDaily";
type KeywordDrilldown = "spendDaily";
type CrowdDrilldown = "spendDaily";
type ContentDrilldown = "spendDaily";

const navItems: Array<{ key: ViewKey; label: string; icon: React.ComponentType<{ size?: number }> }> = [
  { key: "product", label: "商品维度分析", icon: Boxes },
  { key: "ad-products", label: "推广商品分析", icon: Megaphone },
  { key: "keywords", label: "推广关键词分析", icon: Search },
  { key: "crowds", label: "推广人群分析", icon: Users },
  { key: "contents", label: "推广内容分析", icon: WandSparkles },
  { key: "sources", label: "源数据", icon: FileSpreadsheet }
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

function App() {
  const [active, setActive] = React.useState<ViewKey>(() => viewFromHash());
  const [filters, setFilters] = React.useState<Filters>({ start: "", end: "", scene: "", q: "" });
  const [meta, setMeta] = React.useState<Meta | null>(null);
  const { data, loading, error } = useApi<Record<string, unknown>>(active, filters);

  React.useEffect(() => {
    fetch("/api/meta")
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
          {navItems.map((item) => {
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
          </div>
        </header>

        {loading && <div className="stateLine">正在按当前筛选重算指标...</div>}
        {error && <div className="stateLine error">数据服务异常：{error}</div>}
        {!error && active === "sources" && <SourcesView meta={meta} onMetaChange={setMeta} />}
        {!error && active === "product" && data && <ProductView data={data} />}
        {!error && active === "ad-products" && data && <AdProductsView data={data} />}
        {!error && active === "keywords" && data && <KeywordView data={data} />}
        {!error && active === "crowds" && data && <CrowdView data={data} />}
        {!error && active === "contents" && data && <ContentView data={data} />}
      </main>
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
        <DataTable rows={meta?.sources || []} columns={columns} pageSize={20} />
      </div>
    </section>
  );
}

function sourceModeLabel(value: unknown) {
  if (value === "uploaded") return "自定义";
  if (value === "empty") return "已清空";
  return "默认";
}

function ProductView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<ProductDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const weekly = (data.weekly as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig =
    drilldown === "payDaily"
      ? { title: "全店支付金额分日走势", option: dailyPayOption(daily) }
      : drilldown === "netFeeDaily"
        ? { title: "全店净费比分日走势", option: dailyNetFeeOption(daily) }
        : null;
  const columns: ColumnDef<AnyRecord>[] = [
    { key: "subjectCode", label: "主体编码", width: "300px" },
    { key: "pay", label: "支付金额", format: fmtMoney },
    { key: "visitors", label: "商品访客数", format: fmtInt },
    { key: "conversionRate", label: "转化率", format: fmtPercent },
    { key: "customerPrice", label: "客单价", format: fmtNumber },
    { key: "annualPay", label: "年累计支付金额", format: fmtMoney },
    { key: "annualPayShare", label: "年累计支付金额占比", format: fmtPercent },
    { key: "feeRatio", label: "费比", format: fmtPercent },
    { key: "refundRatio", label: "退款金额占比", format: fmtPercent },
    { key: "repeatRate", label: "复购率", format: fmtPercent },
    { key: "repeatPayRatio", label: "复购金额占比", format: fmtPercent },
    { key: "cartRate", label: "加购率", format: fmtPercent },
    { key: "pvPerVisitor", label: "人均浏览量", format: fmtNumber },
    { key: "netRoi", label: "链接净ROI", format: fmtNumber }
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
        <MetricCard label="TOP1 支付占比" value={fmtPercent(summary.topShare)} />
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
          <EChart height={420} option={drillConfig.option} />
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
        <DataTable rows={table} columns={columns} pageSize={15} />
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
      ? { title: "推广花费分日走势", option: dailySpendOption(daily) }
      : drilldown === "gmvDaily"
        ? { title: "推广成交金额分日走势", option: dailyGmvOption(daily) }
        : drilldown === "roiDaily"
          ? { title: "推广整体投产分日走势", option: dailyRoiOption(daily) }
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
          <EChart height={420} option={drillConfig.option} />
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
        <DataTable rows={planTable} columns={columns} pageSize={18} />
      </div>
    </section>
  );
}

function KeywordView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<KeywordDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "关键词花费分日走势", option: dailySpendOption(daily) } : null;
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
          <EChart height={420} option={drillConfig.option} />
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
        <DataTable rows={table} columns={columns} pageSize={18} />
      </div>
    </section>
  );
}

function CrowdView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<CrowdDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "人群花费分日走势", option: dailySpendOption(daily) } : null;
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
          <EChart height={420} option={drillConfig.option} />
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
        <DataTable rows={table} columns={columns} pageSize={18} />
      </div>
    </section>
  );
}

function ContentView({ data }: { data: AnyRecord }) {
  const [drilldown, setDrilldown] = React.useState<ContentDrilldown | null>(null);
  const summary = data.summary as AnyRecord;
  const table = (data.table as AnyRecord[]) || [];
  const daily = (data.daily as AnyRecord[]) || [];
  const drillConfig = drilldown === "spendDaily" ? { title: "内容花费分日走势", option: dailySpendOption(daily) } : null;
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
          <EChart height={420} option={drillConfig.option} />
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
        <DataTable rows={table} columns={columns} pageSize={18} />
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

function dailyPayOption(rows: AnyRecord[] = []) {
  return dailyMoneyOption(rows, "pay", "支付金额");
}

function dailySpendOption(rows: AnyRecord[] = []) {
  return dailyMoneyOption(rows, "spend", "花费");
}

function dailyGmvOption(rows: AnyRecord[] = []) {
  return dailyMoneyOption(rows, "gmv", "成交金额");
}

function dailyRoiOption(rows: AnyRecord[] = []) {
  return dailyNumberOption(rows, "roi", "投产");
}

function dailyMoneyOption(rows: AnyRecord[] = [], valueKey: string, metricLabel: string) {
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
      }
    ]
  };
}

function dailyNumberOption(rows: AnyRecord[] = [], valueKey: string, metricLabel: string) {
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
      }
    ]
  };
}

function dailyNetFeeOption(rows: AnyRecord[] = []) {
  const dates = rows.map((row) => String(row.date || ""));
  const ratios = rows.map((row) => {
    const value = Number(row.netFeeRatio);
    return Number.isFinite(value) ? value : null;
  });
  const startValue = Math.max(0, dates.length - 45);

  return {
    tooltip: {
      trigger: "axis",
      valueFormatter: (value: unknown) => fmtPercent(typeof value === "number" ? value : Number(value))
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
      name: "净费比",
      axisLabel: { color: "#d9d4c4", formatter: (value: number) => fmtPercent(value) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,.1)" } }
    },
    series: [
      {
        name: "净费比",
        type: "line",
        smooth: true,
        symbol: "circle",
        symbolSize: 6,
        itemStyle: { color: "#f5c877" },
        lineStyle: { color: "#f5c877", width: 3 },
        areaStyle: { color: "rgba(245, 200, 119, 0.16)" },
        data: ratios
      },
      {
        name: "7日均线",
        type: "line",
        smooth: true,
        symbol: "none",
        itemStyle: { color: "#60c7bc" },
        lineStyle: { color: "#60c7bc", width: 3 },
        data: movingAverage(ratios, 7, 4)
      }
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
    <App />
  </React.StrictMode>
);
