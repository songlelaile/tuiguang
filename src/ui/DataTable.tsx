import React from "react";

export type ColumnDef<T extends Record<string, unknown>> = {
  key: string;
  label: string;
  width?: string;
  format?: (value: unknown, row: T) => string;
};

type DataTableProps<T extends Record<string, unknown>> = {
  rows: T[];
  columns: ColumnDef<T>[];
  pageSize?: number;
  /** 若传入，每行左侧出现 ▸ 按钮；点击展开后渲染该函数返回的内容（占满一整行宽度）。 */
  renderExpand?: (row: T) => React.ReactNode;
  /** 若传入，行级判断该行能否展开（用于屏蔽 daily 为空的行）。默认所有行都可展开。 */
  isExpandable?: (row: T) => boolean;
};

export function DataTable<T extends Record<string, unknown>>({
  rows,
  columns,
  pageSize = 20,
  renderExpand,
  isExpandable
}: DataTableProps<T>) {
  const [page, setPage] = React.useState(0);
  const [expandedKeys, setExpandedKeys] = React.useState<Set<string>>(new Set());
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const start = Math.min(page, totalPages - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  React.useEffect(() => {
    setPage(0);
    setExpandedKeys(new Set());
  }, [rows]);

  const expandable = Boolean(renderExpand);
  const rowKey = (row: T, index: number) => `${start + index}-${String(row[columns[0]?.key] || "")}`;

  function toggle(key: string) {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {expandable && <th className="expandColumn" />}
            {columns.map((column) => (
              <th key={column.key} style={{ width: column.width }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, index) => {
            const key = rowKey(row, index);
            const canExpand = expandable && (!isExpandable || isExpandable(row));
            const open = canExpand && expandedKeys.has(key);
            return (
              <React.Fragment key={key}>
                <tr className={open ? "rowOpen" : undefined}>
                  {expandable && (
                    <td className="expandColumn">
                      {canExpand ? (
                        <button
                          type="button"
                          className={`expandToggle ${open ? "open" : ""}`}
                          onClick={() => toggle(key)}
                          aria-label={open ? "收起" : "展开"}
                        >
                          ▸
                        </button>
                      ) : (
                        <span className="expandPlaceholder">·</span>
                      )}
                    </td>
                  )}
                  {columns.map((column) => {
                    const raw = row[column.key];
                    return <td key={column.key}>{column.format ? column.format(raw, row) : String(raw ?? "-")}</td>;
                  })}
                </tr>
                {open && renderExpand && (
                  <tr className="expandRow">
                    <td colSpan={columns.length + (expandable ? 1 : 0)}>{renderExpand(row)}</td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="pager">
        <span>
          {rows.length ? start + 1 : 0}-{Math.min(start + pageSize, rows.length)} / {rows.length}
        </span>
        <button disabled={page <= 0} onClick={() => setPage((prev) => Math.max(0, prev - 1))}>
          上一页
        </button>
        <button disabled={page >= totalPages - 1} onClick={() => setPage((prev) => Math.min(totalPages - 1, prev + 1))}>
          下一页
        </button>
      </div>
    </div>
  );
}
