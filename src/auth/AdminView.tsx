// 管理员后台:邀请码 + 用户列表
//
// 通过 React.lazy 单独打 chunk,非 admin 用户根本不下载这段代码
// 默认 export(React.lazy 的硬要求)

import React from "react";
import { authBtn, authError, authInput, authLabel } from "./shared";
import type { AdminUser, Invite } from "./shared";
import { readApiError } from "../lib/api";

export default function AdminView() {
  const [tab, setTab] = React.useState<"invites" | "users" | "history">("invites");
  const [invites, setInvites] = React.useState<Invite[]>([]);
  const [users, setUsers] = React.useState<AdminUser[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [err, setErr] = React.useState("");
  const [note, setNote] = React.useState("");
  const [maxUses, setMaxUses] = React.useState(1);

  // P4.15 历史数据看板
  type UploadRow = Record<string, number | string | null>;
  const [history, setHistory] = React.useState<{
    retentionMonths: number | null;
    uploads: UploadRow[];
    coverage: Record<string, number | string | null>;
  } | null>(null);
  const [retentionInput, setRetentionInput] = React.useState("0");
  const [savingRetention, setSavingRetention] = React.useState(false);

  // P4.15(二)按区间在线浏览历史
  const HVIEWS: Array<{ key: string; label: string }> = [
    { key: "product", label: "商品维度" },
    { key: "ad-products", label: "推广商品" },
    { key: "keywords", label: "关键词" },
    { key: "crowds", label: "人群" },
    { key: "contents", label: "内容" }
  ];
  const [hStart, setHStart] = React.useState("");
  const [hEnd, setHEnd] = React.useState("");
  const [hView, setHView] = React.useState("");
  const [hRows, setHRows] = React.useState<Array<Record<string, unknown>> | null>(null);
  const [hLoading, setHLoading] = React.useState(false);

  async function browseHistory(view: string, start: string = hStart, end: string = hEnd) {
    setErr("");
    setHView(view);
    setHLoading(true);
    setHRows(null);
    try {
      const qs = new URLSearchParams();
      if (start) qs.set("start", start);
      if (end) qs.set("end", end);
      const res = await fetch(`/api/admin/history/view/${view}?${qs}`, { credentials: "include" });
      if (!res.ok) throw new Error(await readApiError(res));
      const json = await res.json();
      setHRows(Array.isArray(json?.table) ? json.table : []);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "查询失败");
    } finally {
      setHLoading(false);
    }
  }

  // P4.17 汇总报表:保存(视图+区间)成命名报表,一键重跑 + 导出 CSV
  type Report = { id: string; name: string; view: string; start: string; end: string };
  const [reports, setReports] = React.useState<Report[]>([]);
  const [reportName, setReportName] = React.useState("");
  async function loadReports() {
    try {
      const res = await fetch("/api/admin/reports", { credentials: "include" });
      if (res.ok) setReports((await res.json()).reports || []);
    } catch {
      /* 忽略 */
    }
  }
  async function saveReport() {
    if (!reportName.trim() || !hView) {
      setErr("请先点一个视图查询,并填报表名");
      return;
    }
    setErr("");
    try {
      const res = await fetch("/api/admin/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name: reportName.trim(), view: hView, start: hStart, end: hEnd })
      });
      if (!res.ok) throw new Error(await readApiError(res));
      setReportName("");
      await loadReports();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "保存失败");
    }
  }
  function runReport(r: Report) {
    setHStart(r.start);
    setHEnd(r.end);
    setHView(r.view);
    browseHistory(r.view, r.start, r.end);
  }
  async function deleteReport(id: string) {
    try {
      await fetch(`/api/admin/reports/${id}`, { method: "DELETE", credentials: "include" });
      await loadReports();
    } catch {
      /* 忽略 */
    }
  }
  function exportCsv() {
    if (!hRows || hRows.length === 0) return;
    const cols = Object.keys(hRows[0]).filter((k) => typeof hRows[0][k] !== "object");
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = "﻿" + [cols.join(","), ...hRows.map((row) => cols.map((c) => esc(row[c])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `汇总_${hView}_${hStart || "全部"}_${hEnd || ""}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // P4.8 复制按钮的瞬态反馈:同一时刻只有一个 code 处于"刚被复制"或"复制失败"状态
  const [copyState, setCopyState] = React.useState<{ code: string; ok: boolean } | null>(null);

  async function handleCopyLink(code: string) {
    const url = `${window.location.origin}/#/register?invite=${encodeURIComponent(code)}`;
    if (!navigator.clipboard) {
      setCopyState({ code, ok: false });
      setErr("当前浏览器不支持剪贴板 API,链接是:" + url);
      setTimeout(() => setCopyState(null), 2200);
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopyState({ code, ok: true });
      setTimeout(() => setCopyState(null), 1500);
    } catch (e: unknown) {
      setCopyState({ code, ok: false });
      setErr(e instanceof Error ? `复制失败:${e.message}` : "复制失败");
      setTimeout(() => setCopyState(null), 2200);
    }
  }

  const reload = React.useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      if (tab === "invites") {
        const res = await fetch("/api/admin/invites", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setInvites(json.invites || []);
      } else if (tab === "users") {
        const res = await fetch("/api/admin/users", { credentials: "include" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        setUsers(json.users || []);
      } else {
        const res = await fetch("/api/admin/history", { credentials: "include" });
        if (!res.ok) throw new Error(await readApiError(res));
        const json = await res.json();
        setHistory(json);
        setRetentionInput(json.retentionMonths == null ? "0" : String(json.retentionMonths));
        await loadReports();
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [tab]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  async function createInvite() {
    setErr("");
    try {
      const res = await fetch("/api/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ max_uses: maxUses, note: note || undefined })
      });
      if (!res.ok) throw new Error(await readApiError(res));
      setNote("");
      setMaxUses(1);
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function deleteInvite(code: string) {
    if (!window.confirm(`确定删除邀请码 ${code}?`)) return;
    setErr("");
    try {
      const res = await fetch(`/api/admin/invites/${encodeURIComponent(code)}`, {
        method: "DELETE",
        credentials: "include"
      });
      if (!res.ok) throw new Error(await readApiError(res));
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "操作失败");
    }
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
      if (!res.ok) throw new Error(await readApiError(res));
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "操作失败");
    }
  }

  async function saveRetention() {
    setErr("");
    setSavingRetention(true);
    try {
      const months = Math.max(0, Math.min(120, Math.floor(Number(retentionInput) || 0)));
      const res = await fetch("/api/admin/history/retention", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ months })
      });
      if (!res.ok) throw new Error(await readApiError(res));
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSavingRetention(false);
    }
  }

  async function deleteHistoryData(scope: "all" | "before" | "range") {
    const label =
      scope === "all"
        ? "全部历史数据"
        : scope === "before"
          ? `${hStart || "(未选日期)"} 之前的历史`
          : `${hStart || "?"} ~ ${hEnd || "?"} 区间的历史`;
    if (scope !== "all" && !hStart && !hEnd) {
      setErr("请先在上方选择日期/区间");
      return;
    }
    if (!window.confirm(`确定删除「${label}」?\n不可恢复(只删历史库,uploads 源文件不受影响)。`)) return;
    setErr("");
    try {
      const qs = new URLSearchParams({ scope });
      if (hStart) qs.set("start", hStart);
      if (hEnd) qs.set("end", hEnd);
      const res = await fetch(`/api/admin/history?${qs}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) throw new Error(await readApiError(res));
      const json = await res.json();
      window.alert(`已删除 ${Number(json.removed || 0).toLocaleString()} 行历史,磁盘已即时回收。`);
      await reload();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "删除失败");
    }
  }

  const tabBtn = (active: boolean): React.CSSProperties => ({
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid rgba(245, 200, 119, 0.3)",
    background: active ? "#f5c877" : "transparent",
    color: active ? "#10140c" : "#f5f0df",
    cursor: "pointer",
    fontWeight: 600
  });
  const th: React.CSSProperties = { textAlign: "left", padding: "10px 8px" };
  const td: React.CSSProperties = { padding: "10px 8px" };
  const muted: React.CSSProperties = { fontSize: 12, color: "rgba(245,240,223,0.7)" };
  const fmt = (n: number | string | null | undefined) =>
    n == null || n === "" ? "—" : Number(n).toLocaleString();

  return (
    <div style={{ padding: "8px 0 32px" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
        <button onClick={() => setTab("invites")} style={tabBtn(tab === "invites")}>
          邀请码
        </button>
        <button onClick={() => setTab("users")} style={tabBtn(tab === "users")}>
          用户列表
        </button>
        <button onClick={() => setTab("history")} style={tabBtn(tab === "history")}>
          历史数据
        </button>
      </div>
      {err && <div style={authError}>{err}</div>}

      {tab === "invites" && (
        <div>
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px solid rgba(245, 200, 119, 0.18)",
              background: "#151808",
              marginBottom: 18,
              display: "flex",
              gap: 12,
              alignItems: "flex-end",
              flexWrap: "wrap"
            }}
          >
            <label style={{ flex: 1, minWidth: 200 }}>
              <span style={authLabel}>说明 (选填)</span>
              <input
                style={authInput}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="给谁用 / 备注"
              />
            </label>
            <label style={{ width: 140 }}>
              <span style={authLabel}>可用次数</span>
              <input
                style={authInput}
                type="number"
                min={1}
                value={maxUses}
                onChange={(e) => setMaxUses(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>
            <button
              onClick={createInvite}
              style={{ ...authBtn, width: "auto", padding: "10px 18px", marginTop: 0 }}
            >
              生成邀请码
            </button>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid rgba(245, 200, 119, 0.2)",
                  color: "rgba(245, 240, 223, 0.7)",
                  fontSize: 12
                }}
              >
                <th style={th}>邀请码</th>
                <th style={th}>注册链接</th>
                <th style={th}>用量</th>
                <th style={th}>创建时间</th>
                <th style={th}>说明</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} style={td}>
                    加载中...
                  </td>
                </tr>
              )}
              {!loading && invites.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ ...td, color: "rgba(245,240,223,0.5)" }}>
                    还没有邀请码,点上方按钮生成一个
                  </td>
                </tr>
              )}
              {invites.map((inv) => (
                <tr key={inv.code} style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.08)" }}>
                  <td style={{ ...td, fontFamily: "monospace", color: "#f5c877" }}>{inv.code}</td>
                  <td style={td}>
                    <button
                      onClick={() => handleCopyLink(inv.code)}
                      style={{
                        border: copyState?.code === inv.code && !copyState.ok
                          ? "1px solid rgba(229, 80, 80, 0.4)"
                          : "1px solid rgba(245, 200, 119, 0.3)",
                        background: "transparent",
                        color: copyState?.code === inv.code
                          ? (copyState.ok ? "#a8d8a8" : "#ffb3b3")
                          : "#f5c877",
                        padding: "4px 8px",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 12,
                        whiteSpace: "nowrap"
                      }}
                    >
                      {copyState?.code === inv.code
                        ? (copyState.ok ? "✓ 已复制" : "✗ 复制失败")
                        : "复制注册链接"}
                    </button>
                  </td>
                  <td style={td}>
                    {inv.used_count} / {inv.max_uses}
                  </td>
                  <td style={{ ...td, ...muted }}>
                    {inv.created_at.slice(0, 19).replace("T", " ")}
                  </td>
                  <td style={{ ...td, fontSize: 12 }}>{inv.note || "—"}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={() => deleteInvite(inv.code)}
                      style={{
                        border: "1px solid rgba(229, 80, 80, 0.4)",
                        background: "transparent",
                        color: "#ffb3b3",
                        padding: "4px 10px",
                        borderRadius: 4,
                        cursor: "pointer"
                      }}
                    >
                      删除
                    </button>
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
            <tr
              style={{
                borderBottom: "1px solid rgba(245, 200, 119, 0.2)",
                color: "rgba(245, 240, 223, 0.7)",
                fontSize: 12
              }}
            >
              <th style={th}>ID</th>
              <th style={th}>用户名</th>
              <th style={th}>邮箱</th>
              <th style={th}>角色</th>
              <th style={th}>状态</th>
              <th style={th}>注册时间</th>
              <th style={th}>最近登录</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} style={td}>
                  加载中...
                </td>
              </tr>
            )}
            {!loading &&
              users.map((u) => (
                <tr key={u.id} style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.08)" }}>
                  <td style={td}>{u.id}</td>
                  <td style={td}>{u.username}</td>
                  <td style={{ ...td, ...muted }}>{u.email || "—"}</td>
                  <td style={td}>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 4,
                        background:
                          u.role === "admin"
                            ? "rgba(245, 200, 119, 0.15)"
                            : "rgba(245, 240, 223, 0.08)",
                        color: u.role === "admin" ? "#f5c877" : "#f5f0df",
                        fontSize: 12
                      }}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td style={td}>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 4,
                        background:
                          u.status === "active"
                            ? "rgba(120, 200, 120, 0.15)"
                            : "rgba(229, 80, 80, 0.15)",
                        color: u.status === "active" ? "#a8d8a8" : "#ffb3b3",
                        fontSize: 12
                      }}
                    >
                      {u.status}
                    </span>
                  </td>
                  <td style={{ ...td, ...muted }}>{u.created_at?.slice(0, 10) || "—"}</td>
                  <td style={{ ...td, ...muted }}>
                    {u.last_seen_at?.slice(0, 19).replace("T", " ") || "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button
                      onClick={() =>
                        updateUserStatus(u.id, u.status === "active" ? "disabled" : "active")
                      }
                      style={{
                        border: "1px solid rgba(245, 200, 119, 0.3)",
                        background: "transparent",
                        color: "#f5c877",
                        padding: "4px 10px",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 12
                      }}
                    >
                      {u.status === "active" ? "禁用" : "启用"}
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      )}

      {tab === "history" && (
        <div>
          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px solid rgba(245, 200, 119, 0.18)",
              background: "#151808",
              marginBottom: 18,
              display: "flex",
              gap: 12,
              alignItems: "flex-end",
              flexWrap: "wrap"
            }}
          >
            <label style={{ width: 220 }}>
              <span style={authLabel}>历史保留月数(0 = 永久)</span>
              <input
                style={authInput}
                type="number"
                min={0}
                max={120}
                value={retentionInput}
                onChange={(e) => setRetentionInput(e.target.value)}
              />
            </label>
            <button
              onClick={saveRetention}
              disabled={savingRetention}
              style={{ ...authBtn, width: "auto", padding: "10px 18px", marginTop: 0 }}
            >
              {savingRetention ? "保存中..." : "保存留存策略"}
            </button>
            <div style={{ ...muted, flex: 1, minWidth: 240 }}>
              超过保留期、且这段时间没再上传刷新过的历史会被每天自动清理(磁盘在下次维护时回收)。
              普通用户始终只留最新一份上传,不受此设置影响。
            </div>
          </div>

          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px solid rgba(229, 80, 80, 0.28)",
              background: "#1a0f0c",
              marginBottom: 18
            }}
          >
            <div style={{ ...muted, marginBottom: 10, color: "#ffb3b3" }}>
              ⚠ 删除历史数据(不可恢复;只删历史库,uploads 源文件不受影响;删完立即回收磁盘)
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button
                onClick={() => deleteHistoryData("all")}
                style={{ border: "1px solid rgba(229,80,80,0.5)", background: "rgba(229,80,80,0.85)", color: "#fff", padding: "8px 14px", borderRadius: 6, cursor: "pointer", fontWeight: 600 }}
              >
                清空全部历史
              </button>
              <button
                onClick={() => deleteHistoryData("before")}
                style={{ border: "1px solid rgba(229,80,80,0.4)", background: "transparent", color: "#ffb3b3", padding: "8px 14px", borderRadius: 6, cursor: "pointer" }}
              >
                删除「开始」日期之前
              </button>
              <button
                onClick={() => deleteHistoryData("range")}
                style={{ border: "1px solid rgba(229,80,80,0.4)", background: "transparent", color: "#ffb3b3", padding: "8px 14px", borderRadius: 6, cursor: "pointer" }}
              >
                删除「开始~结束」区间
              </button>
              <span style={muted}>区间/早于:用下方「历史在线浏览」里选的日期</span>
            </div>
          </div>

          {history?.coverage && (
            <div style={{ ...muted, marginBottom: 14 }}>
              历史库覆盖:共 {fmt(history.coverage.uploads)} 次上传 · 商品 {fmt(history.coverage.product_rows)} 行 ·
              推广商品 {fmt(history.coverage.ad_item_rows)} 行 · 推广内容 {fmt(history.coverage.content_rows)} 行 ·
              关键词 {fmt(history.coverage.keyword_rows)} 行 · 人群 {fmt(history.coverage.crowd_rows)} 行
            </div>
          )}

          <div
            style={{
              padding: 16,
              borderRadius: 10,
              border: "1px solid rgba(245, 200, 119, 0.18)",
              background: "#151808",
              marginBottom: 18
            }}
          >
            <div style={{ ...muted, marginBottom: 10 }}>
              历史在线浏览:选日期区间 → 点某个视图,按历史库该区间的数据重新计算(口径与正常视图完全一致)
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 12 }}>
              <label style={{ width: 160 }}>
                <span style={authLabel}>开始</span>
                <input style={authInput} type="date" value={hStart} onChange={(e) => setHStart(e.target.value)} />
              </label>
              <label style={{ width: 160 }}>
                <span style={authLabel}>结束</span>
                <input style={authInput} type="date" value={hEnd} onChange={(e) => setHEnd(e.target.value)} />
              </label>
              {HVIEWS.map((v) => (
                <button key={v.key} onClick={() => browseHistory(v.key)} style={{ ...tabBtn(hView === v.key), padding: "8px 12px" }}>
                  {v.label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <input
                style={{ ...authInput, width: 200, marginTop: 0 }}
                placeholder="报表名(保存当前视图+区间)"
                value={reportName}
                onChange={(e) => setReportName(e.target.value)}
              />
              <button onClick={saveReport} style={{ ...tabBtn(false), padding: "8px 12px" }}>
                保存为报表
              </button>
              {reports.map((r) => (
                <span
                  key={r.id}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    border: "1px solid rgba(245,200,119,0.3)",
                    borderRadius: 6,
                    padding: "4px 8px",
                    fontSize: 12
                  }}
                >
                  <button
                    onClick={() => runReport(r)}
                    title={`${r.view} ${r.start || "全部"}~${r.end || ""}`}
                    style={{ background: "transparent", border: "none", color: "#f5c877", cursor: "pointer", fontSize: 12 }}
                  >
                    ▶ {r.name}
                  </button>
                  <button
                    onClick={() => deleteReport(r.id)}
                    style={{ background: "transparent", border: "none", color: "#ffb3b3", cursor: "pointer", fontSize: 12 }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            {hLoading && <div style={muted}>计算中...</div>}
            {!hLoading && hRows && (
              <div style={{ maxHeight: 360, overflow: "auto" }}>
                <div style={{ ...muted, marginBottom: 6, display: "flex", gap: 12, alignItems: "center" }}>
                  <span>共 {fmt(hRows.length)} 行(显示前 100)</span>
                  {hRows.length > 0 && (
                    <button onClick={exportCsv} style={{ ...tabBtn(false), padding: "4px 10px", fontSize: 12 }}>
                      导出 CSV(全部)
                    </button>
                  )}
                </div>
                {hRows.length > 0 && (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: "rgba(245,240,223,0.7)" }}>
                        {Object.keys(hRows[0])
                          .filter((k) => typeof hRows[0][k] !== "object")
                          .map((k) => (
                            <th key={k} style={{ ...th, padding: "6px 8px", whiteSpace: "nowrap" }}>
                              {k}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {hRows.slice(0, 100).map((row, i) => (
                        <tr key={i} style={{ borderBottom: "1px solid rgba(245,200,119,0.06)" }}>
                          {Object.keys(hRows[0])
                            .filter((k) => typeof hRows[0][k] !== "object")
                            .map((k) => (
                              <td key={k} style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                                {String(row[k] ?? "")}
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr
                style={{
                  borderBottom: "1px solid rgba(245, 200, 119, 0.2)",
                  color: "rgba(245, 240, 223, 0.7)",
                  fontSize: 12
                }}
              >
                <th style={th}>上传时间</th>
                <th style={th}>数据区间</th>
                <th style={th}>商品</th>
                <th style={th}>推广商品</th>
                <th style={th}>推广内容</th>
                <th style={th}>关键词</th>
                <th style={th}>人群</th>
                <th style={th}>备注</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={8} style={td}>
                    加载中...
                  </td>
                </tr>
              )}
              {!loading && (!history || history.uploads.length === 0) && (
                <tr>
                  <td colSpan={8} style={{ ...td, color: "rgba(245,240,223,0.5)" }}>
                    暂无上传归档
                  </td>
                </tr>
              )}
              {!loading &&
                history?.uploads.map((u) => (
                  <tr key={String(u.id)} style={{ borderBottom: "1px solid rgba(245, 200, 119, 0.08)" }}>
                    <td style={{ ...td, ...muted }}>
                      {String(u.uploaded_at || "").slice(0, 19).replace("T", " ")}
                    </td>
                    <td style={{ ...td, ...muted }}>
                      {u.date_min || "—"} ~ {u.date_max || "—"}
                    </td>
                    <td style={td}>{fmt(u.product_rows)}</td>
                    <td style={td}>{fmt(u.ad_item_rows)}</td>
                    <td style={td}>{fmt(u.content_rows)}</td>
                    <td style={td}>{fmt(u.keyword_rows)}</td>
                    <td style={td}>{fmt(u.crowd_rows)}</td>
                    <td style={{ ...td, fontSize: 12 }}>{u.note || "—"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
