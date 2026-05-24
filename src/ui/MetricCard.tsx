type MetricCardProps = {
  label: string;
  value: string;
  actionLabel?: string;
  onClick?: () => void;
};

export function MetricCard({ label, value, actionLabel, onClick }: MetricCardProps) {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      {actionLabel && <em>{actionLabel}</em>}
    </>
  );

  if (onClick) {
    return (
      <button type="button" className="metricCard metricCardButton" onClick={onClick}>
        {content}
      </button>
    );
  }

  return (
    <div className="metricCard">
      {content}
    </div>
  );
}
