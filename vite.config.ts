import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// P4.4 manualChunks 把大依赖单独打 chunk,享受独立缓存:
//   - 改业务代码只 invalidate 业务 chunk,echarts 几百 KB 不重下
//   - 配合 server 给 .js / .css 加的 immutable Cache-Control,效果叠加
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:5174",
        changeOrigin: true,
        // P4.11 大文件上传 + 服务器解析可能 30s+,默认 30s 会 socket hang up
        timeout: 10 * 60 * 1000,        // 10 分钟
        proxyTimeout: 10 * 60 * 1000
      }
    }
  },
  build: {
    target: "es2020",
    minify: "esbuild",
    chunkSizeWarningLimit: 800,
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          // echarts 是最大的依赖 (~400KB);独立 chunk + 长期缓存
          "echarts": ["echarts", "echarts-wordcloud"],
          "icons": ["lucide-react"]
        }
      }
    }
  }
});
