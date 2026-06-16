// 源数据接入页(/sources)+ 跨周期归档下载
//
// 三个组件:SourcesView(主) / AlignmentTimeline(时间线) / HistoryArchivePanel(历史下载)
// 都只在 sources 页用,React.lazy 单独打 chunk;不点"源数据"导航就不下载
//
// 这页含上传 / 清空 / 时间线对齐校验 / 跨周期 zip 下载,功能多但跟其它 view 完全独立

import React from "react";
import { DataTable, type ColumnDef } from "../ui/DataTable";
import { fmtInt } from "../utils/format";
import type { Alignment, AlignmentStatus, Meta, MetaSource } from "../types/sources";
import { readApiError } from "../lib/api";

// 5 张源表槽位
const sourceUploadSlots = [
  { id: "product", label: "商品维度", accept: ".xlsx,.xls", hint: "XLSX / XLS" },
  { id: "adItem", label: "推广商品", accept: ".csv", hint: "CSV" },
  { id: "keyword", label: "推广关键词", accept: ".csv", hint: "CSV" },
  { id: "crowd", label: "推广人群", accept: ".csv", hint: "CSV" },
  { id: "content", label: "推广内容", accept: ".csv", hint: "CSV" }
];

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

function sourceModeLabel(value: unknown) {
  if (value === "uploaded") return "自定义";
  if (value === "empty") return "已清空";
  return "默认";
}

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

// ============ 历史归档 ============

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

// P4.8 接受一个 `refreshSignal` 任意值;父级在上传 / 清空后传新值过来,
// useEffect 检测到 prop 变化 → 重新拉 coverage,避免显示陈旧的 uploads 计数
function HistoryArchivePanel({ refreshSignal }: { refreshSignal?: unknown }) {
  const [coverage, setCoverage] = React.useState<CoverageInfo | null>(null);
  const [error, setError] = React.useState("");
  const [exportStart, setExportStart] = React.useState("");
  const [exportEnd, setExportEnd] = React.useState("");
  const userTouchedDates = React.useRef(false);

  React.useEffect(() => {
    fetch("/api/history/coverage")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        setCoverage(data);
        // 用户没手动调过日期前,默认填库覆盖范围;之后保留用户的选择
        if (!userTouchedDates.current) {
          const start = data.product_date_min || data.ad_item_date_min || "";
          const end = data.product_date_max || data.ad_item_date_max || "";
          setExportStart(start || "");
          setExportEnd(end || "");
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"));
  }, [refreshSignal]);

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
              <input
                type="date"
                value={exportStart}
                onChange={(e) => { userTouchedDates.current = true; setExportStart(e.target.value); }}
                min={coverageStart}
                max={coverageEnd}
              />
            </label>
            <label>
              <span>结束日期</span>
              <input
                type="date"
                value={exportEnd}
                onChange={(e) => { userTouchedDates.current = true; setExportEnd(e.target.value); }}
                min={coverageStart}
                max={coverageEnd}
              />
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

// ============ 生意参谋多日表合并 ============

type BaPreflightReport = {
  fileCount: number;
  parsedCount: number;
  detectedStart: string;
  detectedEnd: string;
  headerStandard: string[];
  columnCount: number;
  files: Array<{ name: string; date: string; rows: number; headerOk?: boolean; isRange?: boolean; dateMismatchCount?: number }>;
  headerMismatches: Array<{ name: string; reason: string }>;
  headerMissing: Array<{ name: string; reason: string }>;
  noDateFiles: string[];
  rangeFiles: Array<{ name: string; dates: string[] }>;
  duplicateDates: Array<{ date: string; files: string[] }>;
  missingDates: string[];
  dateRowMismatches: Array<{ name: string; expected: string; foundSample: string[]; count: number }>;
  totalRows: number;
  blocking: string[];
  needsResolution: boolean;
  canMerge: boolean;
};

type BaSummary = { fileCount: number; rows: number; columns: number; firstDate: string; lastDate: string };

function BusinessAdvisorMergePanel({ onMetaChange }: { onMetaChange: (meta: Meta) => void }) {
  const [files, setFiles] = React.useState<File[]>([]);
  const [store, setStore] = React.useState("");
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [report, setReport] = React.useState<BaPreflightReport | null>(null);
  const [jobId, setJobId] = React.useState("");
  const [resolution, setResolution] = React.useState<Record<string, string>>({});
  const [result, setResult] = React.useState<{ summary: BaSummary; downloadUrl: string } | null>(null);
  const [message, setMessage] = React.useState("");
  const [inputKey, setInputKey] = React.useState(0);

  function clearReport() {
    setReport(null);
    setJobId("");
    setResolution({});
    setResult(null);
  }

  async function runPreflight() {
    if (!files.length) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      const fd = new FormData();
      files.forEach((f) => fd.append("files", f));
      if (start) fd.append("start", start);
      if (end) fd.append("end", end);
      const res = await fetch("/api/ba-merge/preflight", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await readApiError(res));
      const payload = await res.json();
      const rep: BaPreflightReport = payload.report;
      setJobId(payload.jobId);
      setReport(rep);
      // 默认每个重复日期保留文件名排序靠后的一份（通常是后导出的），用户可改
      const def: Record<string, string> = {};
      for (const d of rep.duplicateDates) def[d.date] = [...d.files].sort()[d.files.length - 1];
      setResolution(def);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "预检失败");
      clearReport();
    } finally {
      setBusy(false);
    }
  }

  async function runMerge() {
    if (!jobId || !report) return;
    setBusy(true);
    setMessage("");
    try {
      const res = await fetch("/api/ba-merge/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, resolution, store, start, end, applyAsProduct: true })
      });
      if (!res.ok) throw new Error(await readApiError(res));
      const payload = await res.json();
      setResult({ summary: payload.summary, downloadUrl: payload.downloadUrl });
      if (payload.meta) onMetaChange(payload.meta);
      const s: BaSummary = payload.summary;
      setMessage(`合并完成：${fmtInt(s.fileCount)} 个文件 / ${fmtInt(s.rows)} 行 / ${s.columns} 列 / ${s.firstDate} 至 ${s.lastDate}${payload.applied ? "，已应用为「商品维度」源表并入库" : ""}`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "合并失败");
    } finally {
      setBusy(false);
    }
  }

  const hasBlocking = Boolean(report && report.blocking.length);

  return (
    <div className="panel">
      <div className="panelHeader">
        <div>
          <p className="eyebrow">数据接入 · 自动合并</p>
          <h2>生意参谋多日表合并</h2>
        </div>
        <span className="pill">{files.length ? `已选 ${files.length} 个文件` : "选择多份日表 .xls"}</span>
      </div>
      <div className="baHint">
        选择一批 <code>【生意参谋平台】商品_全部_YYYY-MM-DD_…xls</code> 日表，先预检（日期完整性 / 表头一致 / 统计日期匹配 / 重复日期），确认无误后合并成单个 .xlsx 并应用为「商品维度」源表。
      </div>
      <div className="uploadGrid">
        <label key={`ba-${inputKey}`} className="uploadSlot">
          <span>生意参谋日表（可多选）</span>
          <strong>{files.length ? `${files.length} 个文件` : "选择文件"}</strong>
          <em>.xls / .xlsx</em>
          <input
            type="file"
            accept=".xls,.xlsx"
            multiple
            onChange={(e) => {
              const picked = Array.from(e.target.files || []).filter((f) => /\.(xls|xlsx)$/i.test(f.name));
              setFiles(picked);
              clearReport();
            }}
          />
        </label>
      </div>
      <div className="historyExportRow">
        <label>
          <span>店铺 / 品牌名（可选）</span>
          <input type="text" value={store} placeholder="用于命名输出文件" onChange={(e) => setStore(e.target.value)} />
        </label>
        <label>
          <span>开始日期（可选，校验缺失）</span>
          <input type="date" value={start} onChange={(e) => { setStart(e.target.value); clearReport(); }} />
        </label>
        <label>
          <span>结束日期（可选，校验缺失）</span>
          <input type="date" value={end} onChange={(e) => { setEnd(e.target.value); clearReport(); }} />
        </label>
      </div>
      <div className="uploadActions">
        <button type="button" className="primaryButton" disabled={!files.length || busy} onClick={runPreflight}>
          {busy && !report ? "预检中" : "预检"}
        </button>
        {report && !hasBlocking && (
          <button type="button" className="primaryButton" disabled={busy} onClick={runMerge}>
            {busy ? "合并中" : "执行合并并应用为商品维度源表"}
          </button>
        )}
        {(files.length > 0 || report) && (
          <button type="button" className="iconTextButton" disabled={busy} onClick={() => { setFiles([]); clearReport(); setMessage(""); setInputKey((k) => k + 1); }}>
            清除
          </button>
        )}
      </div>

      {report && (
        <div className="baReport">
          <div className="historyMeta">
            <span>文件数 <strong>{fmtInt(report.fileCount)}</strong></span>
            <span>识别日期 <strong>{report.detectedStart || "—"}</strong> ~ <strong>{report.detectedEnd || "—"}</strong></span>
            <span>合计数据行 <strong>{fmtInt(report.totalRows)}</strong></span>
            <span>表头列数 <strong>{report.columnCount}</strong></span>
          </div>

          {hasBlocking && (
            <div className="baIssue baIssueDanger">
              <strong>无法合并，请先修复：</strong>
              <ul>
                {report.headerMissing.map((h, i) => <li key={`hm-${i}`}>{h.name}：{h.reason}</li>)}
                {report.headerMismatches.map((h, i) => <li key={`hx-${i}`}>{h.name}：{h.reason}</li>)}
                {report.noDateFiles.map((n, i) => <li key={`nd-${i}`}>{n}：文件名中无法识别日期</li>)}
              </ul>
            </div>
          )}

          {report.duplicateDates.length > 0 && (
            <div className="baIssue baIssueWarn">
              <strong>发现重复日期（同一天多份文件），请选择每个日期保留哪一份：</strong>
              {report.duplicateDates.map((d) => (
                <div key={d.date} className="baDupRow">
                  <span className="baDupDate">{d.date}</span>
                  <select
                    value={resolution[d.date] || ""}
                    onChange={(e) => setResolution((prev) => ({ ...prev, [d.date]: e.target.value }))}
                  >
                    {d.files.map((name) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
              ))}
            </div>
          )}

          {report.missingDates.length > 0 && (
            <div className="baIssue baIssueWarn">
              <strong>区间内缺失 {report.missingDates.length} 天：</strong>
              <span className="baInline">{report.missingDates.join("、")}</span>
            </div>
          )}

          {report.dateRowMismatches.length > 0 && (
            <div className="baIssue baIssueWarn">
              <strong>以下文件存在「统计日期 ≠ 文件名日期」的行（仍可合并，统计日期将以文件名日期为准）：</strong>
              <ul>
                {report.dateRowMismatches.map((m, i) => (
                  <li key={`drm-${i}`}>{m.name}：期望 {m.expected}，发现 {m.foundSample.join("/")} 等 {fmtInt(m.count)} 行</li>
                ))}
              </ul>
            </div>
          )}

          {report.rangeFiles.length > 0 && (
            <div className="baIssue baIssueWarn">
              <strong>以下文件名含跨日期区间（非单日导出），将按首个日期归类：</strong>
              <span className="baInline">{report.rangeFiles.map((r) => r.name).join("、")}</span>
            </div>
          )}

          {!hasBlocking && report.duplicateDates.length === 0 && report.missingDates.length === 0 && report.dateRowMismatches.length === 0 && (
            <div className="baIssue baIssueOk">校验通过，可直接合并。</div>
          )}
        </div>
      )}

      {result && (
        <div className="historyExportRow baResultRow">
          <a className="exportButton" href={result.downloadUrl} download>
            下载合并后的 .xlsx
          </a>
        </div>
      )}

      {message && <div className="uploadNotice">{message}</div>}
    </div>
  );
}

// ============ 主组件 ============

export default function SourcesView({ meta, onMetaChange }: { meta: Meta | null; onMetaChange: (meta: Meta) => void }) {
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
      if (!response.ok) throw new Error(await readApiError(response));
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
      if (!response.ok) throw new Error(await readApiError(response));
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
      {/* 工作动线:先「多日汇总合并」→ 校验无误后自动同步给下方「商品维度」源表 */}
      <BusinessAdvisorMergePanel onMetaChange={onMetaChange} />
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
            const src = meta?.sources?.find((s) => s.id === slot.id);
            // 已接入状态:已选新文件优先显示文件名;否则展示该源表当前库内状态(合并应用 / 手动上传成功后同步)
            const filled = !file && Boolean(src && (src.mode === "uploaded" || src.uploaded));
            return (
              <label key={`${slot.id}-${inputKey}`} className={`uploadSlot${filled ? " uploadSlotFilled" : ""}`}>
                <span>{slot.label}{filled && <i className="slotBadge">已接入</i>}</span>
                <strong>{file?.name || (filled ? `${fmtInt(src!.rows)} 行` : "选择文件")}</strong>
                <em>{file ? slot.hint : filled ? `${src!.start || "—"} ~ ${src!.end || "—"}` : slot.hint}</em>
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
      {/* P4.8 上传成功后 meta 引用会刷新,HistoryArchivePanel 借此重拉 coverage */}
      <HistoryArchivePanel refreshSignal={meta} />
    </section>
  );
}
