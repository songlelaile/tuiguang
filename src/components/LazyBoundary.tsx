// 给 React.lazy 加错误边界 + 重试封装
//
// 默认 React.lazy 在 import 失败时(网络抖动 / chunk 404 / 广告拦截器误伤)
// 会让 Suspense 把错误向上抛,没有 ErrorBoundary 接住就会把整棵 React 树卸掉,
// 用户看到白屏。
//
// 两层防护:
//   1) lazyWithRetry — import 失败时自动重试 2 次,间隔指数退避
//   2) LazyBoundary  — 仍失败时显示带"刷新页面"按钮的友好兜底

import React from "react";

export function lazyWithRetry<T extends React.ComponentType<unknown>>(
  importer: () => Promise<{ default: T }>,
  opts: { retries?: number; delayMs?: number } = {}
) {
  const { retries = 2, delayMs = 800 } = opts;
  return React.lazy(async () => {
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        return await importer();
      } catch (e) {
        lastErr = e;
        if (i === retries) break;
        await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
      }
    }
    throw lastErr;
  });
}

type LazyBoundaryProps = {
  children: React.ReactNode;
  fallback: React.ReactNode; // Suspense loading 占位
  errorFallback?: (error: Error) => React.ReactNode;
};

type LazyBoundaryState = { error: Error | null };

export class LazyBoundary extends React.Component<LazyBoundaryProps, LazyBoundaryState> {
  state: LazyBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): LazyBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 上报埋点的位置;暂时只打 console
    console.error("[LazyBoundary] chunk load failed", error, info);
  }

  render() {
    if (this.state.error) {
      if (this.props.errorFallback) return this.props.errorFallback(this.state.error);
      return (
        <div className="stateLine error">
          页面模块加载失败:{this.state.error.message}
          <button
            onClick={() => window.location.reload()}
            style={{
              marginLeft: 12,
              padding: "2px 10px",
              borderRadius: 4,
              border: "1px solid rgba(245, 200, 119, 0.4)",
              background: "transparent",
              color: "#f5c877",
              cursor: "pointer"
            }}
          >
            刷新页面
          </button>
        </div>
      );
    }
    return <React.Suspense fallback={this.props.fallback}>{this.props.children}</React.Suspense>;
  }
}
