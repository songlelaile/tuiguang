import React from "react";
import * as echarts from "echarts";
import "echarts-wordcloud";

type EChartProps = {
  option: echarts.EChartsOption;
  height?: number;
};

export function EChart({ option, height = 420 }: EChartProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    if (!ref.current) return;
    let chart: echarts.ECharts | null = null;
    const resize = () => chart?.resize();
    setError("");

    try {
      chart = echarts.init(ref.current, "dark", { renderer: "canvas" });
      chart.setOption(option, true);
      window.addEventListener("resize", resize);
    } catch (err) {
      setError(err instanceof Error ? err.message : "图表渲染失败");
    }

    return () => {
      window.removeEventListener("resize", resize);
      chart?.dispose();
    };
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
