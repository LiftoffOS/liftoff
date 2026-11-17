// whatsapp overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const WHATSAPP_OVERLAYS: Record<string, ComposioToolOverlay> = {
  WHATSAPP_GET_MESSAGE_TEMPLATES: { stableName: 'list_message_templates', categoryOverrides: ["read"] },
  WHATSAPP_GET_BUSINESS_PROFILE: { stableName: 'get_business_profile', categoryOverrides: ["read"] },
  WHATSAPP_GET_PHONE_NUMBERS: { stableName: 'list_phone_numbers', categoryOverrides: ["read"] },
  WHATSAPP_SEND_MESSAGE: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  WHATSAPP_SEND_TEMPLATE_MESSAGE: { stableName: 'send_template_message', categoryOverrides: ["write","outbound"] },
  WHATSAPP_SEND_MEDIA: { stableName: 'send_media', categoryOverrides: ["write","outbound"] },
  WHATSAPP_SEND_CONTACTS: { stableName: 'send_contacts', categoryOverrides: ["write","outbound"] },
  WHATSAPP_SEND_INTERACTIVE_BUTTONS: { stableName: 'send_interactive_buttons', categoryOverrides: ["write","outbound"] },
  WHATSAPP_SEND_LOCATION: { stableName: 'send_location', categoryOverrides: ["write","outbound"] },
};

export const WHATSAPP_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
