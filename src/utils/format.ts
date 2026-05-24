export function fmtMoney(value: unknown) {
  const number = toNumber(value);
  if (number === null) return "-";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function fmtInt(value: unknown) {
  const number = toNumber(value);
  if (number === null) return "-";
  return Math.round(number).toLocaleString("zh-CN");
}

export function fmtNumber(value: unknown) {
  const number = toNumber(value);
  if (number === null) return "-";
  return number.toLocaleString("zh-CN", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

export function fmtPercent(value: unknown) {
  const number = toNumber(value);
  if (number === null) return "-";
  return `${(number * 100).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}%`;
}

function toNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}
