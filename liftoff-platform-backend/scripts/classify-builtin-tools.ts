#!/usr/bin/env npx ts-node

/**
 * Tool Classification Script
 * Per implementation plan: One-time script to generate seed SQL via LLM classification
 *
 * This script classifies all built-in connector tools and outputs SQL INSERT statements
 * that can be added to the migration file.
 *
 * Usage: npx ts-node scripts/classify-builtin-tools.ts
 */

// [TE-004] Import shared logic from tool-classifier to avoid duplication.
// The module lives in src/mcp/, not src/external-agents/ — external-agents
// re-imports SensitivityCategory from there. The path was stale; this
// kept the script and its test failing to load.
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  hashDescription,
  VALID_CATEGORIES,
  SensitivityCategory,
} from '../src/mcp/tool-classifier';
import { llmClient } from '../src/llm/client';

// Built-in connector tool definitions
// These would normally be fetched from MCP servers, but we define them here for seed generation
const BUILTIN_CONNECTORS: Record<string, Array<{
  name: string;
  description: string;
  draftVariant?: string;
}>> = {
  gmail: [
    { name: 'gmail_send_email', description: 'Send an email via Gmail', draftVariant: 'gmail_create_draft' },
    { name: 'gmail_create_draft', description: 'Create a draft email in Gmail' },
    { name: 'gmail_search', description: 'Search for emails in Gmail' },
    { name: 'gmail_read_email', description: 'Read a specific email from Gmail' },
    { name: 'gmail_reply_email', description: 'Reply to an email thread', draftVariant: 'gmail_create_draft' },
    { name: 'gmail_forward_email', description: 'Forward an email to another recipient', draftVariant: 'gmail_create_draft' },
    { name: 'gmail_delete_email', description: 'Delete an email from Gmail' },
    { name: 'gmail_list_labels', description: 'List all Gmail labels' },
  ],
  stripe: [
    { name: 'stripe_create_invoice', description: 'Create a new invoice in Stripe for billing a customer' },
    { name: 'stripe_refund_charge', description: 'Issue a refund for a Stripe charge' },
    { name: 'stripe_get_balance', description: 'Get current Stripe account balance' },
    { name: 'stripe_list_charges', description: 'List recent charges in Stripe' },
    { name: 'stripe_create_charge', description: 'Create a new charge in Stripe' },
    { name: 'stripe_create_subscription', description: 'Create a new subscription for a customer' },
    { name: 'stripe_cancel_subscription', description: 'Cancel an existing subscription' },
    { name: 'stripe_update_customer', description: 'Update customer information in Stripe' },
    { name: 'stripe_create_customer', description: 'Create a new customer in Stripe' },
    { name: 'stripe_get_customer', description: 'Get customer details from Stripe' },
  ],
  hubspot: [
    { name: 'hubspot_create_contact', description: 'Create a new contact in HubSpot CRM' },
    { name: 'hubspot_update_contact', description: 'Update an existing contact in HubSpot' },
    { name: 'hubspot_delete_contact', description: 'Delete a contact from HubSpot' },
    { name: 'hubspot_send_email', description: 'Send an email to a contact via HubSpot', draftVariant: 'hubspot_create_email_draft' },
    { name: 'hubspot_create_email_draft', description: 'Create an email draft in HubSpot' },
    { name: 'hubspot_search_contacts', description: 'Search for contacts in HubSpot' },
    { name: 'hubspot_get_contact', description: 'Get contact details from HubSpot' },
    { name: 'hubspot_create_deal', description: 'Create a new deal in HubSpot CRM' },
    { name: 'hubspot_update_deal', description: 'Update an existing deal in HubSpot' },
    { name: 'hubspot_create_note', description: 'Add a note to a contact or deal in HubSpot' },
  ],
  slack: [
    { name: 'slack_send_message', description: 'Send a message to a Slack channel', draftVariant: 'slack_schedule_message' },
    { name: 'slack_schedule_message', description: 'Schedule a message to be sent later in Slack' },
    { name: 'slack_send_dm', description: 'Send a direct message to a Slack user', draftVariant: 'slack_schedule_message' },
    { name: 'slack_list_channels', description: 'List all Slack channels' },
    { name: 'slack_get_channel_history', description: 'Get message history from a Slack channel' },
    { name: 'slack_search_messages', description: 'Search for messages in Slack' },
    { name: 'slack_create_channel', description: 'Create a new Slack channel' },
    { name: 'slack_invite_to_channel', description: 'Invite a user to a Slack channel' },
    { name: 'slack_upload_file', description: 'Upload a file to Slack' },
  ],
  lever: [
    { name: 'lever_update_candidate_status', description: 'Update the status of a candidate in Lever ATS' },
    { name: 'lever_send_offer', description: 'Send a job offer to a candidate via Lever' },
    { name: 'lever_reject_application', description: 'Reject a candidate application in Lever' },
    { name: 'lever_create_candidate', description: 'Create a new candidate in Lever ATS' },
    { name: 'lever_get_candidate', description: 'Get candidate details from Lever' },
    { name: 'lever_list_candidates', description: 'List candidates in Lever' },
    { name: 'lever_add_note', description: 'Add a note to a candidate profile in Lever' },
    { name: 'lever_schedule_interview', description: 'Schedule an interview with a candidate' },
  ],
  zendesk: [
    { name: 'zendesk_reply_ticket', description: 'Reply to a customer support ticket in Zendesk', draftVariant: 'zendesk_create_draft_reply' },
    { name: 'zendesk_create_draft_reply', description: 'Create a draft reply to a Zendesk ticket' },
    { name: 'zendesk_create_ticket', description: 'Create a new support ticket in Zendesk' },
    { name: 'zendesk_update_ticket', description: 'Update an existing Zendesk ticket' },
    { name: 'zendesk_close_ticket', description: 'Close a Zendesk ticket' },
    { name: 'zendesk_search_tickets', description: 'Search for tickets in Zendesk' },
    { name: 'zendesk_get_ticket', description: 'Get ticket details from Zendesk' },
  ],
  jira: [
    { name: 'jira_create_issue', description: 'Create a new issue in Jira' },
    { name: 'jira_update_issue', description: 'Update an existing Jira issue' },
    { name: 'jira_transition_issue', description: 'Move a Jira issue to a different status' },
    { name: 'jira_assign_issue', description: 'Assign a Jira issue to a user' },
    { name: 'jira_search_issues', description: 'Search for issues in Jira' },
    { name: 'jira_get_issue', description: 'Get issue details from Jira' },
    { name: 'jira_add_comment', description: 'Add a comment to a Jira issue' },
  ],
};

// [TE-004] Using shared logic from tool-classifier.ts
// CLASSIFICATION_SYSTEM_PROMPT, hashDescription, VALID_CATEGORIES imported above

async function classifyTool(
  toolName: string,
  description: string
): Promise<SensitivityCategory[]> {
  try {
    const response = await llmClient.complete({
      messages: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: `Tool name: ${toolName}\nDescription: ${description}` },
      ],
      temperature: 0.1,
      responseSchema: {
        name: 'classify_tool',
        schema: {
          type: 'object',
          properties: {
            categories: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['categories'],
        },
      },
    });

    const { categories } = JSON.parse(response.content);
    return categories.filter((cat: string) => VALID_CATEGORIES.includes(cat as SensitivityCategory)) as SensitivityCategory[];
  } catch (error) {
    console.error(`Failed to classify ${toolName}:`, error);
    return [];
  }
}

function formatCategories(categories: SensitivityCategory[]): string {
  if (categories.length === 0) {
    return "ARRAY[]::TEXT[]";
  }
  return `ARRAY[${categories.map(c => `'${c}'`).join(', ')}]`;
}

// Export for testing [TE-004]
export { formatCategories, classifyTool };

export async function generateSeedSQL(): Promise<string> {
  const rows: string[] = [];

  console.log('Classifying built-in connector tools...\n');

  for (const [connectorType, tools] of Object.entries(BUILTIN_CONNECTORS)) {
    console.log(`\n--- ${connectorType.toUpperCase()} ---`);

    for (const tool of tools) {
      const categories = await classifyTool(tool.name, tool.description);
      const hash = hashDescription(tool.description);
      const draftVariant = tool.draftVariant ? `'${tool.draftVariant}'` : 'NULL';

      console.log(`${tool.name}: ${categories.length > 0 ? categories.join(', ') : '(none)'}`);

      rows.push(
        `  ('${tool.name}', '${connectorType}', '${hash}', ${formatCategories(categories)}, ${draftVariant}, NOW())`
      );

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  const sql = `INSERT INTO tool_classification_cache (tool_name, integration_type, tool_description_hash, categories, draft_variant, classified_at) VALUES\n${rows.join(',\n')}\nON CONFLICT (tool_name) DO UPDATE SET
  integration_type = EXCLUDED.integration_type,
  tool_description_hash = EXCLUDED.tool_description_hash,
  categories = EXCLUDED.categories,
  draft_variant = EXCLUDED.draft_variant,
  classified_at = NOW();`;

  return sql;
}

async function main(): Promise<void> {
  const sql = await generateSeedSQL();
  console.log('\n\n=== SQL INSERT STATEMENT ===\n');
  console.log(sql);
}

main().catch(console.error);
