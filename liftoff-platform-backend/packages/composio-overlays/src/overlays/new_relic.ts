// new_relic overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const NEW_RELIC_OVERLAYS: Record<string, ComposioToolOverlay> = {
  NEW_RELIC_GET_APPLICATIONS: { stableName: 'list_applications', categoryOverrides: ["read"] },
  NEW_RELIC_GET_ALERT_POLICIES: { stableName: 'list_alert_policies', categoryOverrides: ["read"] },
  NEW_RELIC_GET_ALERT_CONDITIONS: { stableName: 'list_alert_conditions', categoryOverrides: ["read"] },
  NEW_RELIC_GET_ALERT_CHANNELS: { stableName: 'list_alert_channels', categoryOverrides: ["read"] },
  NEW_RELIC_GET_BROWSER_APPLICATIONS: { stableName: 'list_browser_applications', categoryOverrides: ["read"] },
  NEW_RELIC_CREATE_ALERT_POLICY: { stableName: 'create_alert_policy', categoryOverrides: ["write"] },
};

export const NEW_RELIC_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
