/**
 * Typed event registry. Every posthog.capture() in the app routes through
 * `track()` from analytics.ts, which validates the event name and property
 * shape against this map at compile time.
 *
 * Naming convention: snake_case, domain prefix, past-tense for state changes
 * (`tenant_switched`, not `switch_tenant`).
 */
import type { WorkspaceAiVendor } from '../services/tenants'

/**
 * Slugs of the /compare/* comparison pages. Kept as a literal union here rather
 * than derived from src/data/comparisons so that adding a page is a deliberate
 * analytics decision and `tsc` catches a slug that was never registered.
 */
export type ComparisonSlug =
  | 'chatgpt'
  | 'codex'
  | 'claude'
  | 'claude-code'
  | 'n8n'
  | 'make'
  | 'genspark'
  | 'openclaw'
  | 'hermes'
  | 'tasklet'
  | 'dust'
  | 'viktor'
  | 'manus'

export interface AnalyticsEventMap {
  // --- Auth & identity ---------------------------------------------------
  sign_in_started: { method: 'google' | 'email' | 'passkey' | 'passkey_conditional' }
  sign_in_completed: { method: 'google' | 'email' | 'passkey' | 'passkey_conditional'; mfa_required: boolean }
  sign_in_failed: { method: string; reason: string }
  sign_up_completed: { method: 'google' | 'email' }
  email_verification_completed: Record<string, never>
  email_verification_resent: Record<string, never>
  mfa_challenge_submitted: { success: boolean }
  sign_out: Record<string, never>
  password_reset_requested: Record<string, never>
  password_changed: Record<string, never>
  email_change_initiated: Record<string, never>
  email_change_canceled: Record<string, never>
  passkey_registered: Record<string, never>
  passkey_removed: { passkey_id: string }
  mfa_totp_enroll_started: Record<string, never>
  mfa_totp_enroll_completed: Record<string, never>
  mfa_totp_disabled: Record<string, never>
  logout_all_devices: Record<string, never>
  // Fired once per session start when an identified user is denied
  // access (accessGranted: false). Signup is open, so it is not expected
  // to fire; email_domain shows which domain was refused if it does.
  access_gate_blocked: { email_domain: string }

  // --- Onboarding wizard -------------------------------------------------
  onboarding_started: Record<string, never>
  onboarding_step_completed: {
    step: 'welcome' | 'workspace_name' | 'role' | 'plan' | 'payment' | 'invites' | 'all_set'
    step_index: 0 | 1 | 2 | 3 | 4 | 5 | 6
  }
  onboarding_plan_selected: { plan_id: string; billing_period: 'monthly' | 'yearly' }
  onboarding_payment_enterprise_skipped: Record<string, never>
  onboarding_invites_sent: { count: number; partial_failures: number }
  onboarding_invites_skip_modal_opened: Record<string, never>
  onboarding_invites_skipped: Record<string, never>
  onboarding_resumed: { resumed_at_step: number }
  onboarding_completed: { selected_plan: string | null; invites_sent: number }
  onboarding_finished: Record<string, never>

  // --- Tenant lifecycle --------------------------------------------------
  tenant_auto_provisioned: { tenant_id: string }
  // Fired when a tenant row is inserted (backfill source) OR via runtime
  // tenant-creation flows once those instrument it. tenant_auto_provisioned
  // is a narrower signal (only fires on the auto-provision path during
  // first sign-in); tenant_created covers every origin.
  tenant_created: { tenant_id: string }
  tenant_switched: { from_tenant_id: string | null; to_tenant_id: string }
  tenant_renamed: { tenant_id: string }
  invitation_accepted: { tenant_id: string }
  member_invited: { tenant_id: string; role: 'owner' | 'admin' | 'member' | 'viewer' }
  member_removed: { tenant_id: string }
  member_role_changed: { tenant_id: string; new_role: 'owner' | 'admin' | 'member' | 'viewer' }
  invitation_revoked: { tenant_id: string }
  invitation_role_changed: { tenant_id: string; new_role: 'owner' | 'admin' | 'member' | 'viewer' }

  // --- Agents (entity-level lifecycle) -----------------------------------
  // Unified namespace covering both internal (template-defined, fka "AI
  // Team") and external (A2A-connected) agents. Distinguish with the `kind`
  // property — props that only apply to one kind are optional. The UI
  // labels these as "Agents" externally, but at the data layer they're
  // just agents and PostHog queries shouldn't have to UNION two events to
  // ask "how many agents were created".
  agent_created: {
    agent_id: string
    kind: 'internal' | 'external'
    // internal-only:
    source?: 'team_build' | 'team_explore' | 'team_plan' | 'team_message' | 'team_update_optimize'
    status?: 'active' | 'draft'
    integrations_count?: number
    // external-only:
    transport_type?: string
    connection_type?: string
    collaboration_mode?: string
    allowed_teams_count?: number
  }
  agent_updated: { agent_id: string; kind: 'internal' | 'external' }
  agent_deleted: { agent_id: string; kind: 'internal' | 'external' }
  agent_status_changed: {
    agent_id: string
    kind: 'internal' | 'external'
    // Union of both internal- and external-kind statuses; filter by kind to
    // narrow. Internal: active|paused|draft. External: pending|connected|
    // disconnected|error|pending_review.
    status:
      | 'active' | 'paused' | 'draft'
      | 'pending' | 'connected' | 'disconnected' | 'error' | 'pending_review'
  }
  agent_optimized: { agent_id: string; kind: 'internal' }
  agent_rolled_back: { agent_id: string; kind: 'internal' | 'external'; to_version: number }
  agent_viewed: { agent_id: string; kind: 'internal' | 'external'; source: 'dashboard' | 'teams_list' | 'direct_link' }
  agent_webhook_provisioned: { agent_id: string; kind: 'internal' }
  agent_webhook_credentials_reset: { agent_id: string; kind: 'internal' }
  agent_webhook_updated: { agent_id: string; kind: 'internal' }
  agent_chat_opened: { agent_id: string }
  agent_chat_message_sent: { agent_id: string; thread_id: string }
  agent_chat_new_thread: { agent_id: string }
  agent_chat_thread_switched: { agent_id: string; thread_id: string }
  agent_chat_history_opened: { agent_id: string }
  agent_chat_share_created: { agent_id: string; thread_id: string }
  agent_chat_share_opened: { share_id: string }
  /** AgentChatPage right-pane toggle that surfaces the Anchor Browser live
   *  view. Only fired on /dashboard/agents/chat; never from the CAIO chat
   *  on /dashboard/agents/plan (no leftActions there). */
  agent_chat_browser_pane_toggled: { agent_id: string; thread_id: string; open: boolean }
  /** AgentChatPage right-pane toggle that surfaces the messaging options
   *  (Slack, Microsoft Teams, AI coding tool). Shares the slot with the
   *  browser live view, so only one of the two can be open. */
  agent_chat_more_pane_toggled: { agent_id: string; open: boolean }
  /** Hybrid execution engine — chat-turn handler routed the user message
   *  to the resume / interrupt path instead of producing a normal LLM turn. */
  agent_chat_hybrid_event: {
    agent_id: string
    hybrid_event: 'clarification_accepted' | 'interrupt_delivered'
  }

  // --- AgentBuilder wizard ("Custom Hire") -------------------------------
  team_builder_started: {
    entry: 'fresh' | 'role_prefilled'
  }
  team_builder_step_completed: {
    step: 'role' | 'responsibilities' | 'integrations'
    step_index: 1 | 2 | 3
  }
  team_builder_distill_started: Record<string, never>
  team_builder_distill_stage_changed: { stage: string }
  team_builder_distill_completed: Record<string, never>
  team_builder_distill_failed: { reason: string }
  team_builder_distill_retried: Record<string, never>
  /** The person left the loading screen while the distillation was running.
   *
   *  Not a failure and deliberately not folded into `team_builder_distill_failed`:
   *  the build was working, someone chose not to wait. `stage` is where it had
   *  reached, which is the signal worth having. A cluster on one stage means
   *  that stage is where the wait stops being tolerable. */
  team_builder_distill_canceled: { stage: string }
  /** How long the confirmation screen was read before a decision.
   *
   *  Phase 0 of the distillation-waves plan (liftoff-react
   *  docs/distill-split-plan.md section 4). The split renders that screen at
   *  ~4s instead of ~117s, but the artifact is not finished until ~64s, so
   *  anyone who decides faster than that waits on the button instead. Whether
   *  that is a real problem or a theoretical one is a question about dwell
   *  time, and nothing currently measures it.
   *
   *  `action` distinguishes the two exits because they carry different
   *  urgency: Launch Now is someone who wants it working, Maybe Later is
   *  someone parking it. */
  team_builder_completion_decided: {
    action: 'launch' | 'not_now'
    dwell_ms: number
    /** True when the decision landed before the artifact was ready, i.e. the
     *  person hit the wait the plan is trying to size. */
    blocked: boolean
    /** Which flow produced the screen. The explore and build paths differ in
     *  what precedes it, so their dwell times are not the same population. */
    surface: 'build' | 'explore'
  }
  team_builder_canceled: { from_step: number }
  /** The save after a SUCCESSFUL distillation failed.
   *
   *  Distinct from `team_builder_distill_failed`, and the distinction is the
   *  point: distillation is the expensive, flaky part, so a failure there was
   *  already measured — while a rejected create would look, in the data,
   *  exactly like a person who changed their mind at the last screen.
   *
   *  `action` separates the two buttons because they fail for different reasons
   *  and one is far worse: launching can fail on activation, whereas a rejected
   *  draft means the work cannot even be kept. */
  team_builder_create_failed: {
    action: 'launch' | 'save_draft'
    reason: string
    /** Present when the failure was a validation rejection, naming the field —
     *  which is how "our generator violates our own contract" becomes visible as
     *  a rate rather than as one support conversation. */
    field?: string
  }

  // --- TeamExplore wizard (template gallery) -----------------------------
  team_explore_template_browsed: Record<string, never>
  team_explore_template_searched: { query_length: number; result_count: number }
  team_explore_template_selected: { template_id: string; role: string }
  team_explore_connector_step_entered: { template_id: string; required_count: number; optional_count: number }
  team_explore_required_connector_connected: { template_id: string; connector_type: string }
  /** A folded part of the detail view (Workflows, How they operate) was
   *  expanded. Says which reference material readers actually open. */
  team_explore_detail_section_opened: { template_id: string; section: string }
  /** The first line rewritten in one of the detail page's prose fields. Fires
   *  once per field, and is the moment a hire stops being the catalog's
   *  template and becomes the person's own version of it. */
  team_explore_inline_edit_started: { template_id: string; field: string }
  /** Rewritten lines lost by going back to the gallery. Confirmed first, so
   *  this only counts people who chose to lose them. */
  team_explore_inline_edit_discarded: { template_id: string }
  /** A destination or input was named on the connector step, e.g. which channel
   *  alerts get posted to. Absence of this for a template that declares objects
   *  means people are dismissing the picker. */
  team_explore_requirement_object_picked: {
    template_id: string
    requirement_id: string
    object_kind: string
  }
  /** A connection was taken off this team, or put back on. Fires only where the
   *  choice exists: an optional requirement, or a capability more than one
   *  connection satisfies. Watching `used: false` says how often a workspace
   *  holds a connection its teams should not touch. */
  team_explore_connection_toggled: {
    template_id: string
    requirement_id: string
    used: boolean
  }
  team_explore_distill_started: { template_id: string }
  team_explore_distill_completed: { template_id: string }
  team_explore_distill_failed: { template_id: string; reason: string }
  /** The hire-from-template twin of `team_builder_distill_canceled`. */
  team_explore_distill_canceled: { template_id: string; stage: string }

  // --- AgentConnector wizard (external agent agents) ---------------
  team_connector_started: Record<string, never>
  team_connector_connection_type_selected: { connection_type: string }
  team_connector_discovery_started: { auth_type: string; using_tunnel: boolean }
  team_connector_discovery_stage_changed: { stage: string }
  team_connector_discovery_completed: { capability_count: number; resource_count: number }
  team_connector_discovery_failed: { reason: string }
  team_connector_step_completed: {
    step: 'connection_type' | 'identify' | 'confirm' | 'select_teams' | 'collaboration_mode' | 'request_rules'
    step_index: 0 | 1 | 2 | 3 | 4 | 5
  }
  team_connector_canceled: { from_step: number }

  // --- TeamUpdate (editing an existing team) -----------------------------
  team_update_opened: { team_id: string; agent_kind: 'internal' | 'external' }
  team_update_save_clicked: { team_id: string }
  team_update_rollback_opened: { team_id: string }
  team_update_memory_deleted: { team_id: string; memory_id: string }
  // External-only lifecycle event (internal agents don't have a separate
  // discovery step). Unified into the agent_* namespace with kind='external'
  // pinned so the registry stays parallel to agent_status_changed etc.
  agent_rediscovered: { agent_id: string; kind: 'external' }

  // --- Custom MCP servers ------------------------------------------------
  custom_mcp_server_created: { server_id: string }
  custom_mcp_server_updated: { server_id: string }
  custom_mcp_server_deleted: { server_id: string }
  custom_mcp_server_rediscovered: { server_id: string }

  // --- Tunnels -----------------------------------------------------------
  tunnel_deployment_created: { deployment_id: string }
  tunnel_deployment_deleted: { deployment_id: string }
  tunnel_token_rotated: { deployment_id: string }
  tunnel_route_created: { deployment_id: string; route_id: string }
  tunnel_route_updated: { deployment_id: string; route_id: string }
  tunnel_route_deleted: { deployment_id: string; route_id: string }

  // --- Credential helpers (API key / keypair) ----------------------------
  connection_api_key_submitted: { connector: string; success: boolean }
  connection_keypair_submitted: { connector: string; success: boolean }
  connection_iam_grant_submitted: { connector: string; success: boolean }

  // --- Connections / integrations ---------------------------------------
  connection_oauth_started: { connector: string }
  connection_oauth_completed: { connector: string }
  connection_oauth_failed: {
    connector: string
    reason: 'oauth_denied' | 'invalid_state' | 'token_exchange_failed' | 'credential_store_failed' | 'callback_failed' | 'popup_closed' | 'canceled' | 'popup_blocked' | string
  }
  connection_oauth_canceled: { connector: string }
  /**
   * The popup closed after a real-length attempt and no connector landed, so
   * we could not tell the user whether it worked. Distinct from `canceled`
   * (which is a user choice) on purpose: a rising `unconfirmed` rate is the
   * signal that the OAuth return path is broken — something that would
   * otherwise go unnoticed because both look like silence.
   */
  connection_oauth_unconfirmed: { connector: string; elapsedMs: number }
  connection_instant_connected: { connector: string }
  connection_disconnected: { connector: string }
  connection_app_requested: { search_query: string }

  // --- GitHub App install leg -------------------------------------------
  // Runs after the GitHub authorize leg. Installing the App is what gives the
  // platform's writes an identity of their own (`Liftoff[bot]`) instead of
  // authoring them as the person who authorised, so these four say whether a
  // given connection can be told apart from a human's work.
  github_app_installed: { connector: string }
  /**
   * The user is not an owner of the organisation they chose, so GitHub recorded
   * a REQUEST. Neither success nor failure: it completes when an owner
   * approves, which may be weeks away and may never happen. Tracked apart from
   * `installed` because a workspace sitting on requests is a workspace whose
   * reviews are still unattributable.
   */
  github_app_install_pending: { connector: string; org: string }
  /** Closed the account picker without going to GitHub. The connection itself
   *  is live; only the bot identity was skipped. */
  github_app_install_dismissed: { connector: string }
  github_app_install_failed: { connector: string; reason: string }

  // --- Knowledge --------------------------------------------------------
  knowledge_item_created: { source: 'manual' | 'connector' }
  knowledge_items_batch_imported: { count: number }
  knowledge_item_updated: { item_id: string }
  knowledge_item_deleted: { item_id: string }
  knowledge_connector_browsed: { connector_id: string; query_length: number; context?: string }
  knowledge_connector_imported: { connector_id: string }
  knowledge_items_synced: { connector_id: string | null }

  // --- Oversight / review ----------------------------------------------
  oversight_settings_updated: { changed_fields: string[] }
  approval_decision_made: { approval_id: string; decision: 'approve' | 'reject'; always_apply: boolean }
  approval_late_feedback_submitted: { approval_id: string; decision: string }

  // --- Billing & plans -------------------------------------------------
  pricing_viewed: { surface: 'dashboard' | 'marketing' }
  pricing_period_changed: { period: 'monthly' | 'yearly' }
  pricing_plan_cta_clicked: { plan_id: string; is_current_plan: boolean }
  subscription_started: { plan_id: string; billing_period: 'monthly' | 'yearly'; committed_ous: number; promo_applied: boolean }
  subscription_replaced: { from_plan_id: string; to_plan_id: string; billing_period: 'monthly' | 'yearly' }
  plan_changed: { from_plan_id: string; to_plan_id: string; billing_period: 'monthly' | 'yearly' }
  subscription_canceled: { plan_id: string }
  credits_purchased: { amount_usd: number }
  auto_reload_enabled: { threshold_usd: number; reload_amount_usd: number }
  auto_reload_disabled: Record<string, never>
  // Server-side fired (from platform-backend's threshold-succeeded /
  // threshold-failed / payment-failed handlers — see
  // src/billing/billing-controls-internal-router.ts). Captures the
  // outcome of automatic balance top-ups that the client SDK can't see
  // because they fire from Stripe webhooks. payment_failed is the
  // subscription-cycle / recovery failure (different from
  // auto_reload_failed which is balance-threshold specific).
  auto_reload_succeeded: { threshold_level: string }
  auto_reload_failed: { threshold_level: string; outstanding_balance_usd: number }
  subscription_payment_failed: { outstanding_balance_usd: number; invoice_class: 'subscription_cycle' | 'recovery' }
  promo_code_looked_up: { result: 'applied' | 'invalid' | 'not_applicable' }
  payment_method_added: Record<string, never>
  payment_method_modal_opened: { surface: 'settings_billing' | 'pricing' }
  invoice_downloaded: { invoice_id: string }

  // --- Settings (account-level) -----------------------------------------
  account_profile_updated: { fields: ('firstName' | 'lastName' | 'email' | 'timezone' | 'avatarUrl' | 'persona' | 'notificationTypes' | 'notificationFrequency' | 'notificationDelivery')[] }
  account_deletion_preflight_opened: Record<string, never>
  account_deletion_confirmed: Record<string, never>

  // --- Marketing CTAs --------------------------------------------------
  marketing_cta_clicked: { surface: string; cta: string; destination: string }

  // ============ Dashboard chrome (DashboardLayout + Sidebar) ============
  payment_blocked_banner_shown: { outstanding_balance_usd: number }
  payment_blocked_cta_clicked: Record<string, never>
  /** The other reason a workspace is stopped: it used everything it bought, and
   *  nothing is wrong with the card. Counted apart from payment_blocked_* so the
   *  two are not read as one funnel — this one converts to a plan or to credit,
   *  the other to a card update. */
  out_of_operating_units_banner_shown: Record<string, never>
  out_of_operating_units_cta_clicked: Record<string, never>

  // ============ Browser notifications ============
  /** The permission state is carried on every one of these so the funnel can
   *  separate somebody who has never been asked from somebody whose browser is
   *  refusing: the two look identical from a count of impressions, and only one
   *  of them is a problem we can do anything about. */
  notification_permission_banner_shown: { permission: string }
  notification_permission_enable_clicked: Record<string, never>
  notification_permission_help_clicked: Record<string, never>
  notification_permission_banner_dismissed: { permission: string }
  chat_notification_prompt_shown: { permission: string }
  chat_notification_prompt_enable_clicked: Record<string, never>
  chat_notification_prompt_dismissed: { permission: string }
  /** Fired when an opaque /notification/<id> link resolves, so the click-through
   *  of a push or an email can be measured without the URL ever carrying an id
   *  that would identify the thread. */
  notification_link_opened: { destination: string; surface?: string }
  sidebar_collapsed_toggled: { collapsed: boolean }
  sidebar_mobile_menu_opened: Record<string, never>
  sidebar_nav_clicked: { destination: string }
  user_menu_opened: Record<string, never>
  tenant_switcher_opened: Record<string, never>

  // ============ Dashboard home (/dashboard) ============
  dashboard_home_viewed: Record<string, never>
  dashboard_add_function_clicked: Record<string, never>
  dashboard_getting_started_card_clicked: { card_id: '1' | '2' | '3' | '4'; destination: string }
  dashboard_getting_started_dismissed: { mode: 'dont_show_again' | 'remind_later' }
  dashboard_workspace_member_avatar_clicked: { has_more: boolean }
  dashboard_recent_activity_clicked: { log_id: string }
  // approval_id carries the queue item id whatever its kind; hitl_level exists
  // only on approvals.
  dashboard_needs_attention_clicked: { approval_id: string; kind: 'approval' | 'clarification' | 'escalation'; hitl_level?: number }
  dashboard_section_view_all_clicked: { section: 'teams' | 'activity' | 'review' }

  // ============ Teams page (/dashboard/agents) ============
  teams_viewed: { total_teams: number; total_external: number; total_claude_code: number }
  teams_workforce_category_changed: { category: 'all' | 'ai_workforce' | 'human_workforce' }
  teams_status_filter_changed: { filter: 'all' | 'active' | 'paused' | 'draft' | 'onboarding' | 'invited' | 'error' }
  teams_type_filter_toggled: { type: 'ai_teams' | 'external_collaborators' | 'people'; enabled: boolean }
  teams_sort_changed: { column: 'name' | 'status' | 'description' | 'integrations' | 'tasks' | 'cost' | 'activity'; direction: 'asc' | 'desc' }
  teams_plan_workforce_clicked: { source?: 'header' | 'empty_state' }
  teams_connect_external_clicked: Record<string, never>
  teams_explore_clicked: { source: 'header' | 'empty_state' }
  teams_row_clicked: { kind: 'ai_team' | 'external_agent' | 'claude_code' | 'person'; id: string }
  /** "Inspect Team" — off to the Activity feed, scoped to this one team. */
  teams_inspect_clicked: { kind: 'ai_team' | 'external_agent'; id: string }
  claude_code_key_revoked: { key_id: string; key_type: 'proxy' | 'mcp' }

  // ============ More pane (chat page right pane, AgentMessageOptions) ============
  /** A Set Up click on the Slack or Microsoft Teams card. Previously fired
   *  from the /dashboard/agents/message page, which the pane replaced. */
  team_message_action_clicked: Record<string, never>

  // ============ TeamPlanPage (/dashboard/agents/plan) ============
  team_plan_viewed: Record<string, never>
  team_plan_history_opened: Record<string, never>
  team_plan_new_chat: Record<string, never>
  team_plan_message_sent: { thread_id: string }
  team_plan_share_created: { thread_id: string }
  /** Right-pane toggle for the messaging options (Slack, Microsoft Teams, AI
   *  coding tool) — the same pane agent_chat_more_pane_toggled instruments,
   *  on the Chief AI Officer's surface. */
  team_plan_more_pane_toggled: { open: boolean }
  /** Mid-run control (ADR-041) — the message was folded into the reply already
   *  in progress instead of starting a second turn on the thread. */
  team_plan_hybrid_event: { hybrid_event: 'interrupt_delivered' }

  // ============ InsightsPage (/dashboard/insights) ============
  insights_viewed: Record<string, never>
  insights_period_changed: { period: string }
  insights_history_opened: Record<string, never>
  insights_new_chat: Record<string, never>
  insights_message_sent: { thread_id: string }
  insights_report_viewed: { report_id: string }
  insights_share_created: { thread_id: string }
  /** Right-pane toggle for the messaging options, on the Insights Manager's
   *  surface. */
  insights_more_pane_toggled: { open: boolean }
  /** Mid-run control (ADR-041) — the message was folded into the reply already
   *  in progress instead of starting a second turn on the thread. */
  insights_hybrid_event: { hybrid_event: 'interrupt_delivered' }
  /** LiftoffScore section rendered. Doubles as the who-looked-at-this audit
   *  trail: the payload names people and rates them, so views are recorded
   *  rather than anonymous. */
  liftoff_score_viewed: {
    period: string
    status: string
    rated_count: number
    unrated_count: number
  }
  /** The one next step on a row was followed. The signal that says whether
   *  this panel changes anything, rather than just being read. */
  liftoff_score_action_clicked: { entity_kind: string }

  // ============ LiftoffPage (/dashboard/liftoff) ============
  /** Sharing is instrumented on all four chat surfaces, so the share funnel
   *  (created here, opened as agent_chat_share_opened) has no blind spot. */
  liftoff_share_created: { thread_id: string }
  /** Right-pane toggle for the messaging options, on the Liftoff assistant's
   *  surface. */
  liftoff_more_pane_toggled: { open: boolean }

  // ============ ActivityPage (/dashboard/activity) ============
  activity_viewed: Record<string, never>
  activity_time_range_changed: { preset: '1h' | '2h' | '4h' | '8h' | '12h' | '24h' | '7d' | '30d' | 'all' | 'custom' }
  activity_search_performed: { query_length: number }
  activity_details_modal_opened: { log_id: string; action: string }
  activity_correct_modal_opened: { log_id: string }
  activity_correction_requested: { log_id: string; result: 'success' | 'gated' | 'failed'; reason_provided: boolean }
  activity_rerun_clicked: { log_id: string; result: 'success' | 'failed' }
  activity_paginated: { direction: 'next' | 'prev'; to_page: number }

  // ============ ReviewQueuePage (/dashboard/review) ============
  // null when the backend could not reach the tenant runtime, so the queue size
  // was unknown at view time rather than zero.
  review_viewed: { pending_count: number | null }
  review_level_filter_changed: { filter: 'all' | 'standard' | 'critical' | 'passed' }
  review_agent_filter_changed: { agent_id_selected: boolean }
  review_approval_selected: { approval_id: string; hitl_level: number; reason: string }
  review_approve_clicked: { approval_id: string; always_apply: boolean }
  review_reject_form_opened: { approval_id: string }
  // Approving stays one click; this fires only when somebody chooses to say
  // why, so an unexplained approval is not confused with an abandoned note.
  review_approve_note_form_opened: { approval_id: string }
  review_reject_confirmed: { approval_id: string; always_apply: boolean; reason_provided: boolean }
  review_late_feedback_submitted: { approval_id: string; decision: 'would_approve' | 'would_reject' }
  // The would-approve half now opens a note form first, the way the reject half
  // always has. Separated from the submit event so an abandoned note is visible
  // rather than looking like the feedback was never offered.
  review_late_feedback_form_opened: { approval_id: string; decision: 'would_approve' | 'would_reject' }
  // The queue pages as the reader scrolls; nothing is clicked, so this counts
  // depth reached rather than a button press. Replaces review_load_more_clicked.
  review_next_page_loaded: { page_index: number }
  review_github_branch_link_clicked: { approval_id: string }
  // The queue could not be read and the reader asked for it again. Distinct
  // from a page view: it only fires from the state that admits we do not know
  // what is in the queue.
  review_queue_reload_clicked: Record<string, never>
  // Unified queue — clarification card variant.
  review_clarification_selected: { clarification_id: string; source: 'recovery_llm' | 'anchor_intervention' }
  review_clarification_responded: { clarification_id: string }
  // Declining is an answer, not an absence of one. Tracked separately from
  // responding so the share of asks a person could not answer is visible;
  // before this existed the only way to say no was to let the ask expire,
  // which looked identical to never having opened the queue.
  review_clarification_decline_form_opened: { clarification_id: string }
  review_clarification_declined: { clarification_id: string; reason_provided: boolean }

  // ============ OversightPage (/dashboard/oversight) ============
  oversight_viewed: Record<string, never>
  oversight_section_edit_started: { section: 'autonomy' | 'escalation' | 'sensitiveWork' | 'communication' }
  oversight_section_saved: { section: 'autonomy' | 'escalation' | 'sensitiveWork' | 'communication'; new_value: string | string[] }
  oversight_section_canceled: { section: 'autonomy' | 'escalation' | 'sensitiveWork' | 'communication' }
  // null when the backend could not reach the tenant runtime, so the count was
  // unknown at click time rather than zero.
  oversight_review_queue_clicked: { pending_count: number | null }

  // ============ KnowledgePage (/dashboard/knowledge) ============
  knowledge_viewed: Record<string, never>
  knowledge_connect_clicked: { connector_type: string; section: 'help_center' | 'documents' }
  knowledge_file_picker_opened: { connector_id: string; connector_type: string }
  knowledge_file_picker_searched: { query_length: number; context?: string }
  knowledge_file_picker_folder_expanded: { folder_id: string; context?: string }
  knowledge_file_picker_file_toggled: { selected_count: number; context?: string }
  // `removed_count` is the other half of a confirm: the picker opens with the
  // already-imported files checked, so one press can both add and take away.
  knowledge_file_picker_added: { count: number; removed_count?: number; context?: string }
  knowledge_file_picker_canceled: { context?: string }
  // Removing a file a team pins changes what that team can answer, so the
  // confirm is held behind a warning. The pair measures how often that lands
  // and how often it is overridden.
  knowledge_pinned_removal_warned: { item_count: number }
  knowledge_pinned_removal_confirmed: { item_count: number }
  knowledge_connector_resynced: { connector_id: string; section: 'help_center' | 'documents' }
  knowledge_item_resynced: { item_id: string }
  knowledge_item_row_clicked: { item_id: string; has_source_url: boolean }
  knowledge_group_toggled: { connector_id: string; expanded: boolean }

  // ============ ConnectionsPage (/dashboard/connections) ============
  connections_viewed: { connected_count: number; available_count: number; planned_count: number }
  connections_searched: { query_length: number }
  connections_request_app_clicked: { search_query: string }
  connection_manage_modal_opened: { connector: string }
  connection_reconnect_clicked: { connector: string }

  // ============ SettingsPage (/dashboard/settings/:tab) ============
  settings_viewed: { tab: 'profile' | 'security' | 'communication' | 'billing' | 'account' | 'workspace' }
  settings_tab_changed: { from_tab: string; to_tab: string }
  // ---- Profile tab ----
  settings_profile_name_saved: Record<string, never>
  settings_profile_photo_uploaded: { size_bytes: number }
  settings_profile_photo_drag_drop: Record<string, never>
  settings_profile_email_change_initiated: Record<string, never>
  settings_profile_email_change_canceled: Record<string, never>
  settings_profile_timezone_saved: { timezone: string }
  // ---- Security tab ----
  settings_security_password_change_started: Record<string, never>
  settings_security_password_changed: Record<string, never>
  settings_security_passkey_register_started: Record<string, never>
  settings_security_passkey_registered: Record<string, never>
  settings_security_passkey_removed: { passkey_id: string }
  settings_security_2fa_setup_started: Record<string, never>
  settings_security_2fa_reauth_method_chosen: { method: 'password' | 'google' }
  settings_security_2fa_qr_shown: Record<string, never>
  settings_security_2fa_verified: Record<string, never>
  settings_security_2fa_disabled: Record<string, never>
  settings_security_qr_secret_copied: Record<string, never>
  // ---- Communication tab ----
  settings_communication_notification_types_saved: { types_enabled: number }
  settings_communication_notification_delivery_saved: { email: boolean; browser: boolean }
  settings_communication_notification_frequency_saved: { frequency: 'realtime' | 'daily' | 'weekly' | 'none' }
  // ---- Billing tab ----
  settings_billing_change_plan_clicked: Record<string, never>
  settings_billing_payment_modal_opened: { trigger: 'no_payment' | 'update' | 'banner' | 'tab_load' }
  settings_billing_add_credit_modal_opened: Record<string, never>
  settings_billing_auto_reload_modal_opened: Record<string, never>
  settings_billing_cancel_plan_modal_opened: Record<string, never>
  settings_billing_cancel_plan_confirmed: Record<string, never>
  settings_billing_invoice_downloaded: { invoice_id: string }
  // Legacy name kept for the existing PostHog data; new code fires
  // audit_log_csv_downloaded instead. The "billing" prefix was wrong —
  // the audit log section is on the Workspace tab, not Billing.
  settings_billing_audit_log_exported: Record<string, never>
  // Fires when an admin/owner successfully downloads the workspace audit
  // log CSV. row_count + the date range let funnels distinguish quick
  // spot-checks from full-period compliance exports.
  audit_log_csv_downloaded: { row_count: number; start_date: string; end_date: string }
  // ---- Account tab ----
  settings_account_logout_all_modal_opened: Record<string, never>
  settings_account_logout_all_confirmed: Record<string, never>
  settings_account_delete_modal_opened: Record<string, never>
  settings_account_delete_confirmed: Record<string, never>
  // ---- Workspace tab ----
  settings_workspace_manage_clicked: Record<string, never>
  settings_workspace_name_saved: { tenant_id: string }
  settings_workspace_ai_saved: { tenant_id: string; provider: string }
  // Providers whose key was written by this save. The key itself is never
  // sent anywhere near analytics, only which provider slots were filled.
  settings_workspace_ai_keys_saved: { tenant_id: string; providers: string[] }
  settings_workspace_member_invited: { tenant_id: string; role: string }
  settings_workspace_member_removed: { tenant_id: string }
  settings_workspace_member_role_changed: { tenant_id: string; new_role: string }
  settings_workspace_invitation_revoked: { tenant_id: string }
  settings_workspace_invitation_role_changed: { tenant_id: string; new_role: string }
  // The archive's size in bytes, and nothing of what it holds.
  settings_workspace_export_downloaded: { bytes: number }

  // ============ AgentUpdatePage — Internal team form ============
  team_update_internal_viewed: { team_id: string }
  team_update_nickname_check_failed: { team_id: string; reason: 'conflict' | 'validation' }
  team_update_autonomy_override_toggled: { team_id: string; open: boolean }
  team_update_autonomy_override_changed: { team_id: string; level: 'autonomous' | 'balanced' | 'controlled' | null }
  team_update_ai_provider_toggled: { team_id: string; open: boolean }
  // null = inherit the workspace choice, distinct from 'default' (Liftoff Managed).
  team_update_ai_provider_changed: { team_id: string; provider: WorkspaceAiVendor | null }
  team_update_webhook_nav_clicked: { team_id: string }
  team_update_advanced_section_toggled: { team_id: string; open: boolean }
  team_update_optimize_clicked: { team_id: string }
  team_update_optimize_completed: { team_id: string }
  team_update_optimize_failed: { team_id: string; reason: string }
  /** The person called off a distillation started from the update page,
   *  either from Optimize or from the redistill that Save triggers. */
  team_update_optimize_canceled: { team_id: string; stage: string }
  team_update_memory_section_toggled: { team_id: string; open: boolean }
  team_update_memory_queued_for_delete: { team_id: string; memory_id: string }
  team_update_augment_with_experts_clicked: { team_id: string }

  // ============ AgentUpdatePage — External agent form ============
  team_update_external_viewed: { agent_id: string }
  team_update_external_rediscover_clicked: { agent_id: string }
  team_update_external_select_all_teams: { agent_id: string; deselected: boolean }
  team_update_external_team_toggled: { agent_id: string; team_id: string; selected: boolean }
  team_update_external_collaboration_mode_changed: { agent_id: string; mode: string }
  team_update_external_permission_changed: { agent_id: string; team_id: string; request_type: string; permission: 'allowed' | 'approval_required' | 'blocked' }
  team_update_external_cost_changed: { agent_id: string; cost_type: 'per_task' | 'per_month' }
  team_update_external_advanced_toggled: { agent_id: string; open: boolean }

  // ============ AgentUpdatePage — coding-tool connection view ============
  team_update_claude_code_viewed: { proxy_key_id: string }
  team_update_coding_tool_saved: { connection_id: string }

  // ============ AgentWebhookPage ============
  team_webhook_viewed: { team_id: string; provisioned: boolean; enabled: boolean }
  team_webhook_status_toggled: { team_id: string; enabled: boolean; first_provision: boolean }
  team_webhook_hmac_toggle_confirm_opened: { team_id: string; enable: boolean }
  team_webhook_hmac_toggle_confirmed: { team_id: string; enabled: boolean }
  team_webhook_reset_confirm_opened: { team_id: string }
  team_webhook_reset_confirmed: { team_id: string }
  team_webhook_url_copied: { team_id: string }
  team_webhook_secret_copied: { team_id: string }
  team_webhook_deliveries_refreshed: { team_id: string }

  // ============ Liftoff Switch ============
  // Funnel metrics are tracked per source: the plan judges Switch as a GTM
  // strategy, and "which incumbent" is the dimension that decides whether a
  // funnel is producing real platform replacement or just import traffic.
  /** The entry point on Explore. Separated from `switch_wizard_viewed` because
   *  the gap between them is the drop-off that says whether the funnel is
   *  discoverable or merely reachable. */
  switch_entry_clicked: { source: string }
  /** Which incumbent someone picked on the chooser. */
  switch_source_selected: { source: string }
  switch_wizard_viewed: { source: string }
  switch_conversion_started: { source: string; items: number }
  switch_cutover_confirmed: { source: string; items: number }

  // ============ ClaudeCodeConnector ============
  claude_code_connector_viewed: Record<string, never>
  claude_code_npx_command_copied: Record<string, never>
  claude_code_api_key_submitted: { success: boolean }
  claude_code_key_created: { key_id: string }
  claude_code_success_continue_clicked: Record<string, never>

  // ============ CodexConnector ============
  codex_connector_viewed: Record<string, never>
  codex_npx_command_copied: Record<string, never>
  codex_api_key_submitted: { success: boolean }
  codex_key_created: { key_id: string }
  codex_success_continue_clicked: Record<string, never>

  // ============ CLIAuthPage ============
  cli_auth_viewed: { workspace_count: number }
  cli_auth_workspace_selected: { tenant_id: string }

  // ============ OAuthConsentPage (plan v6.1) ============
  oauth_consent_viewed: Record<string, never>
  oauth_consent_approved: Record<string, never>
  oauth_consent_denied: Record<string, never>
  oauth_consent_setup_required: Record<string, never>

  // ============ ActivatePage (device flow, RFC 8628) ============
  device_activation_viewed: { prefilled: boolean }
  device_activation_code_rejected: { reason: 'invalid' | 'expired' | 'rate_limited' }
  device_activation_approved: Record<string, never>
  device_activation_denied: Record<string, never>
  device_activation_setup_required: Record<string, never>

  // ============ AgentMcpPage (ADR-032) ============
  team_mcp_setup_clicked: { agent_id: string | null }
  mcp_setup_viewed: { agent_id: string | null }
  mcp_command_copied: { command: string }

  // ============ ExternalAgentUpdatePage ============
  external_agent_update_page_viewed: { agent_id: string }
  external_agent_update_advanced_toggled: { agent_id: string; open: boolean }

  // ============ AccountDeletedPage ============
  account_deleted_page_viewed: Record<string, never>

  // ============ Fused onboarding v2 ============
  // Disjoint from legacy `onboarding_step_completed` / `onboarding_completed`
  // above. PostHog `register({schema_version:2})` runs once at init so every
  // event below carries schema_version: 2 — dashboards filter on
  // `schema_version >= 2` to scope to fused-flow data. See lib/analytics.ts.
  onboarding_step_entered: {
    path: 'A' | 'B'
    step_id: string
    step_ordinal: number
    tenant_id: string
    resumed: boolean
  }
  onboarding_step_exited: {
    path: 'A' | 'B'
    step_id: string
    next_step_id: string | null
    direction: 'forward' | 'back'
    dwell_ms: number
    tenant_id: string
  }
  // hire_substep_entered, preview_lite_*, hire_confirm_choice and
  // full_distill_* lived here. They instrumented the first hire happening
  // inside onboarding, before the card — a flow removed in ADR-050. Removed
  // with their emitters: an event map entry no emitter fills is a dashboard
  // that silently reads zero forever.
  // Distinct from legacy `onboarding_completed` at line 49 (different shape).
  fused_onboarding_completed: {
    path: 'A' | 'B'
    total_duration_ms: number
    tenant_id: string
  }
  // The user declined to choose a plan and went straight to the invite step
  // (ADR-050). Payment is no longer required to finish onboarding, so this is
  // the funnel's measure of how many workspaces reach the product unpaid —
  // and, paired with the launch-blocker modal, of how many convert later.
  onboarding_plan_skipped: {
    path: 'A' | 'B'
    tenant_id: string
  }

  // ============ ReferPage — referral program ============
  referral_page_viewed: { tenant_id: string }
  // `surface` separates the two copy affordances on the page, because they
  // answer different questions: the field copy is someone taking the link
  // away to paste it somewhere we cannot see, the code copy is someone
  // reading it out loud or typing it into a form.
  referral_link_copied: { tenant_id: string; surface: 'link_field' | 'code' }
  referral_link_shared: {
    tenant_id: string
    channel: 'linkedin' | 'x' | 'facebook' | 'whatsapp' | 'reddit' | 'email_client'
  }
  referral_invites_sent: { tenant_id: string; count: number }
  referral_invites_failed: { tenant_id: string; count: number }
}

export type AnalyticsEventName = keyof AnalyticsEventMap

// ─── Fused onboarding v2 ───────────────────────────────────────────────
// Disjoint event names from the legacy v1 schema above. Tagged with
// schema_version: 2 globally via posthog.register() in analytics.ts.
// trackOnboarding() constrains its event-name parameter to these.
export type FusedOnboardingEventName =
  | 'onboarding_step_entered'
  | 'onboarding_step_exited'
  | 'fused_onboarding_completed'
  | 'onboarding_plan_skipped'
