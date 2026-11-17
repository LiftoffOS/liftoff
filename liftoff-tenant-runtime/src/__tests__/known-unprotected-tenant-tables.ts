// Tenant-scoped tables with no row-level protection. FROZEN DEBT, not a
// permission list, and not triaged.
//
// Each of these carries a `tenant_id` and nothing in the database stops a query
// that forgets to filter on it. That was harmless while a runtime served one
// tenant — the only rows present were that tenant's. It is not harmless now.
//
// The ratchet only tightens. A NEW tenant-scoped table may not join this list:
// classify it when you add it, which for a new table means writing the two
// ALTER statements rather than arguing about a backfill. And when one of these
// gains protection, DELETE ITS LINE — `rls-coverage.test.ts` fails on a stale
// entry, so the list cannot quietly outlive the debt it records.
//
// Regenerate the shape (never to launder a new entry in):
//   npx ts-node -e "import('./src/__tests__/rls-coverage').then(m => \
//     console.log(m.scanTenantTables().filter(t => t.protection === 'none')))"

export const KNOWN_UNPROTECTED_TENANT_TABLES: ReadonlySet<string> = new Set([
  'agent_evidence_totals',
  'agent_execution_locks',
  'agent_run_states',
  'agent_scheduled_invocations',
  'agent_skills',
  'agent_task_ledger',
  'agent_trajectories',
  'autonomous_loop_states',
  'awaiting_input_emissions',
  'chat_turn_locks',
  'compiled_instructions',
  'connector_binding_probes',
  'connector_entity_state',
  'connector_event_seen',
  'connector_tool_smoke_results',
  'deep_research_submissions',
  'delegation_active',
  'dlp_quarantine_audit',
  'failed_events',
  'gmail_watch_subscriptions',
  'goal_ledger',
  'idempotency_result_payloads',
  'learned_role_instructions',
  'learned_role_instructions_history',
  'memories_pending_deep_scan',
  'memory_audit_log',
  'memory_influence_rollup',
  'memory_retrieval_events',
  'mirror_locks',
  'notification_dedup',
  'provenance_edges',
  'provenance_nodes',
  'reactive_subscriptions',
  'reflection_agent_quotas',
  'sandbox_command_audit',
  'sandbox_state',
  'tenant_patterns_etag',
  'tenant_secret_patterns',
  'wake_event_delivery',
  'wake_resume_rate',
  'wake_wait_sets',
  'web_identities',
  'web_inflight_requests',
  'web_profiles',
  'web_sessions',
  'web_waiters',
  'workflow_escalations',
  'workspace_delete_events',
]);
