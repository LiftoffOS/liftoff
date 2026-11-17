// buildkite overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const BUILDKITE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  BUILDKITE_LIST_PIPELINE_AGENTS: { stableName: 'list_pipeline_agents', categoryOverrides: ["read"] },
  BUILDKITE_GET_META: { stableName: 'get_meta', categoryOverrides: ["read"] },
};

export const BUILDKITE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
