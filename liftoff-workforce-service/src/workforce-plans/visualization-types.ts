// Visualization block union — mirrors platform-backend src/insights/shared-types.ts,
// which is the source of truth shared with the frontend renderer.
//
// The CAIO emits `org_chart` when it proposes a team structure. The rest of the
// union is carried verbatim rather than trimmed to org_chart alone, so that a
// block type the frontend already renders is never silently rejected by this
// service's parser and left in the reply as a raw fence.

export type VisualizationBlock =
  | MetricCardBlock
  | BarChartBlock
  | TrendChartBlock
  | TableBlock
  | TextBlock
  | ObservationBlock
  | OrgChartBlock;

export interface MetricCardBlock {
  type: 'metric_card';
  label: string;
  value: string;
  trend?: 'up' | 'down' | 'flat';
  trendText?: string;
  /** When true, an "up" trend is bad (e.g. cost) and renders red instead of green. */
  lowerIsBetter?: boolean;
}

export interface BarChartBlock {
  type: 'bar_chart';
  title: string;
  data: Array<{ label: string; value: number; max?: number }>;
  variant?: 'horizontal' | 'vertical';
  valueSuffix?: string;
}

export interface TrendChartBlock {
  type: 'trend_chart';
  title: string;
  data: Array<{
    label: string;
    value: number;
    max?: number;
    segments?: Array<{ label: string; value: number; color?: string }>;
  }>;
}

export interface TableGroupRow {
  label: string;
  summary: Record<string, string | number>;
  rows: Array<Record<string, string | number>>;
  /** Tags the workforce category so the frontend can filter by feature flag. */
  workforceType?: 'human' | 'ai';
}

export interface TableBlock {
  type: 'table';
  title: string;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number>>;
  groups?: TableGroupRow[];
}

export interface TextBlock {
  type: 'text';
  content: string;
}

export interface ObservationBlock {
  type: 'observation';
  icon: '+' | '!' | '-' | '?';
  content: string;
}

// CAIO-only block. Rendered by the /teams/plan UI as a node/edge diagram when
// the Chief AI Officer proposes an org structure.
export interface OrgChartBlock {
  type: 'org_chart';
  title?: string;
  nodes: Array<{
    id: string;
    label: string;
    type?: string;
    department?: string;
  }>;
  edges: Array<{
    from: string;
    to: string;
    label?: string;
  }>;
}
