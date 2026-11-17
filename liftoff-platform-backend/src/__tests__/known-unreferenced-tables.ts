// Tables no production query names, as of the day the schema gate landed.
//
// A DEBT LIST, not a permission list — the same contract as
// known-orphan-exports.ts. Every line is a table that exists in the schema and
// that nothing in `src/` mentions. They fall into three kinds and the kind
// matters, because only one of them is a defect:
//
//   * CROSS-SERVICE — this repo provisions the schema, another service reads
//     it. Not reachable from here and not wrong. The checker cannot see the
//     other service, so these live here permanently.
//   * SUPERSEDED — the concept was retired and this artifact outlived it. These
//     are the defects. Each should end in a drop migration.
//   * UNVERIFIED — no production reference and no confirmed story yet. Nobody
//     has traced them; do not delete on the strength of this list alone.
//
// The gate exists to stop the list GROWING. Adding a line is allowed and should
// be rare enough that a reviewer asks why. The answers that do NOT need a line:
// query it, or drop it.
//
// Before dropping anything here: COUNT THE ROWS IN PROD FIRST. A table nothing
// queries can still hold data someone put there on purpose, and that data is a
// statement of intent that deserves reading before it is destroyed.

export const KNOWN_UNREFERENCED_TABLES: readonly string[] = [
  // (agent_quotas was here. Dropped in migration 335 along with
  //  internal_agents.delegates — the two artifacts
  //  that motivated this gate. Removed from the list because a resolved entry
  //  left listed means the next genuinely dead table at that name ships
  //  unnoticed.)

  // ── CROSS-SERVICE — connector-service owns these ────────────────────────
  //
  // All from 013_connectors.sql, which predates the connector-service split.
  // connector-service reads them from its own codebase, so "no reference in
  // this repo" says nothing about whether they are live. Verify against that
  // repo before treating any of them as dead.
  'connector_credentials',
  'connector_health_alerts',
  'connector_health_metrics',
  'connector_incidents',
  'connector_oauth_states',

  // ── UNVERIFIED — no reference, no confirmed story ───────────────────────
  //
  // Nobody has traced these to a retirement or to another consumer. They are
  // listed so the gate can start protecting against NEW debt without demanding
  // this be resolved first — the same trade the export ratchet made.
  'billing_ingest_cursors',
  'correction_config_audit',
  'internal_console_audit',
  'oauth_dynamic_registrations',
  'pending_correction_approvals',
  'post_mortems',
  'prompt_rollout_audit_log',
  'prompt_rollout_traffic_splits',
  'rollout_approvals',
  'usage_snapshots',
  'vendor_billing_snapshots',

  // ── SUPERSEDED — payroll, employee and contractor tables ─────────────────
  //
  // Created by early migrations and read by no code in this repository.
  // Dropping any of them is a separate, data-destroying decision: count the
  // rows first, then drop them in a forward migration.
  'company_bank_accounts',
  'company_benefit_plans',
  'company_contractor_payments',
  'company_contractors',
  'company_earning_codes',
  'company_employees',
  'company_funding_failures',
  'company_pay_schedules',
  'company_payroll_payments',
  'company_payroll_run_earnings',
  'company_payroll_run_items',
  'company_payroll_runs',
  'company_payroll_settings',
  'company_signatories',
  'company_tax_deposits',
  'company_tax_filings',
  'company_tax_param_settings',
  'contractor_bank_accounts',
  'contractor_net_pay_split_items',
  'contractor_net_pay_splits',
  'contractor_tax_statements',
  'employee_bank_accounts',
  'employee_benefit_enrollments',
  'employee_earning_rates',
  'employee_net_pay_split_items',
  'employee_net_pay_splits',
  'employee_post_tax_deductions',
  'employee_tax_param_settings',
  'employee_tax_statements',
];

// ── Columns ──────────────────────────────────────────────────────────────
//
// Same contract as the table list above, one level down: an `ADD COLUMN` that
// no production source names. This is the half that matters most — a column is
// how a feature gets bolted onto an existing concept, and so is what gets
// orphaned when the concept is retired.
//
// Keyed `table::column`. Generic names (id, status, created_at, …) are excluded
// by the checker: "something says `status`" proves nothing about THIS table's.
export const KNOWN_UNREFERENCED_COLUMNS: readonly string[] = [
  // ── SUPERSEDED — the "credits are the only limiter" rework ──────────────
  // Same retirement that took agent_quotas: the tenant runtime's migration 078
  // stripped every max* capacity cap from admission. These three are that
  // decision's residue on the control-plane side, and they read like live
  // ceilings on delegation and scheduling. Delegation depth/fan-out really are
  // capped — by tenant_runtime_config and DELEGATION_HARD_CAPS, not by these.
  'entitlement_snapshots::max_delegation_depth',
  'entitlement_snapshots::max_delegations_per_hour',
  'entitlement_snapshots::max_scheduled_agents',

  // ── UNVERIFIED — no reference, no confirmed story ───────────────────────
  // A kill switch nothing reads is worth a second look before it is trusted in
  // an incident: flipping this today would do nothing.
  'system_config::chat_turn_globally_disabled',
  // Auto-topup: five columns, one feature, no reader.
  'billing_controls::auto_topup_amount_usd',
  'billing_controls::auto_topup_enabled',
  'billing_controls::auto_topup_threshold_usd',
  'billing_controls::last_auto_topup_triggered_at',
  'billing_controls::topup_balance_usd',
  // Payroll / HRIS contact fields — likely written by an importer and read by
  // a surface that spells them differently, but unverified.
  'company_contractors::personal_email',
  'company_contractors::phone_country_code',
  'company_employees::middle_name',
  'company_employees::personal_email',
  'company_employees::phone_country_code',
  // Onboarding milestone timestamps.
  'tenants::company_benefits_configured_at',
  'tenants::company_payroll_completed_at',
  'tenants::company_profile_completed_at',
  'tenants::has_created_ai_team',
  // Misc.
  'accounts::recently_viewed_teams',
  'accounts::verification_expires_at',
  'external_agents::health_check_count',
  'external_agents::inbound_service_token_prefix',
  'restore_drills::source_instance',
  'usage_records::record_type',

  // ── SUPERSEDED — payroll columns ─────────────────────────────────────────
  //
  // Columns of company_contractors and company_employees that no code in this
  // repository reads. Before dropping anything holding an SSN fragment, a bank
  // reference or a tax filing date, count the rows.
  'company_contractors::address_city',
  'company_contractors::address_line1',
  'company_contractors::address_line2',
  'company_contractors::address_postal_code',
  'company_contractors::address_state',
  'company_contractors::date_of_birth',
  'company_contractors::default_net_pay_split_id',
  'company_contractors::onboard_blocking_steps',
  'company_contractors::onboard_remaining_steps',
  'company_contractors::primary_workplace_id',
  'company_contractors::ssn_last_four',
  'company_contractors::ssn_validation_status',
  'company_contractors::termination_date',
  'company_contractors::w9_submitted_at',
  'company_contractors::workplace_id',
  'company_employees::date_of_birth',
  'company_employees::default_net_pay_split_id',
  'company_employees::onboard_blocking_steps',
  'company_employees::onboard_remaining_steps',
  'company_employees::primary_workplace_id',
  'company_employees::residence_city',
  'company_employees::residence_line1',
  'company_employees::residence_line2',
  'company_employees::residence_postal_code',
  'company_employees::residence_state',
  'company_employees::ssn_last_four',
  'company_employees::state_forms_submitted_at',
  'company_employees::termination_date',
  'company_employees::w2_electronic_consent_provided',
  'company_employees::w4_submitted_at',
  'company_employees::workplace_id',
  'company_payroll_settings::ein_masked',
];
