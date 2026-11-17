// brevo overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const BREVO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  BREVO_GET_ALL_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  BREVO_FIND_CONTACT: { stableName: 'find_contact', categoryOverrides: ["read"] },
  BREVO_GET_CONTACT_DETAILS: { stableName: 'get_contact', categoryOverrides: ["read"] },
  BREVO_LIST_ALL_COMPANIES: { stableName: 'list_companies', categoryOverrides: ["read"] },
  BREVO_GET_COMPANY_DETAILS: { stableName: 'get_company', categoryOverrides: ["read"] },
  BREVO_CREATE_A_COMPANY: { stableName: 'create_company', categoryOverrides: ["write"] },
  BREVO_LIST_EMAIL_CAMPAIGNS: { stableName: 'list_email_campaigns', categoryOverrides: ["read"] },
  BREVO_UPDATE_EMAIL_CAMPAIGN: { stableName: 'update_email_campaign', categoryOverrides: ["write"] },
  BREVO_GET_ALL_EMAIL_TEMPLATES: { stableName: 'list_email_templates', categoryOverrides: ["read"] },
  BREVO_CREATE_OR_UPDATE_EMAIL_TEMPLATE: { stableName: 'upsert_email_template', categoryOverrides: ["write"] },
  BREVO_GET_SMS_CAMPAIGNS: { stableName: 'list_sms_campaigns', categoryOverrides: ["read"] },
  BREVO_CREATE_SMS_CAMPAIGN: { stableName: 'create_sms_campaign', categoryOverrides: ["write"] },
};

export const BREVO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
