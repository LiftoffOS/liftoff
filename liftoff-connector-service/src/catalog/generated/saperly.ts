// Registry functions — Saperly (saperly.com), native REST executor.
//
// Basis: Saperly's OpenAPI 3.1 spec at https://api.saperly.com/openapi.json
// ("Saperly API 0.1.0"), enumerated 2026-09-12. This is the REST surface, which
// SUPERSEDES the earlier MCP tool list: the MCP subset omitted the compliance-
// critical consent tools (Saperly rejects outbound without a recorded consent
// per number-peer pair), the connection/AI-persona model a number is answered
// by, and pricing/transcript/recording — all REST-only. Saperly is BYO-key
// (identity-bound 10DLC), so this runs on the workspace's own key as a Bearer;
// there is no platform Saperly credential. Auth + dispatch live in
// src/clients/saperly.ts; SAPERLY_DISPATCH maps each function to its REST path.
//
// Categories drive the human-approval gate on the platform capability surface:
// reads carry none; number provisioning and connection/consent state changes
// are writes; releasing a number or deleting a connection is destructive; every
// call/SMS/transfer is outbound. Saperly is telephony — a call or text reaches a
// real person and costs real money, so those tools never run without approval.

import type { ConnectorFunction } from '../../types.js';

export const SAPERLY_FUNCTIONS: ConnectorFunction[] = [
  // ── Reads ────────────────────────────────────────────────────────────────
  {
    name: 'list_numbers',
    description: 'List the phone numbers you own (with state, renewal, and the connection each is bound to).',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_number',
    description: 'Get one of your phone numbers by id, with its live connection (AI persona).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Number id' } }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'list_connections',
    description: 'List the connections (AI personas) configured in the workspace.',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_connection',
    description: 'Get one connection (AI persona) by id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Connection id' } }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'list_calls',
    description: 'List recent calls (inbound and outbound) with status and duration.',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'get_call',
    description: 'Get one call by id — direction, status, duration, timestamps.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Call id' } }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'get_call_transcript',
    description: 'Fetch the transcript of a call placed from one of your numbers.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Call id' } }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'get_call_recording',
    description: 'Get a download URL for a call recording (returns a redirect to the file).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Call id' } }, required: ['id'] },
    categories: ['read'],
  },
  {
    name: 'list_messages',
    description: 'List SMS messages sent from or received on your numbers, optionally filtered by number.',
    inputSchema: { type: 'object', properties: { numberId: { type: 'string', description: 'Filter by sending number id (optional)' } } },
    categories: ['read'],
  },
  {
    name: 'get_usage',
    description: 'Account usage and spend since a given time.',
    inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO timestamp lower bound (optional)' } } },
    categories: ['read'],
  },
  {
    name: 'price_quote',
    description: 'Quote the monthly and upfront price to provision a number of a given country and type.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'ISO country code, e.g. US' },
        numberType: { type: 'string', description: 'Number type, e.g. local, tollfree' },
      },
      required: ['country', 'numberType'],
    },
    categories: ['read'],
  },
  {
    name: 'list_languages',
    description: 'List the spoken languages a connection can use (code + name).',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'list_voices',
    description: 'List the TTS voices a connection can speak with (id, name, gender, language).',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },
  {
    name: 'check_consent',
    description: 'Check whether one of your numbers has active consent to contact a peer number.',
    inputSchema: {
      type: 'object',
      properties: {
        numberId: { type: 'string', description: 'Your Saperly number id' },
        peerNumber: { type: 'string', description: 'The contact number in E.164' },
      },
      required: ['numberId', 'peerNumber'],
    },
    categories: ['read'],
  },
  {
    name: 'list_consent',
    description: 'List all consent records in the workspace.',
    inputSchema: { type: 'object', properties: {} },
    categories: ['read'],
  },

  // ── Consent (TCPA compliance — record before you contact) ─────────────────
  {
    name: 'record_consent',
    description: 'Record that a peer has consented to be contacted from one of your numbers. Required before an outbound SMS or call — Saperly rejects outbound to a peer with no recorded consent.',
    inputSchema: {
      type: 'object',
      properties: {
        numberId: { type: 'string', description: 'Your Saperly number id' },
        peerNumber: { type: 'string', description: 'The contact number in E.164' },
        consentType: { type: 'string', description: 'The consent basis, e.g. express_written, express, prior_business_relationship' },
        source: { type: 'string', description: 'How consent was obtained (where it is recorded / evidence)' },
      },
      required: ['numberId', 'peerNumber', 'consentType', 'source'],
    },
    categories: ['write'],
  },
  {
    name: 'revoke_consent',
    description: 'Revoke a peer\'s consent to be contacted from one of your numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        numberId: { type: 'string', description: 'Your Saperly number id' },
        peerNumber: { type: 'string', description: 'The contact number in E.164' },
      },
      required: ['numberId', 'peerNumber'],
    },
    categories: ['write'],
  },

  // ── Connections (the AI persona that answers a number) ────────────────────
  {
    name: 'create_connection',
    description: 'Create a connection — the AI persona (instructions, voice, model, call controls, compliance) that answers a number. A number must be bound to one before it can take calls.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable connection name' },
        instructions: { type: 'string', description: 'The persona\'s instructions (what it does on a call)' },
        mode: { type: 'string', description: 'Connection mode' },
        backend: { type: 'string', description: 'Voice backend' },
        llm: { type: 'object', description: 'LLM config for the persona' },
        tts: { type: 'object', description: 'Text-to-speech voice config' },
        language: { type: 'string', description: 'Spoken language code' },
        mcpServers: { type: 'array', description: 'MCP servers the persona may call', items: { type: 'object' } },
        callControl: { type: 'object', description: 'Call-control settings' },
        complianceEnabled: { type: 'boolean', description: 'Enforce compliance disclosures' },
        smsAutoReply: { type: 'boolean', description: 'Auto-reply to inbound SMS' },
        disclosure: { type: 'string', description: 'AI-call disclosure text' },
        openaiRealtime: { type: 'object', description: 'OpenAI Realtime config' },
        manualWebhookUrl: { type: 'string', description: 'Manual-mode brain URL' },
      },
      required: ['name'],
    },
    categories: ['write'],
  },
  {
    name: 'update_connection',
    description: 'Update a connection (AI persona); Saperly re-syncs the carrier. Pass only the fields to change.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Connection id' },
        name: { type: 'string' },
        instructions: { type: 'string' },
        mode: { type: 'string' },
        backend: { type: 'string' },
        llm: { type: 'object' },
        tts: { type: 'object' },
        language: { type: 'string' },
        mcpServers: { type: 'array', items: { type: 'object' } },
        callControl: { type: 'object' },
        complianceEnabled: { type: 'boolean' },
        smsAutoReply: { type: 'boolean' },
        disclosure: { type: 'string' },
        openaiRealtime: { type: 'object' },
        manualWebhookUrl: { type: 'string' },
      },
      required: ['id'],
    },
    categories: ['write'],
  },
  {
    name: 'delete_connection',
    description: 'Delete a connection (AI persona).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Connection id' } }, required: ['id'] },
    categories: ['destructive'],
  },

  // ── Number provisioning + configuration (spends money) ────────────────────
  {
    name: 'provision_number',
    description: 'Provision (rent) a real US phone number — incurs an upfront charge plus a recurring monthly charge until released.',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'ISO country code, e.g. US' },
        numberType: { type: 'string', description: 'Number type, e.g. local, tollfree' },
        areaCode: { type: 'string', description: 'Preferred area code (optional)' },
        expectedMonthlyPriceCents: { type: 'number', description: 'Expected monthly price in cents (price guard)' },
        expectedUpfrontPriceCents: { type: 'number', description: 'Expected upfront price in cents (price guard)' },
        approveHigherPrice: { type: 'boolean', description: 'Provision even if the actual price exceeds the expected' },
      },
    },
    categories: ['write'],
  },
  {
    name: 'release_number',
    description: 'Release a provisioned number, stopping its billing.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Number id' } }, required: ['id'] },
    categories: ['destructive'],
  },
  {
    name: 'assign_number_connection',
    description: 'Bind a connection (AI persona) to one of your numbers — the persona that answers it.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Number id' },
        connectionId: { type: 'string', description: 'Connection id to bind' },
      },
      required: ['id', 'connectionId'],
    },
    categories: ['write'],
  },
  {
    name: 'set_caller_id_name',
    description: 'Set the outbound caller ID name (CNAM) on one of your numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Number id' },
        callerIdName: { type: 'string', description: 'The CNAM to display' },
      },
      required: ['id', 'callerIdName'],
    },
    categories: ['write'],
  },
  {
    name: 'set_sms_sender',
    description: 'Set the alphanumeric SMS sender id on one of your numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Number id' },
        smsSenderId: { type: 'string', description: 'The alphanumeric sender id' },
      },
      required: ['id', 'smsSenderId'],
    },
    categories: ['write'],
  },

  // ── Outbound (reaches a real person — always approval-gated) ──────────────
  {
    name: 'send_sms',
    description: 'Send an outbound SMS from one of your numbers. Requires recorded consent for the recipient; opted-out (STOP) recipients are blocked automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        fromNumberId: { type: 'string', description: 'The Saperly number to send from' },
        to: { type: 'string', description: 'Recipient in E.164 format' },
        body: { type: 'string', description: 'Message text (1-1600 characters)' },
      },
      required: ['fromNumberId', 'to', 'body'],
    },
    categories: ['outbound'],
  },
  {
    name: 'place_call',
    description: 'Place an outbound AI phone call from one of your numbers, answered by its (or the given) connection persona.',
    inputSchema: {
      type: 'object',
      properties: {
        fromNumberId: { type: 'string', description: 'The Saperly number to call from' },
        to: { type: 'string', description: 'Recipient in E.164 format' },
        connectionId: { type: 'string', description: 'Connection (persona) to run the call (optional; defaults to the number\'s)' },
        instructions: { type: 'string', description: 'One-off instructions for this call (optional)' },
      },
      required: ['fromNumberId', 'to'],
    },
    categories: ['outbound'],
  },
  {
    name: 'end_call',
    description: 'End a live call.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Call id' } }, required: ['id'] },
    categories: ['write'],
  },
  {
    name: 'transfer_call',
    description: 'Blind-transfer a live call to another phone number.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Call id' },
        to: { type: 'string', description: 'Transfer destination in E.164' },
      },
      required: ['id', 'to'],
    },
    categories: ['outbound'],
  },
];

/** REST dispatch: function name -> HTTP method + path on api.saperly.com.
 *  `{id}` placeholders are filled from the call's input by the executor (and
 *  those keys are then removed from the body/query). */
export const SAPERLY_DISPATCH: Record<string, { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; path: string }> = {
  list_numbers: { method: 'GET', path: '/numbers' },
  get_number: { method: 'GET', path: '/numbers/{id}' },
  list_connections: { method: 'GET', path: '/connections' },
  get_connection: { method: 'GET', path: '/connections/{id}' },
  list_calls: { method: 'GET', path: '/calls' },
  get_call: { method: 'GET', path: '/calls/{id}' },
  get_call_transcript: { method: 'GET', path: '/calls/{id}/transcript' },
  get_call_recording: { method: 'GET', path: '/calls/{id}/recording' },
  list_messages: { method: 'GET', path: '/messages' },
  get_usage: { method: 'GET', path: '/usage' },
  price_quote: { method: 'GET', path: '/pricing/quote' },
  list_languages: { method: 'GET', path: '/languages' },
  list_voices: { method: 'GET', path: '/voices' },
  check_consent: { method: 'GET', path: '/consent/check' },
  list_consent: { method: 'GET', path: '/consent' },
  record_consent: { method: 'POST', path: '/consent' },
  revoke_consent: { method: 'POST', path: '/consent/revoke' },
  create_connection: { method: 'POST', path: '/connections' },
  update_connection: { method: 'PATCH', path: '/connections/{id}' },
  delete_connection: { method: 'DELETE', path: '/connections/{id}' },
  provision_number: { method: 'POST', path: '/numbers' },
  release_number: { method: 'POST', path: '/numbers/{id}/release' },
  assign_number_connection: { method: 'POST', path: '/numbers/{id}/connection' },
  set_caller_id_name: { method: 'POST', path: '/numbers/{id}/caller-id' },
  set_sms_sender: { method: 'POST', path: '/numbers/{id}/sms-sender' },
  send_sms: { method: 'POST', path: '/messages' },
  place_call: { method: 'POST', path: '/calls' },
  end_call: { method: 'POST', path: '/calls/{id}/end' },
  transfer_call: { method: 'POST', path: '/calls/{id}/transfer' },
};
