// supabase overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const SUPABASE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  SUPABASE_LIST_ALL_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  // Warehouse read surface (plan §3D path b). Reclassified write→read: the
  // read-only enforcement rides on connector-service's central sqlGuard
  // (query-guardrails: fail-closed real parser + row-cap on the `query` param,
  // both dispatch paths — see SQL_GUARD_OVERRIDES in connector-functions-registry).
  // The data-modifying variant (run_write_sql) is the deliberate gated follow-on
  // (plan §14) and needs the one-slug→two-functions merge split.
  SUPABASE_BETA_RUN_SQL_QUERY: {
    stableName: 'run_query',
    categoryOverrides: ["read"],
    descriptionSuffix:
      ' READ-ONLY: only SELECT statements are permitted and results are row-capped; ' +
      'writes are rejected. For schema discovery, SELECT from information_schema.tables / ' +
      'information_schema.columns.',
  },
  SUPABASE_LIST_ALL_FUNCTIONS: { stableName: 'list_functions', categoryOverrides: ["read"] },
  SUPABASE_LISTS_ALL_BUCKETS: { stableName: 'list_buckets', categoryOverrides: ["read"] },
  SUPABASE_GETS_PROJECT_S_SERVICE_HEALTH_STATUS: { stableName: 'get_service_health', categoryOverrides: ["read"] },
  SUPABASE_CREATE_A_PROJECT: { stableName: 'create_project', categoryOverrides: ["write"] },
  SUPABASE_GETS_PROJECT_S_AUTH_CONFIG: { stableName: 'get_auth_config', categoryOverrides: ["read"] },
  SUPABASE_GETS_PROJECT_S_POSTGRES_CONFIG: { stableName: 'get_postgres_config', categoryOverrides: ["read"] },
};

export const SUPABASE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
