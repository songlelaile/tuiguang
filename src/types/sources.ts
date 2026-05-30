// 源数据接入相关类型 — Meta / Alignment / MetaSource
//
// 同时被 main.tsx 的 App(state useState<Meta | null>)和 src/views/Sources.tsx 使用
// 单独放避免循环依赖

export type AlignmentStatus = "aligned" | "partial" | "mismatch" | "incomplete";

export type AlignmentWarning = {
  table: string;
  label: string;
  kind: "extends_start" | "extends_end" | "missing";
  diffDays: number;
  message: string;
};

export type Alignment = {
  status: AlignmentStatus;
  intersection: { start: string; end: string };
  union: { start: string; end: string };
  perTable: Record<string, { start: string; end: string }>;
  missing: string[];
  warnings: AlignmentWarning[];
};

export type MetaSource = {
  id: string;
  name: string;
  file: string;
  rows: number;
  dateField: string;
  start: string;
  end: string;
  uploaded?: boolean;
  mode?: "default" | "uploaded" | "empty";
  cleared?: boolean;
};

// scenesByView 用 string 不用 ViewKey,避免跨文件类型耦合
// (ViewKey 留在 main.tsx 给路由用,这边消费方按 string 索引一样能查到)
export type Meta = {
  dataDir: string;
  uploadDir?: string;
  sourceDataCleared?: boolean;
  sources: MetaSource[];
  alignment?: Alignment;
  scenes: string[];
  scenesByView?: Partial<Record<string, string[]>>;
};
