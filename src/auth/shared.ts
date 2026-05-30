// 账号系统共享:类型 + 样式常量
//
// 同时被 useAuth、AuthPages(登录/注册)、AdminView 使用,不放业务代码
// 注意:样式是 React.CSSProperties 而不是 CSS class,跟 main.tsx 里其它内联样式保持一致

import type React from "react";

// ---------- 类型 ----------

export type User = {
  id: number;
  username: string;
  email: string | null;
  role: "admin" | "user";
  status: "active" | "disabled";
};

export type AuthFeatures = {
  open_registration: boolean;
  sms_login: boolean;
  sms_provider: string;
};

export const DEFAULT_FEATURES: AuthFeatures = {
  open_registration: true,
  sms_login: true,
  sms_provider: "dev"
};

export type AuthState = {
  user: User | null;
  loading: boolean;
  features: AuthFeatures;
  refresh: () => Promise<void>;
};

export type Invite = {
  code: string;
  created_by: number;
  created_at: string;
  expires_at: string | null;
  max_uses: number;
  used_count: number;
  note: string | null;
  created_by_username: string | null;
};

export type AdminUser = User & {
  created_at?: string;
  last_seen_at?: string | null;
};

// ---------- 样式 ----------
// 暗金主题;尽量复用,不要每个组件单独写
// 颜色固定字面量(不是 CSS variable)以便单文件 import 即用

export const authShell: React.CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "#10140c",
  padding: 16
};

export const authCard: React.CSSProperties = {
  width: 380,
  padding: 32,
  borderRadius: 12,
  border: "1px solid rgba(245, 200, 119, 0.22)",
  background: "#151808",
  boxShadow: "0 18px 40px rgba(0,0,0,0.45)"
};

export const authTitle: React.CSSProperties = {
  margin: 0,
  marginBottom: 4,
  fontSize: 22,
  color: "#f5c877"
};

export const authSub: React.CSSProperties = {
  margin: 0,
  marginBottom: 24,
  fontSize: 13,
  color: "rgba(245, 240, 223, 0.65)"
};

export const authField: React.CSSProperties = {
  display: "block",
  marginBottom: 14
};

export const authLabel: React.CSSProperties = {
  display: "block",
  marginBottom: 6,
  fontSize: 12,
  color: "rgba(245, 240, 223, 0.7)"
};

export const authInput: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 6,
  border: "1px solid rgba(245, 200, 119, 0.2)",
  background: "#10140c",
  color: "#f5f0df",
  fontSize: 14
};

export const authBtn: React.CSSProperties = {
  width: "100%",
  padding: "11px 12px",
  borderRadius: 6,
  border: "none",
  background: "#f5c877",
  color: "#10140c",
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
  marginTop: 8
};

export const authLink: React.CSSProperties = {
  display: "block",
  textAlign: "center",
  marginTop: 16,
  fontSize: 13,
  color: "#f5c877",
  textDecoration: "none"
};

export const authError: React.CSSProperties = {
  marginTop: 8,
  marginBottom: 4,
  padding: "8px 10px",
  borderRadius: 6,
  background: "rgba(229, 80, 80, 0.12)",
  border: "1px solid rgba(229, 80, 80, 0.4)",
  color: "#ffb3b3",
  fontSize: 13
};
