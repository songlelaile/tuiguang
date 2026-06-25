import React from "react";
import * as echarts from "echarts";
import "echarts-wordcloud";

type EChartProps = {
  option: echarts.EChartsOption;
  height?: number;
};

export function EChart({ option, height = 420 }: EChartProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);
  const [error, setError] = React.useState("");

  // 只初始化一次实例(echarts.init 开销大,treemap 尤甚);卸载时 dispose。
  React.useEffect(() => {
    if (!ref.current) return;
    const resize = () => chartRef.current?.resize();
    try {
      chartRef.current = echarts.init(ref.current, "dark", { renderer: "canvas" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "图表渲染失败");
    }
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  // option 变化只更新(setOption),不再销毁重建 → 切换/筛选/父级重渲染时图表更新快得多。
  React.useEffect(() => {
    if (!chartRef.current) return;
    try {
      chartRef.current.setOption(option, true);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "图表渲染失败");
    }
  }, [option]);

  return (
    <div className="chartFrame" style={{ height }}>
      <div ref={ref} className="chartSurface" />
      {error && (
        <div className="chartError">
          <strong>图表渲染异常</strong>
          <span>{error}</span>
        </div>
      )}
    </div>
  );
}
