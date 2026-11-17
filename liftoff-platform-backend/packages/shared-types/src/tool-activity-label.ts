// What the person reads beside the pulse while an assistant is working.
//
// The label used to be derived in the browser from the tool's own name
// (liftoff-react, activityLabel.ts): a map of ten, and for everything else
// "Using " plus the name with its underscores knocked out. That turns the
// Chief AI Officer's `team__get_config` into "Using Get_config" —
// the internal name almost verbatim, in a product whose rule is that no
// assistant shows a person its inner workings (INV-PB-015). It could not
// have produced anything else: three services emit tool names into one
// stream (this one, workforce-service's Chief AI Officer, the Tenant
// Runtime's agents), a browser cannot enumerate them, and the names are
// not written to be read.
//
// So the label is authored ONCE, here, and travels on the frame. It lives in this
// package for the same reason AGENT_VOICE_BLOCK does: more than one repo has to
// agree on it exactly. platform-backend attaches it to every frame it writes,
// and workforce-service attaches it to the Chief AI Officer's own stream, which
// reaches the browser through a transparent proxy that cannot rewrite a frame.
// A second copy of this map would be a drift bug of exactly the kind this
// package exists to prevent: the same tool would read two ways on two pages.
//
// Three rules, in order:
//   1. An authored phrase, for every name this service can enumerate. A test
//      requires one for each, so a new tool cannot ship without a label.
//   2. A vendor's own name, for an MCP tool: the person knows the app they
//      connected, and "Working in Notion" is true and useful. Spelled the way
//      the vendor spells it, because a label is read.
//   3. "Working on it" for anything else, which is the point of the whole
//      change: an unrecognised tool degrades to a phrase that says nothing
//      rather than to its own identifier. A name never reaches the person,
//      whatever lands here.

/** What is shown when nothing better is known. Says only that work is
 *  happening, which is all the pulse beside it says. */
export const NEUTRAL_ACTIVITY_LABEL = 'Working on it';

/**
 * Authored labels, by tool name.
 *
 * Grouped by who offers the tool rather than alphabetically, because that is
 * how they are added and reviewed. A phrase describes what the PERSON gets out
 * of it, never the mechanism: "Searching the knowledge base", not "Calling the
 * article search".
 */
const AUTHORED: Record<string, string> = {
  // ── Liftoff's own ────────────────────────────────────────────────────────
  list_colleagues: 'Looking for the right colleague',
  bring_in_colleague: 'Working with a colleague',
  capability_search: 'Looking for a way to do this',
  run_capability: 'Gathering what is needed',
  // Reading further back in the conversation the person is already in, and
  // searching the other ones. Two phrases rather than one, because a person
  // watching should be able to tell "looking back at what you told me" from
  // "looking somewhere else" — they wait differently for the two.
  read_conversation_history: 'Looking back through this conversation',
  recall_conversations: 'Looking through your earlier conversations',
  dataset_query: 'Reading through the results',
  dataset_extract: 'Pulling out what you asked for',
  dataset_list: 'Checking what was gathered',
  memory_save: 'Saving context',
  memory_retrieve: 'Recalling context',

  // ── The browser ──────────────────────────────────────────────────────────
  start_browser_session: 'Opening the browser',
  navigate_browser_session: 'Moving to the page',
  run_browser_task: 'Working in the browser',
  read_active_browser_session: 'Looking at the page',
  read_browser_session_activity: 'Reviewing what happened in the browser',
  read_browser_session_controls: 'Reading the page',
  act_in_browser_session: 'Acting on the page',
  ask_person_to_take_over_browser_session: 'Handing the browser to you',
  screenshot_browser_session: 'Taking a picture of the page',
  // A download the browser already holds is invisible to the model until it
  // asks, so the first of these is a look and the second is the delivery.
  list_browser_downloads: 'Looking for what the browser downloaded',
  fetch_browser_download: 'Bringing the file out of the browser',
  // A long job the assistant set going rather than grinding through while
  // the person waits. The phrase is the setting-going, not the work: the
  // work reports itself later, in its own message.
  work_on_this_in_the_background: 'Setting that going in the background',
  // A long browser job that handed the turn back and carried on. Collecting
  // it is a look, not a second piece of work.
  check_browser_task: 'Checking on the browser job',
  // What the person is working towards, held across conversations.
  track_goal: 'Holding on to that',
  finish_goal: 'Closing that off',

  // ── Files ────────────────────────────────────────────────────────────────
  // Writing a file and showing it are separate acts, and this is the one a
  // person sees. "Bringing" rather than "showing" because by the time the line
  // is read the card is already there.
  show_file: 'Bringing up the file',

  // ── The Insights Manager's data ──────────────────────────────────────────
  get_agent_performance: 'Reading how your agents did',
  get_benefits_summary: 'Reading the benefits summary',
  get_connector_health: 'Checking your connections',
  get_cost_breakdown: 'Adding up the costs',
  get_data_landscape: 'Looking over your data',
  get_data_source_rates: 'Checking the data source rates',
  get_execution_trends: 'Reading the trends',
  get_human_activity: 'Reading what people did',
  get_oversight_config: 'Reading the oversight settings',
  get_payroll_summary: 'Reading the payroll summary',
  get_workforce_composition: 'Looking over your workforce',

  // ── Workspace actions: agents ──────────────────────────────────────────
  teams_list: 'Looking over your agents',
  team_get: 'Reading the agent',
  team_update: 'Preparing the change',
  team_status: 'Changing the agent status',
  team_archive: 'Removing the agent',
  team_start_readiness: 'Checking whether it can start',
  team_memories: 'Reading what the agent remembers',
  team_memory_edit: 'Rewriting a memory',
  team_memory_delete: 'Removing a memory',
  team_skills: 'Reading what the agent can do',
  team_rollback: 'Restoring an earlier version',
  team_webhook_get: 'Reading the webhook settings',
  team_webhook_set: 'Updating the webhook settings',

  // ── Workspace actions: external agents ────────────────────────────
  collaborator_get: 'Reading the external agent',
  collaborator_update: 'Updating the external agent',
  collaborator_connect: 'Connecting the external agent',
  collaborator_status: 'Changing the collaborator status',
  collaborator_archive: 'Removing the external agent',
  collaborator_rediscover: 'Checking what the collaborator offers',
  collaborator_rollback: 'Restoring an earlier version',
  collaborator_set_endpoint: 'Updating where the collaborator lives',
  collaboration_wire: 'Connecting them up',
  collaboration_unwire: 'Disconnecting them',

  // ── Workspace actions: connections and servers ───────────────────────────
  connections_list: 'Checking connected apps',
  connection_start: 'Starting the connection',
  connection_verify: 'Checking the connection',
  connection_disconnect: 'Disconnecting the app',
  connection_request_api_access: 'Requesting access',
  custom_mcp_connect: 'Connecting the server',
  custom_mcp_update: 'Updating the server',
  custom_mcp_delete: 'Removing the server',
  custom_mcp_tools: 'Reading what the server offers',
  custom_mcp_rediscover: 'Checking what the server offers',
  tunnels_state: 'Checking the tunnels',

  // ── Workspace actions: activity and reviews ──────────────────────────────
  activity_list: 'Looking through recent activity',
  activity_get: 'Reading the activity',
  activity_correct: 'Correcting the record',
  activity_correction_history: 'Reading the correction history',
  activity_run_again: 'Running it again',
  review_list: 'Checking what is waiting',
  review_decide: 'Deciding it',
  clarification_answer: 'Answering the question',
  audit_log_read: 'Reading the audit trail',

  // ── Workspace actions: people and the workspace ──────────────────────────
  members_list: 'Reading who is in the workspace',
  member_invite: 'Sending the invitation',
  member_remove: 'Removing the member',
  member_role: 'Changing the role',
  assignments_list: 'Reading the assignments',
  assignments_set: 'Updating the assignments',
  oversight_set: 'Updating oversight',
  workspace_get: 'Reading the workspace settings',
  workspace_rename: 'Renaming the workspace',
  workspace_ai_vendor: 'Updating the workspace AI setting',
  knowledge_list: 'Reading the knowledge library',
  knowledge_add_url: 'Adding to the knowledge library',
  knowledge_browse: 'Looking through your files',
  knowledge_add_file: 'Adding to the knowledge library',
  knowledge_resync: 'Reading the file again',

  // ── The Chief AI Officer's own, relayed through a hand-over ──────────────
  // Not enumerable from this service (they live in workforce-service), so they
  // are authored from its registry and the neutral phrase covers any drift.
  workforce_plan__draft: 'Drafting the plan',
  workforce_plan__commit: 'Finalising the plan',
  workforce_plan__approve: 'Starting setup',
  org__get_existing_structure: 'Reviewing your workspace',
  connectors__list_available: 'Checking connected apps',
  agent_templates__list: 'Browsing the template catalog',
  agent_templates__get: 'Browsing the template catalog',
  source_conversation__read: 'Reading the earlier conversation',
  conversations__list: 'Looking through your conversations',
  conversation__read: 'Reading the conversation',
  preview_with_liftoff: 'Putting it in front of you',
  team__get_config: 'Reading the agent',
  team__propose_update: 'Preparing the change',

  // ── An agent's own, relayed through a hand-over ────────────────────────
  delegate_to_agent: 'Working with a colleague',
  web_search: 'Searching the web',
  web_fetch: 'Reading a page',
  web_fetch_advanced: 'Reading a page',
  web_research: 'Researching',
  web_deep_research: 'Researching in depth',
  web_people_search: 'Looking someone up',
  web_finance_search: 'Checking the financial data',
  web_extract: 'Pulling out the details',
  web_task: 'Working through the pages',
  web_diff: 'Comparing what changed',
  notify_team: 'Sending word',
  record_step_output: 'Recording the result',
  schedule_followup: 'Scheduling the follow-up',
};

/** How a vendor spells itself, where title case gets it wrong. A label is
 *  read, and "Github" is a different word from the one on the app. */
const VENDOR_SPELLING: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  hubspot: 'HubSpot',
  linkedin: 'LinkedIn',
  youtube: 'YouTube',
  openai: 'OpenAI',
  quickbooks: 'QuickBooks',
  paypal: 'PayPal',
  paypal_sandbox: 'PayPal',
  whatsapp: 'WhatsApp',
  typeform: 'Typeform',
  docusign: 'DocuSign',
  sendgrid: 'SendGrid',
  mailchimp: 'Mailchimp',
  salesforce: 'Salesforce',
  zendesk: 'Zendesk',
  shopify: 'Shopify',
  coingecko: 'CoinGecko',
  bigquery: 'BigQuery',
  onedrive: 'OneDrive',
  sharepoint: 'SharePoint',
  dropbox: 'Dropbox',
  airtable: 'Airtable',
  notion: 'Notion',
  slack: 'Slack',
  asana: 'Asana',
  jira: 'Jira',
  stripe: 'Stripe',
  xero: 'Xero',
  intercom: 'Intercom',
  apify: 'Apify',
};

/** The vendor a namespaced MCP tool belongs to, or null.
 *  `mcp__github-7d07a896__get_file_contents` → "GitHub". */
function vendorOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null;
  const serverId = name.split('__')[1] ?? '';
  // The trailing short hex is the connection, not the vendor.
  const slug = serverId.replace(/-[a-f0-9]{6,}$/, '');
  if (!slug) return null;
  const known = VENDOR_SPELLING[slug.replace(/-/g, '_').toLowerCase()];
  if (known) return known;
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * The phrase shown beside the activity pulse, whole.
 *
 * Never returns the tool's name, and never derives a phrase from it. An
 * unrecognised name is work in progress and nothing more.
 */
export function toolActivityLabel(name: string): string {
  const authored = AUTHORED[name];
  if (authored) return authored;
  const vendor = vendorOf(name);
  if (vendor) return `Working in ${vendor}`;
  return NEUTRAL_ACTIVITY_LABEL;
}

/** Test seam: the authored names, for the ratchet that requires one per tool. */
export function _authoredActivityLabels(): Readonly<Record<string, string>> {
  return AUTHORED;
}
