import { fmtMoney, fmtNumber, fmtPercent } from "../utils/format";

type Row = Record<string, unknown>;

export type WeeklyMetric = {
  key: string;
  label: string;
  format: (value: unknown) => string;
};

const defaultMetrics: WeeklyMetric[] = [
  { key: "spend", label: "花费", format: fmtMoney },
  { key: "roi", label: "投产", format: fmtNumber },
  { key: "cpc", label: "点击单价", format: fmtNumber },
  { key: "ctr", label: "点击率", format: fmtPercent },
  { key: "cvr", label: "转化率", format: fmtPercent },
  { key: "customerPrice", label: "客单价", format: fmtNumber },
  { key: "indirectCvr", label: "间接转化率", format: fmtPercent },
  { key: "leadRatio", label: "引潜比", format: fmtPercent },
  { key: "cartCost", label: "加购成本", format: fmtNumber },
  { key: "cpm", label: "千次展现成本", format: fmtNumber }
];

function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function WeeklyMatrix({ rows, metrics = defaultMetrics }: { rows: Row[]; metrics?: WeeklyMetric[] }) {
  const maxByMetric = Object.fromEntries(metrics.map((metric) => [metric.key, Math.max(...rows.map((row) => numeric(row[metric.key])), 1)]));
  const gridTemplateColumns = `190px repeat(${metrics.length}, minmax(132px, 1fr))`;
  const minWidth = `${190 + metrics.length * 132}px`;

  return (
    <div className="matrix">
      <div className="matrixHead" style={{ gridTemplateColumns, minWidth }}>
        <span>日期</span>
        {metrics.map((metric) => (
          <span key={metric.key}>{metric.label}</span>
        ))}
      </div>
      {rows.map((row) => (
        <div className="matrixRow" key={String(row.week)} style={{ gridTemplateColumns, minWidth }}>
          <span className="weekLabel">{String(row.week)}</span>
          {metrics.map((metric, index) => {
            const value = numeric(row[metric.key]);
            const width = `${Math.max(3, (value / maxByMetric[metric.key]) * 100)}%`;
            return (
              <div className="barCell" key={metric.key}>
                <div className={`miniBar tone${index % 6}`} style={{ width }} />
                <span>{metric.format(value)}</span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
