import React from "react";

export type ColumnDef<T extends Record<string, unknown>> = {
  key: string;
  label: string;
  width?: string;
  format?: (value: unknown) => string;
};

type DataTableProps<T extends Record<string, unknown>> = {
  rows: T[];
  columns: ColumnDef<T>[];
  pageSize?: number;
};

export function DataTable<T extends Record<string, unknown>>({ rows, columns, pageSize = 20 }: DataTableProps<T>) {
  const [page, setPage] = React.useState(0);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  const start = Math.min(page, totalPages - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize);

  React.useEffect(() => {
    setPage(0);
  }, [rows]);

  return (
    <div className="tableWrap">
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} style={{ width: column.width }}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, index) => (
            <tr key={`${start + index}-${String(row[columns[0]?.key] || "")}`}>
              {columns.map((column) => {
                const raw = row[column.key];
                return <td key={column.key}>{column.format ? column.format(raw) : String(raw ?? "-")}</td>;
              })}
            </tr>
          ))}
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
