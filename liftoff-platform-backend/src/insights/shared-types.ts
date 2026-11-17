// src/insights/shared-types.ts — SOURCE OF TRUTH for both backend and frontend

import type { ChatMessageAttachment } from '../chat-attachments';

// Discriminated union with exhaustive checking enforced in VisualizationRenderer.
// Includes every block type the Liftoff chat assistants may emit inline. The
// insights chat typically emits metric/chart/table/observation blocks; the CAIO
// workforce-planning chat additionally emits org_chart blocks when proposing a
// team structure. Keeping a single union keeps the streaming parser + frontend
// renderer coherent across both chat surfaces.
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
// the Chief AI Officer proposes an org structure. Kept in this shared-types
// file (rather than a CAIO-local module) so the streaming parser has a single
// discriminated union to validate against.
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

export interface InsightsChatThread {
  id: string;
  tenantId: string;
  accountId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

/** NOTE: the wire shape, mirrored into Liftoff-React's src/types/insights.ts.
 *  The definitions actually used at runtime are InsightsChatMessage in
 *  src/insights/chat-repository.ts here, and in src/services/insightsChat.ts
 *  there; this pair is the documented contract between them and is kept in
 *  step with both. */
export interface InsightsChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  visualizationBlocks: VisualizationBlock[] | null;
  /** What the person attached when they sent this message. Metadata only: an
   *  upload's extracted text is a one-turn model input, not transcript. */
  attachments: ChatMessageAttachment[];
  createdAt: string;
}

export interface TimeRangeInput {
  preset?: 'today' | 'yesterday' | 'this_week' | 'last_week' | 'this_month' | 'last_month'
         | 'last_7_days' | 'last_30_days' | 'last_90_days'
         | 'this_quarter' | 'last_quarter' | 'this_year' | 'last_year';
  start?: string;
  end?: string;
}
