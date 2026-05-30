// 全局 auth 状态钩子 + 登出工具
//
// 启动时:并行两件事
//   1. GET /api/auth/me  → 拿 user(可能 401,代表未登录)
//   2. GET /api/auth/features → 拿功能开关(open_registration / sms_login)
//
// 失败时 features 维持 DEFAULT_FEATURES(全开),最坏体验是按钮无效

import React from "react";
import { DEFAULT_FEATURES } from "./shared";
import type { AuthFeatures, AuthState, User } from "./shared";

export function useAuth(): AuthState {
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
      .then((json) => {
        if (json) setFeatures({ ...DEFAULT_FEATURES, ...json });
      })
      .catch(() => {
        /* 失败时维持默认全开 */
      });
  }, [refresh]);

  return { user, loading, features, refresh };
}

// 登出:打 logout 接口 + 刷新 auth + 跳回登录页
// 失败也跳登录(本地至少能正常呈现)
export async function logout(refresh: () => Promise<void>) {
  await fetch("/api/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});
  await refresh();
  window.location.hash = "#/login";
}
