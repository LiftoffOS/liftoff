// Connection tools: the Connections page, starting a connection (the kinds
// that need no secret), verifying an IAM grant, disconnecting, custom MCP
// servers and tunnel state. Every mutation is owner/admin
// (connections:manage) and preview → confirm.

import type { Actor } from '../actor';
import {
  customMcpConnect,
  customMcpDelete,
  customMcpRediscover,
  customMcpTools,
  customMcpUpdate,
  disconnect,
  listConnections,
  previewApiAccess,
  previewConnect,
  previewDisconnect,
  requestApiAccessForActor,
  startConnect,
  tunnelsState,
  verifyConnect,
} from '../connections';
import type { CustomApiSpec, UnsupportedSchemeReason } from '../../custom-api-connectors/types';
import { UNSUPPORTED_SCHEME_REASONS, checkSpec } from '../../custom-api-connectors/spec';
import { PreviewRefused, type WorkspaceActionTool } from './types';

function relay<T extends { refused: string; message: string; page?: string; context?: unknown }>(r: T) {
  return { refused: true, reason: r.refused, message: r.message, ...(r.page ? { page: r.page } : {}), ...(r.context !== undefined ? { context: r.context } : {}) };
}

export const connectionsListTool: WorkspaceActionTool = {
  definition: {
    name: 'connections_list',
    description: 'The Connections page, as the person sees it: what is connected (with status), any install a vendor is holding for an organisation owner to approve, what is available to connect (with whether it can be started from this conversation; a key or token is entered on the page), the workspace\'s connector health, and its custom MCP servers. An app that is not listed as connected is not connected, and the way to connect it is connection_start — there is no half-finished state to report or resume.',
    input_schema: { type: 'object', properties: {} },
  },
  permission: null,
  async execute(_input, actor: Actor) {
    return listConnections(actor);
  },
};

export const connectionStartTool: WorkspaceActionTool = {
  definition: {
    name: 'connection_start',
    description:
      'Start connecting an app. The preview says what kind of connection it is and what it needs: an OAuth app gives the person a link to the vendor\'s own consent screen (zendesk and bamboohr need the company subdomain first); GitHub lists the accounts the App can be installed on and needs targetLogin; an IAM-grant connector (BigQuery) needs fields.projectId and returns the service account and grant steps, then connection_verify; Microsoft Teams gives an administrator sign-in link; Slack is an OAuth link. Apps that connect with a key or token are refused with the page to use. Preview → confirm.',
    input_schema: {
      type: 'object',
      properties: {
        connectorType: { type: 'string', maxLength: 100, description: 'The connector type from connections_list (e.g. google_mail, github, slack, microsoft_teams, google_bigquery)' },
        subdomain: { type: 'string', maxLength: 100, description: 'For zendesk / bamboohr: the company subdomain' },
        targetLogin: { type: 'string', maxLength: 200, description: 'For github: the account or organisation to install on' },
        targetId: { type: 'number', description: 'For github: the target id from the preview' },
        fields: { type: 'object', description: 'For an IAM-grant connector: projectId and optional dataset' },
        reconnectConnectorId: { type: 'string', description: 'To reconnect an existing connection in place' },
        confirmationId: { type: 'string' },
      },
      required: ['connectorType'],
    },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const p = await previewConnect(actor, String(input.connectorType ?? ''));
    if ('refused' in p) throw PreviewRefused.from(p);
    return { ...p, ...(input.subdomain ? { subdomain: input.subdomain } : {}), ...(input.targetLogin ? { targetLogin: input.targetLogin } : {}), ...(input.fields ? { fields: input.fields } : {}) };
  },
  async execute(input, actor: Actor) {
    const r = await startConnect(actor, String(input.connectorType ?? ''), {
      subdomain: typeof input.subdomain === 'string' ? input.subdomain : undefined,
      targetLogin: typeof input.targetLogin === 'string' ? input.targetLogin : undefined,
      targetId: typeof input.targetId === 'number' ? input.targetId : undefined,
      fields: input.fields && typeof input.fields === 'object' ? input.fields as Record<string, string> : undefined,
      reconnectConnectorId: typeof input.reconnectConnectorId === 'string' ? input.reconnectConnectorId : undefined,
    });
    return 'refused' in r ? relay(r) : r;
  },
};

export const connectionVerifyTool: WorkspaceActionTool = {
  definition: {
    name: 'connection_verify',
    description: 'Verify an IAM-grant connection once the person has granted the service account access (connectorType and connectorId from connection_start).',
    input_schema: { type: 'object', properties: { connectorType: { type: 'string' }, connectorId: { type: 'string' } }, required: ['connectorType', 'connectorId'] },
  },
  permission: 'connections:manage',
  reResolveActor: true,
  async execute(input, actor: Actor) {
    const r = await verifyConnect(actor, String(input.connectorType ?? ''), String(input.connectorId ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

export const connectionDisconnectTool: WorkspaceActionTool = {
  definition: {
    name: 'connection_disconnect',
    description: 'Disconnect a connection by id. The preview carries a caveat when the connection is a GitHub App installation (disconnecting does not uninstall the App). Preview → confirm.',
    input_schema: { type: 'object', properties: { connectorId: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['connectorId'] },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const p = await previewDisconnect(actor, String(input.connectorId ?? ''));
    if ('refused' in p) throw PreviewRefused.from(p);
    return p;
  },
  async execute(input, actor: Actor) {
    const r = await disconnect(actor, String(input.connectorId ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

export const customMcpConnectTool: WorkspaceActionTool = {
  definition: {
    name: 'custom_mcp_connect',
    description: 'Register a custom MCP server at a public URL that needs no token (one that needs a token, or a tunnel, is set up on the Connections page). Preview → confirm.',
    input_schema: { type: 'object', properties: { name: { type: 'string', maxLength: 255 }, endpointUrl: { type: 'string', maxLength: 2000 }, confirmationId: { type: 'string' } }, required: ['name', 'endpointUrl'] },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input) {
    return { name: input.name, endpointUrl: input.endpointUrl, authType: 'none', deliveryMode: 'public_url' };
  },
  async execute(input, actor: Actor) {
    return customMcpConnect(actor, { name: String(input.name ?? ''), endpointUrl: String(input.endpointUrl ?? '') });
  },
};

export const customMcpUpdateTool: WorkspaceActionTool = {
  definition: {
    name: 'custom_mcp_update',
    description: 'Change a custom MCP server\'s name or endpoint URL (the endpoint of a tunnelled server is owned by its tunnel). Preview → confirm.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string', maxLength: 255 }, endpointUrl: { type: 'string', maxLength: 2000 }, confirmationId: { type: 'string' } }, required: ['id'] },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const current = await customMcpTools(actor, String(input.id ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { before: { name: current.server.name, endpointHost: current.server.endpointHost, deliveryMode: current.server.deliveryMode }, changes: { ...(input.name ? { name: input.name } : {}), ...(input.endpointUrl ? { endpointUrl: input.endpointUrl } : {}) } };
  },
  async execute(input, actor: Actor) {
    const r = await customMcpUpdate(actor, String(input.id ?? ''), {
      ...(typeof input.name === 'string' ? { name: input.name } : {}),
      ...(typeof input.endpointUrl === 'string' ? { endpointUrl: input.endpointUrl } : {}),
    });
    return 'refused' in r ? relay(r) : { updated: true, server: r.server };
  },
};

export const customMcpDeleteTool: WorkspaceActionTool = {
  definition: {
    name: 'custom_mcp_delete',
    description: 'Remove a custom MCP server. Preview → confirm.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['id'] },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const current = await customMcpTools(actor, String(input.id ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { server: { id: current.server.id, name: current.server.name }, action: 'delete' };
  },
  async execute(input, actor: Actor) {
    const r = await customMcpDelete(actor, String(input.id ?? ''));
    return 'refused' in r ? relay(r) : r;
  },
};

export const customMcpToolsTool: WorkspaceActionTool = {
  definition: {
    name: 'custom_mcp_tools',
    description: 'The tools a custom MCP server serves, as last discovered; set rediscover: true to read the endpoint again first (preview → confirm in that case).',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, rediscover: { type: 'boolean' }, confirmationId: { type: 'string' } }, required: ['id'] },
  },
  permission: null,
  async execute(input, actor: Actor) {
    if (input.rediscover === true) {
      // A rediscovery is a write (it replaces the stored tool list); it goes
      // through the mutating tool below.
      return { refused: true, reason: 'use_custom_mcp_rediscover', message: 'To read the endpoint again, call custom_mcp_rediscover.' };
    }
    const r = await customMcpTools(actor, String(input.id ?? ''));
    return 'refused' in r ? relay(r) : r.server;
  },
};

export const customMcpRediscoverTool: WorkspaceActionTool = {
  definition: {
    name: 'custom_mcp_rediscover',
    description: 'Read a custom MCP server\'s endpoint again and replace its stored tool list. Preview → confirm.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, confirmationId: { type: 'string' } }, required: ['id'] },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    const current = await customMcpTools(actor, String(input.id ?? ''));
    if ('refused' in current) throw PreviewRefused.from(current);
    return { server: { id: current.server.id, name: current.server.name, endpointHost: current.server.endpointHost, toolCount: current.server.tools.length }, action: 'rediscover' };
  },
  async execute(input, actor: Actor) {
    const r = await customMcpRediscover(actor, String(input.id ?? ''));
    return 'refused' in r ? relay(r) : { rediscovered: true, server: r.server };
  },
};

/** The declared connection description, as the tool takes it. Shaped here as
 *  well as validated in the service so the model reads what each field is for
 *  in the place it is filling them in. */
function readSpec(input: Record<string, unknown>): CustomApiSpec {
  const raw = (input.connection ?? {}) as Record<string, unknown>;
  return {
    providerSlug: String(raw.providerSlug ?? ''),
    displayName: String(raw.displayName ?? ''),
    baseUrl: String(raw.baseUrl ?? ''),
    apiHosts: Array.isArray(raw.apiHosts) ? raw.apiHosts.map(String) : [],
    auth: (raw.auth ?? {}) as CustomApiSpec['auth'],
    verification: (raw.verification ?? {}) as CustomApiSpec['verification'],
    specSourceUrl: String(raw.specSourceUrl ?? ''),
    purpose: String(raw.purpose ?? ''),
  };
}

export const connectionRequestApiAccessTool: WorkspaceActionTool = {
  definition: {
    name: 'connection_request_api_access',
    description:
      'Connect an API this workspace has no connector for. Read the provider\'s own documentation first, then describe the connection here: the hosts it reaches, how the key is sent, a read-only GET or HEAD that proves the key works, the address of its OpenAPI 3.x specification, and what the connection is for. The answer is one of three: the workspace already has this connection, the provider uses a scheme this cannot hold (say which in unsupportedScheme), or a link the person opens to enter the key. The key is never typed into this conversation. Preview then confirm.',
    input_schema: {
      type: 'object',
      properties: {
        connection: {
          type: 'object',
          description: 'The connection, as the provider\'s documentation describes it.',
          properties: {
            providerSlug: { type: 'string', maxLength: 100, description: 'A lowercase slug for the provider, e.g. acme-crm' },
            displayName: { type: 'string', maxLength: 200, description: 'What the person sees on the Connections page, e.g. Acme CRM' },
            baseUrl: { type: 'string', maxLength: 2000, description: 'The https address every request is built from, e.g. https://api.acme.com' },
            apiHosts: { type: 'array', items: { type: 'string' }, description: 'Every host this connection may reach. A request to anything else is refused.' },
            auth: {
              type: 'object',
              description: 'Where the key goes. scheme is one of bearer_header (Authorization: Bearer), header (name, and an optional prefix such as "Token "), query (name), path (the {placeholder} the key fills).',
              properties: {
                scheme: { type: 'string', enum: ['bearer_header', 'header', 'query', 'path'] },
                name: { type: 'string', maxLength: 100 },
                prefix: { type: 'string', maxLength: 40 },
              },
              required: ['scheme'],
            },
            verification: {
              type: 'object',
              description: 'A read that proves the key works. GET or HEAD only. accountIdentityField names the response field that identifies whose account the key belongs to, where the provider exposes one.',
              properties: {
                method: { type: 'string', enum: ['GET', 'HEAD'] },
                path: { type: 'string', maxLength: 2000 },
                query: { type: 'object' },
                accountIdentityField: { type: 'string', maxLength: 200, description: 'A dotted path into the response body, e.g. data.account.email' },
              },
              required: ['method', 'path'],
            },
            specSourceUrl: { type: 'string', maxLength: 2000, description: 'The https address of the provider\'s OpenAPI 3.x specification, in JSON' },
            purpose: { type: 'string', maxLength: 2000, description: 'What this connection is for, in ONE short sentence. It is shown on the Connections page and on the page where the key is entered, and read by the people who write what an agent does. It grants nothing.' },
          },
          required: ['providerSlug', 'displayName', 'baseUrl', 'apiHosts', 'auth', 'verification', 'specSourceUrl', 'purpose'],
        },
        unsupportedScheme: {
          type: 'string',
          enum: [...UNSUPPORTED_SCHEME_REASONS],
          description: 'Set this INSTEAD of describing a connection when the provider signs in a way this cannot hold, and the answer is the named reason: password_only, copied_cookies, request_signing, multi_secret, client_certificate.',
        },
        reconnectConnectorId: { type: 'string', description: 'To replace the key on an existing connection in place, keeping its id' },
        confirmationId: { type: 'string' },
      },
      required: ['connection'],
    },
  },
  permission: 'connections:manage',
  mutating: true,
  async preview(input, actor: Actor) {
    // A capture link needs a person to open it. In a conversation there is one;
    // in an unattended turn there is not, so this refuses with a reason rather
    // than minting a link nobody will click.
    if (actor.unattended === true) {
      throw new PreviewRefused(
        'nobody_present',
        'A connection link has to be opened by a person, and there is nobody in this conversation to open one. Ask again when somebody is there.',
      );
    }
    const unsupported = typeof input.unsupportedScheme === 'string' ? input.unsupportedScheme : undefined;
    if (unsupported) {
      return { unsupportedScheme: unsupported, willMintLink: false };
    }
    const spec = readSpec(input);
    // An unusable description is refused HERE, before anything is minted, and
    // with what is actually wrong with it — not as one of the three answers,
    // none of which it is.
    const shape = checkSpec(spec);
    if (!shape.ok) {
      throw new PreviewRefused(
        'description_not_usable',
        shape.message ?? 'That connection description is not one this family can hold.',
      );
    }
    // Everything the person is shown before they confirm. Never a credential:
    // at this point there is not one, and there never is one to show.
    const described = await previewApiAccess(actor, spec);
    if ('refused' in described) throw PreviewRefused.from(described);
    return {
      provider: spec.displayName,
      hosts: spec.apiHosts,
      credentialPlacement: spec.auth,
      verification: `${spec.verification.method} ${spec.verification.path}`,
      purpose: spec.purpose,
      operationCount: described.operationCount,
      sampleOperations: described.sampleOperations,
      // What the connection will NOT carry. Said at the preview, because this
      // is the moment a person can still decide the API is not worth
      // connecting without the endpoint they came for — afterwards they find
      // out by asking for a tool that is not there.
      ...(described.skippedCount
        ? {
          endpointsLeftOut: described.skippedCount,
          endpointsLeftOutNames: described.skippedOperations,
          endpointsLeftOutBecause: described.skippedReasons,
        }
        : {}),
      willMintLink: true,
    };
  },
  async execute(input, actor: Actor) {
    if (actor.unattended === true) {
      return relay({
        refused: 'nobody_present',
        message: 'A connection link has to be opened by a person, and there is nobody in this conversation to open one. Ask again when somebody is there.',
      });
    }
    return requestApiAccessForActor(actor, {
      spec: readSpec(input),
      ...(typeof input.unsupportedScheme === 'string'
        ? { unsupportedScheme: input.unsupportedScheme as UnsupportedSchemeReason }
        : {}),
      ...(typeof input.reconnectConnectorId === 'string'
        ? { reconnectConnectorId: input.reconnectConnectorId }
        : {}),
    });
  },
};

export const tunnelsStateTool: WorkspaceActionTool = {
  definition: {
    name: 'tunnels_state',
    description: 'The workspace\'s tunnels: each deployment, whether it is connected, when it was last seen, and its routes. Creating a tunnel or rotating its token is done on the Connections page.',
    input_schema: { type: 'object', properties: {} },
  },
  permission: null,
  async execute(_input, actor: Actor) {
    return tunnelsState(actor);
  },
};

export const connectionsTools: WorkspaceActionTool[] = [
  connectionsListTool,
  connectionStartTool,
  connectionVerifyTool,
  connectionDisconnectTool,
  // Unstewarded, like every other connection tool. Connecting an app is not a
  // change to an agent, so Liftoff leads the flow and the Chief AI Officer
  // holds the same tool because it needs it: designing an agent, it
  // discovers there is no connector for the service and mints the link there
  // rather than sending the person away. What IS the Chief AI Officer's is
  // what happens next — binding the new connection and shaping the work — and
  // Liftoff brings it in for that through bring_in_colleague.
  connectionRequestApiAccessTool,
  customMcpConnectTool,
  customMcpUpdateTool,
  customMcpDeleteTool,
  customMcpToolsTool,
  customMcpRediscoverTool,
  tunnelsStateTool,
];
