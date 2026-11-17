// salesforce overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// Curation, measured against live Composio: the toolkit
// ADVERTISES meta.toolsCount 185 and SERVES 97, of which 34 carry a vendor
// description beginning "Deprecated:" — every awkward duplicate
// (EXECUTE_SOQL_QUERY, RETRIEVE_LEAD_BY_ID, UPDATE_CONTACT_BY_ID, …) is on that
// list, so picking by name alone ships a deprecated tool. These 60 are the 63
// live ones minus three held back deliberately: SEND_MASS_EMAIL (a blast from
// the customer's own org), MASS_TRANSFER_OWNERSHIP (bulk reassignment, no
// per-record approval) and GET_REPORT_INSTANCE (run_report + get_report cover
// it).
//
// Composio serves NO Case and NO Event tools for Salesforce. Cases and Events
// are reachable only through `search_records` (SOQL), which is why that tool is
// part of the set rather than a convenience.
//
// ONE CONTRACT DIFFERENCE from the native SALESFORCE_FUNCTIONS this toolkit
// replaces, stated here because it is invisible from either side alone: the
// native list_* tools took `{ limit, where }` and built the SOQL themselves,
// while Composio's take a whole `query`. An overlay cannot close that gap —
// agentFacingInputSchema only subtracts vendor arguments, it cannot add ones the
// vendor has no field for — so the stable NAMES are interchangeable across the
// two sources but the list_* arguments are not. That matters only on the
// COMPOSIO_DISABLED_CONNECTORS rollback path, and the vendor's own `query`
// descriptions are more specific than anything we would write, so they are left
// as they arrive.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

/** Salesforce 3-character key prefixes for the objects whose activity history a
 *  run can ask for. The prefix is part of every Salesforce record id, which is
 *  what lets `read_activity` resolve the sObject to query from the id alone —
 *  the history tool's contract carries an id and nothing else. */
const KEY_PREFIX_TO_SOBJECT: Record<string, string> = {
  '001': 'Account',
  '003': 'Contact',
  '00Q': 'Lead',
  '006': 'Opportunity',
  '500': 'Case',
};

/** A Salesforce id is 15 or 18 alphanumerics. This is interpolated into SOQL, so
 *  it is validated rather than escaped: anything that is not exactly that shape
 *  is rejected instead of being quoted and hoped for. */
function assertSalesforceId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/.test(value)) {
    throw new Error(
      'salesforce_invalid_record_id: expected a 15- or 18-character alphanumeric ' +
      'Salesforce record id',
    );
  }
  return value;
}

export const SALESFORCE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  // W1 inbox. Carried over from the native SALESFORCE_FUNCTIONS pairing: the
  // queue is leads whose Status has not yet been worked, and update_lead moving
  // Status out of those values is what acknowledges one. The native tool said so
  // in its own description via a `where` example; the SOQL equivalent goes in
  // descriptionSuffix because the vendor `query` description cannot know it.
  SALESFORCE_LIST_LEADS: {
    stableName: 'list_leads',
    categoryOverrides: ["read"],
    workRole: 'inbox',
    paired_ack: 'update_lead',
    workItemKind: 'lead',
    descriptionSuffix:
      "The inbox queue is leads with a Status that has not yet been worked — scope the " +
      "query with a Status filter, e.g. \"SELECT Id, FirstName, LastName, Company, Email, " +
      "Status FROM Lead WHERE Status IN ('Open - Not Contacted', 'Working - Contacted') " +
      "ORDER BY CreatedDate DESC LIMIT 100\". Acknowledge an item with update_lead, " +
      "changing Status out of the values this filter scopes to.",
  },
  SALESFORCE_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  SALESFORCE_LIST_ACCOUNTS: { stableName: 'list_accounts', categoryOverrides: ["read"] },
  SALESFORCE_LIST_OPPORTUNITIES: { stableName: 'list_opportunities', categoryOverrides: ["read"] },
  SALESFORCE_LIST_CAMPAIGNS: { stableName: 'list_campaigns', categoryOverrides: ["read"] },
  SALESFORCE_LIST_NOTES: { stableName: 'list_notes', categoryOverrides: ["read"] },
  SALESFORCE_GET_LEAD: { stableName: 'get_lead', categoryOverrides: ["read"] },
  SALESFORCE_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  SALESFORCE_GET_ACCOUNT: { stableName: 'get_account', categoryOverrides: ["read"] },
  SALESFORCE_GET_OPPORTUNITY: { stableName: 'get_opportunity', categoryOverrides: ["read"] },
  SALESFORCE_GET_CAMPAIGN: { stableName: 'get_campaign', categoryOverrides: ["read"] },
  SALESFORCE_GET_NOTE: { stableName: 'get_note', categoryOverrides: ["read"] },
  SALESFORCE_GET_USER_INFO: { stableName: 'get_user_info', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_LEADS: { stableName: 'search_leads', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_CONTACTS: { stableName: 'search_contacts', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_ACCOUNTS: { stableName: 'search_accounts', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_OPPORTUNITIES: { stableName: 'search_opportunities', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_CAMPAIGNS: { stableName: 'search_campaigns', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_NOTES: { stableName: 'search_notes', categoryOverrides: ["read"] },
  SALESFORCE_SEARCH_TASKS: { stableName: 'search_tasks', categoryOverrides: ["read"] },
  // The generic read, and the ONLY way to reach a Case or an Event — Composio
  // serves no tool for either object. `search_records` is the name the native
  // SALESFORCE_FUNCTIONS used for the same SOQL surface, kept so the two sources
  // answer to one name. Read-only by construction rather than by a guard: SOQL
  // has no DML, the endpoint behind it is the Query API, and the vendor schema
  // states "Must start with SELECT" — which is why this carries no sqlGuard (the
  // warehouse guard parses SQL, and SOQL is not SQL: its date literals and
  // relationship subqueries would fail that parse fail-closed and reject valid
  // queries).
  SALESFORCE_RUN_SOQL_QUERY: {
    stableName: 'search_records',
    categoryOverrides: ["read"],
    descriptionSuffix:
      'Prefer the object-specific tools (search_leads, list_opportunities, ' +
      'get_account, …) when one fits — they take structured arguments and need no ' +
      'SOQL. Use this for objects those tools do not cover, notably Case and Event, ' +
      'and for aggregate queries.',
  },
  SALESFORCE_LIST_REPORTS: { stableName: 'list_reports', categoryOverrides: ["read"] },
  SALESFORCE_GET_REPORT: { stableName: 'get_report', categoryOverrides: ["read"] },
  SALESFORCE_RUN_REPORT: { stableName: 'run_report', categoryOverrides: ["read"] },
  SALESFORCE_LIST_DASHBOARDS: { stableName: 'list_dashboards', categoryOverrides: ["read"] },
  SALESFORCE_GET_DASHBOARD: { stableName: 'get_dashboard', categoryOverrides: ["read"] },
  SALESFORCE_LIST_EMAIL_TEMPLATES: { stableName: 'list_email_templates', categoryOverrides: ["read"] },
  SALESFORCE_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_ACCOUNT: { stableName: 'create_account', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_OPPORTUNITY: { stableName: 'create_opportunity', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_CAMPAIGN: { stableName: 'create_campaign', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
  SALESFORCE_CREATE_NOTE: { stableName: 'create_note', categoryOverrides: ["write"] },
  // W1 ack for list_leads.
  SALESFORCE_UPDATE_LEAD: {
    stableName: 'update_lead',
    categoryOverrides: ["write"],
    workRole: 'ack',
    acknowledges: 'list_leads',
    workItemKind: 'lead',
    descriptionSuffix:
      'To acknowledge an inbox item from list_leads, change Status out of the ' +
      'unworked-queue values that inbox query scopes to.',
  },
  SALESFORCE_UPDATE_CONTACT: { stableName: 'update_contact', categoryOverrides: ["write"] },
  SALESFORCE_UPDATE_ACCOUNT: { stableName: 'update_account', categoryOverrides: ["write"] },
  SALESFORCE_UPDATE_OPPORTUNITY: { stableName: 'update_opportunity', categoryOverrides: ["write"] },
  SALESFORCE_UPDATE_CAMPAIGN: { stableName: 'update_campaign', categoryOverrides: ["write"] },
  SALESFORCE_UPDATE_TASK: { stableName: 'update_task', categoryOverrides: ["write"] },
  SALESFORCE_UPDATE_NOTE: { stableName: 'update_note', categoryOverrides: ["write"] },
  SALESFORCE_COMPLETE_TASK: { stableName: 'complete_task', categoryOverrides: ["write"] },
  SALESFORCE_LOG_CALL: { stableName: 'log_call', categoryOverrides: ["write"] },
  SALESFORCE_LOG_EMAIL_ACTIVITY: { stableName: 'log_email_activity', categoryOverrides: ["write"] },
  SALESFORCE_ADD_LEAD_TO_CAMPAIGN: { stableName: 'add_lead_to_campaign', categoryOverrides: ["write"] },
  SALESFORCE_ADD_CONTACT_TO_CAMPAIGN: { stableName: 'add_contact_to_campaign', categoryOverrides: ["write"] },
  SALESFORCE_REMOVE_FROM_CAMPAIGN: { stableName: 'remove_from_campaign', categoryOverrides: ["write"] },
  SALESFORCE_ASSOCIATE_CONTACT_TO_ACCOUNT: { stableName: 'associate_contact_to_account', categoryOverrides: ["write"] },
  SALESFORCE_APPLY_LEAD_ASSIGNMENT_RULES: { stableName: 'apply_lead_assignment_rules', categoryOverrides: ["write"] },
  SALESFORCE_ADD_OPPORTUNITY_LINE_ITEM: { stableName: 'add_opportunity_line_item', categoryOverrides: ["write"] },
  SALESFORCE_CLONE_OPPORTUNITY_WITH_PRODUCTS: { stableName: 'clone_opportunity', categoryOverrides: ["write"] },
  SALESFORCE_CLONE_RECORD: { stableName: 'clone_record', categoryOverrides: ["write"] },
  SALESFORCE_SEND_EMAIL: { stableName: 'send_email', categoryOverrides: ["write","outbound"] },
  SALESFORCE_SEND_EMAIL_FROM_TEMPLATE: { stableName: 'send_email_from_template', categoryOverrides: ["write","outbound"] },
  SALESFORCE_DELETE_LEAD: { stableName: 'delete_lead', categoryOverrides: ["write","destructive"] },
  SALESFORCE_DELETE_CONTACT: { stableName: 'delete_contact', categoryOverrides: ["write","destructive"] },
  SALESFORCE_DELETE_ACCOUNT: { stableName: 'delete_account', categoryOverrides: ["write","destructive"] },
  SALESFORCE_DELETE_OPPORTUNITY: { stableName: 'delete_opportunity', categoryOverrides: ["write","destructive"] },
  SALESFORCE_DELETE_CAMPAIGN: { stableName: 'delete_campaign', categoryOverrides: ["write","destructive"] },
  SALESFORCE_DELETE_NOTE: { stableName: 'delete_note', categoryOverrides: ["write","destructive"] },
};

// The catalog's `activity` historyRead — "all tasks and events related to a
// Salesforce record". Composio has no Event tool and its SEARCH_TASKS takes no
// record id, so this is served through SOQL, using the two child relationships
// Salesforce provides for exactly this question: ActivityHistories (completed
// tasks AND events) and OpenActivities (still open). Both require an explicit
// LIMIT in the subquery. The sObject to select FROM is resolved from the record
// id's own key prefix, because the history contract carries an id and nothing
// else.
//
// No returnsIds / idArgs anywhere in this toolkit, deliberately and on both
// sides: provenance-declaration-pairing.test.ts rejects a toolkit whose writes
// name their id arguments while its reads declare nothing, and a half-declared
// toolkit can only produce false positives.
export const SALESFORCE_HISTORY_MAPPINGS: HistoryToolMapping[] = [
  {
    entityType: 'activity',
    stableName: 'read_activity',
    vendorToolName: 'SALESFORCE_RUN_SOQL_QUERY',
    translateInput: (canonical) => {
      const id = assertSalesforceId(canonical.id);
      const sobject = KEY_PREFIX_TO_SOBJECT[id.slice(0, 3)];
      if (!sobject) {
        throw new Error(
          `salesforce_unsupported_activity_parent: record id prefix '${id.slice(0, 3)}' is not ` +
          'one of Account, Contact, Lead, Opportunity or Case',
        );
      }
      const activityFields =
        'Id, Subject, ActivityDate, ActivityType, Status, Description, OwnerId, WhoId, WhatId';
      return {
        query:
          `SELECT Id, ` +
          `(SELECT ${activityFields} FROM ActivityHistories ORDER BY ActivityDate DESC LIMIT 500), ` +
          `(SELECT ${activityFields} FROM OpenActivities ORDER BY ActivityDate DESC LIMIT 500) ` +
          `FROM ${sobject} WHERE Id = '${id}'`,
      };
    },
  },
];
