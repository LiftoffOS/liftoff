import { http, HttpResponse } from 'msw'
import type { Connector, ConnectorType } from '../../services/connections'

/** Import placeholders start unreconnected, which is the real first-run state.
 *  Set to 'active' to walk past the review gate while reviewing later pages. */
const IMPORT_PLACEHOLDER_STATUS: 'error' | 'active' = 'error'

const mockConnectors: Connector[] = [
  // Liftoff Switch import placeholders. Credential-less rows in `error` with
  // disconnect_reason 'source_import' — the shape connector-service creates for
  // an imported integration. useIntegrations maps `error` to 'needs_reconnect',
  // which is what makes them render as Needs Reconnect cards both on the
  // Connections page and inside the import wizard. Their ids match the
  // migration mock's connections so the wizard shows exactly these three.
  {
    id: 'c0000000-0000-4000-8000-000000000001',
    tenantId: 'tenant-1',
    type: 'slack',
    name: 'Slack',
    status: IMPORT_PLACEHOLDER_STATUS,
    config: { disconnect_reason: 'source_import', import_source: 'openclaw' },
    apiKeyHint: null,
    lastSyncAt: null,
    createdAt: '2026-08-18T09:00:00Z',
    updatedAt: '2026-08-18T09:00:00Z',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000002',
    tenantId: 'tenant-1',
    type: 'github',
    name: 'GitHub',
    status: IMPORT_PLACEHOLDER_STATUS,
    config: { disconnect_reason: 'source_import', import_source: 'openclaw' },
    apiKeyHint: null,
    lastSyncAt: null,
    createdAt: '2026-08-18T09:00:00Z',
    updatedAt: '2026-08-18T09:00:00Z',
  },
  {
    id: 'c0000000-0000-4000-8000-000000000003',
    tenantId: 'tenant-1',
    type: 'custom_mcp_server',
    name: 'reporting',
    status: IMPORT_PLACEHOLDER_STATUS,
    config: {
      disconnect_reason: 'source_import',
      import_source: 'openclaw',
      deliveryMode: 'public_url',
      endpointUrl: 'https://mcp.example.com/reporting',
    },
    apiKeyHint: null,
    lastSyncAt: null,
    createdAt: '2026-08-18T09:00:00Z',
    updatedAt: '2026-08-18T09:00:00Z',
  },
  {
    id: 'connector-zendesk',
    tenantId: 'tenant-1',
    type: 'zendesk',
    name: 'Zendesk',
    status: 'active',
    config: {},
    apiKeyHint: null,
    lastSyncAt: '2026-05-01T10:00:00Z',
    createdAt: '2026-01-10T09:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
    credential: {
      id: 'cred-zendesk',
      status: 'active',
      expiresAt: null,
      lastRefreshedAt: '2026-05-01T10:00:00Z',
    },
  },
  {
    id: 'connector-gdrive',
    tenantId: 'tenant-1',
    type: 'google_drive',
    name: 'Google Drive',
    status: 'active',
    config: {},
    apiKeyHint: null,
    lastSyncAt: '2026-05-03T14:30:00Z',
    createdAt: '2026-02-01T09:00:00Z',
    updatedAt: '2026-05-03T14:30:00Z',
    credential: {
      id: 'cred-gdrive',
      status: 'active',
      expiresAt: null,
      lastRefreshedAt: '2026-05-03T14:30:00Z',
    },
  },
  {
    id: 'connector-1',
    tenantId: 'tenant-1',
    type: 'slack',
    name: 'Slack',
    status: 'active',
    config: {},
    apiKeyHint: null,
    lastSyncAt: '2024-01-15T10:00:00Z',
    createdAt: '2024-01-01T10:00:00Z',
    updatedAt: '2024-01-15T10:00:00Z',
    credential: {
      id: 'cred-1',
      status: 'active',
      expiresAt: null,
      lastRefreshedAt: '2024-01-15T10:00:00Z',
    },
  },
  {
    id: 'connector-2',
    tenantId: 'tenant-1',
    type: 'salesforce',
    name: 'Salesforce',
    status: 'active',
    config: {},
    apiKeyHint: null,
    lastSyncAt: '2024-01-14T08:00:00Z',
    createdAt: '2024-01-02T10:00:00Z',
    updatedAt: '2024-01-14T08:00:00Z',
    credential: {
      id: 'cred-2',
      status: 'active',
      expiresAt: null,
      lastRefreshedAt: '2024-01-14T08:00:00Z',
    },
  },
  {
    id: 'connector-3',
    tenantId: 'tenant-1',
    type: 'sendgrid',
    name: 'SendGrid',
    status: 'active',
    config: {},
    apiKeyHint: '•••gC2m',
    lastSyncAt: null,
    createdAt: '2024-01-10T10:00:00Z',
    updatedAt: '2024-01-10T10:00:00Z',
    credential: {
      id: 'cred-3',
      status: 'active',
      expiresAt: null,
      lastRefreshedAt: null,
    },
  },
]

const mockAvailableConnectors = [
  // OAuth connectors (30 active)
  { type: 'google_drive', name: 'Google Drive', provider: 'Google', supportsOAuth: true },
  { type: 'google_docs', name: 'Google Docs', provider: 'Google', supportsOAuth: true },
  { type: 'google_sheets', name: 'Google Sheets', provider: 'Google', supportsOAuth: true },
  { type: 'google_slides', name: 'Google Slides', provider: 'Google', supportsOAuth: true },
  { type: 'google_calendar', name: 'Google Calendar', provider: 'Google', supportsOAuth: true },
  { type: 'google_mail', name: 'Gmail', provider: 'Google', supportsOAuth: true },
  { type: 'google_contacts', name: 'Google Contacts', provider: 'Google', supportsOAuth: true },
  { type: 'google_tasks', name: 'Google Tasks', provider: 'Google', supportsOAuth: true },
  { type: 'google_bigquery', name: 'BigQuery', provider: 'Google', supportsOAuth: true },
  { type: 'google_firestore', name: 'Firestore', provider: 'Google', supportsOAuth: true },
  { type: 'microsoft_onedrive', name: 'OneDrive', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_outlook_mail', name: 'Outlook Mail', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_outlook_calendar', name: 'Outlook Calendar', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_teams', name: 'Microsoft Teams', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_todo', name: 'Microsoft To Do', provider: 'Microsoft', supportsOAuth: true },
  { type: 'outlook_contacts', name: 'Microsoft Contacts', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_onenote', name: 'OneNote', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_sharepoint', name: 'SharePoint', provider: 'Microsoft', supportsOAuth: true },
  { type: 'microsoft_planner', name: 'Microsoft Planner', provider: 'Microsoft', supportsOAuth: true },
  { type: 'salesforce', name: 'Salesforce', provider: 'Salesforce', supportsOAuth: true },
  { type: 'hubspot', name: 'HubSpot', provider: 'HubSpot', supportsOAuth: true },
  { type: 'slack', name: 'Slack', provider: 'Slack', supportsOAuth: true },
  { type: 'github', name: 'GitHub', provider: 'GitHub', supportsOAuth: true },
  { type: 'atlassian_jira', name: 'Atlassian Jira', provider: 'Atlassian', supportsOAuth: true },
  { type: 'atlassian_confluence', name: 'Atlassian Confluence', provider: 'Atlassian', supportsOAuth: true },
  { type: 'zendesk', name: 'Zendesk', provider: 'Zendesk', supportsOAuth: true },
  { type: 'intercom', name: 'Intercom', provider: 'Intercom', supportsOAuth: false },
  { type: 'notion', name: 'Notion', provider: 'Notion', supportsOAuth: true },
  { type: 'dropbox', name: 'Dropbox', provider: 'Dropbox', supportsOAuth: true },
  { type: 'box', name: 'Box', provider: 'Box', supportsOAuth: true },
  { type: 'stripe', name: 'Stripe', provider: 'Stripe', supportsOAuth: true },
  { type: 'zoom', name: 'Zoom', provider: 'Zoom', supportsOAuth: true },
  // API key connectors (6 active)
  { type: 'sendgrid', name: 'SendGrid', provider: 'SendGrid', supportsOAuth: false },
  { type: 'mailchimp', name: 'Mailchimp', provider: 'Mailchimp', supportsOAuth: false },
  { type: 'trello', name: 'Trello', provider: 'Trello', supportsOAuth: false },
  { type: 'bamboohr', name: 'BambooHR', provider: 'BambooHR', supportsOAuth: false },
  { type: 'cal_com', name: 'Cal.com', provider: 'Cal.com', supportsOAuth: false },
  { type: 'woocommerce', name: 'WooCommerce', provider: 'WooCommerce', supportsOAuth: false },
  // Native HRIS batch 2 (customer-credential api_key connectors)
  { type: 'deel', name: 'Deel', provider: 'Deel', supportsOAuth: false },
  { type: 'factorial', name: 'Factorial', provider: 'Factorial', supportsOAuth: false },
  { type: 'hibob', name: 'HiBob', provider: 'HiBob', supportsOAuth: false },
  { type: 'personio', name: 'Personio', provider: 'Personio', supportsOAuth: false },
  { type: 'ukg_pro', name: 'UKG Pro', provider: 'UKG', supportsOAuth: false },
  { type: 'ukg_ready', name: 'UKG Ready', provider: 'UKG', supportsOAuth: false },
  { type: 'dayforce', name: 'Dayforce', provider: 'Dayforce', supportsOAuth: false },
  { type: 'adp_run', name: 'ADP RUN', provider: 'ADP', supportsOAuth: false },
  { type: 'adp_workforce_now', name: 'ADP Workforce Now', provider: 'ADP', supportsOAuth: false },
]

// API key field configs for mock responses
const apiKeyFieldConfigs: Record<string, { displayName: string; steps?: Array<{ title: string; description?: string }>; fields: Array<{ name: string; label: string; type: string; required: boolean; placeholder: string; step?: number }> }> = {
  sendgrid: {
    displayName: 'SendGrid',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'SG.xxxx...' },
    ],
  },
  trello: {
    displayName: 'Trello',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your Trello API key' },
      { name: 'apiToken', label: 'API Token', type: 'password', required: true, placeholder: 'Your Trello token' },
    ],
  },
  woocommerce: {
    displayName: 'WooCommerce',
    fields: [
      { name: 'siteUrl', label: 'Store URL', type: 'text', required: true, placeholder: 'https://yourstore.com' },
      { name: 'consumerKey', label: 'Consumer Key', type: 'password', required: true, placeholder: 'ck_xxxx...' },
      { name: 'consumerSecret', label: 'Consumer Secret', type: 'password', required: true, placeholder: 'cs_xxxx...' },
    ],
  },
  bamboohr: {
    displayName: 'BambooHR',
    fields: [
      { name: 'subdomain', label: 'Subdomain', type: 'text', required: true, placeholder: 'yourcompany' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Your BambooHR API key' },
    ],
  },
  cal_com: {
    displayName: 'Cal.com',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'cal_live_xxxx...' },
    ],
  },
  mailchimp: {
    displayName: 'Mailchimp',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'xxxx-us1' },
    ],
  },
  databricks: {
    displayName: 'Databricks',
    fields: [
      { name: 'workspaceUrl', label: 'Workspace URL', type: 'text', required: true, placeholder: 'https://myworkspace.azuredatabricks.net' },
      { name: 'patToken', label: 'Personal Access Token', type: 'password', required: true, placeholder: 'dapi...' },
    ],
  },
  // Native HRIS batch 2 — mirror liftoff-connector-service apikey-router configs.
  deel: {
    displayName: 'Deel',
    fields: [
      { name: 'apiToken', label: 'API Token', type: 'password', required: true, placeholder: 'Deel organization token' },
    ],
  },
  factorial: {
    displayName: 'Factorial',
    fields: [
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'Factorial API key' },
    ],
  },
  hibob: {
    displayName: 'HiBob',
    fields: [
      { name: 'serviceUserId', label: 'Service User ID', type: 'text', required: true, placeholder: 'HiBob service user id' },
      { name: 'token', label: 'Service User Token', type: 'password', required: true, placeholder: 'HiBob service user token' },
    ],
  },
  personio: {
    displayName: 'Personio',
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'Personio API client id' },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'Personio API client secret' },
    ],
  },
  ukg_pro: {
    displayName: 'UKG Pro',
    fields: [
      { name: 'serviceUrl', label: 'Service URL', type: 'text', required: true, placeholder: 'service5.ultipro.com' },
      { name: 'customerApiKey', label: 'Customer API Key', type: 'password', required: true, placeholder: 'UKG Pro customer API key' },
      { name: 'username', label: 'Web Service Username', type: 'text', required: true, placeholder: 'Web services user' },
      { name: 'userApiKey', label: 'User API Key', type: 'password', required: true, placeholder: 'UKG Pro user API key' },
    ],
  },
  ukg_ready: {
    displayName: 'UKG Ready',
    fields: [
      { name: 'apiHost', label: 'API Host', type: 'text', required: true, placeholder: 'secure.saashr.com' },
      { name: 'companyShortName', label: 'Company Short Name', type: 'text', required: true, placeholder: 'Company short name (cid)' },
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'API user' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'API user password' },
      { name: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'UKG Ready API key' },
    ],
  },
  dayforce: {
    displayName: 'Dayforce',
    fields: [
      { name: 'companyId', label: 'Company ID', type: 'text', required: true, placeholder: 'Dayforce company id' },
      { name: 'username', label: 'Username', type: 'text', required: true, placeholder: 'Web services username' },
      { name: 'password', label: 'Password', type: 'password', required: true, placeholder: 'Web services password' },
    ],
  },
  adp_run: {
    displayName: 'ADP RUN',
    steps: [{ title: 'API Central OAuth' }, { title: 'API Central certificate' }],
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'API Central client id', step: 0 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'API Central client secret', step: 0 },
      { name: 'certificatePem', label: 'Client Certificate (PEM)', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----', step: 1 },
      { name: 'privateKeyPem', label: 'Private Key (PEM)', type: 'password', required: true, placeholder: '-----BEGIN PRIVATE KEY-----', step: 1 },
    ],
  },
  adp_workforce_now: {
    displayName: 'ADP Workforce Now',
    steps: [{ title: 'API Central OAuth' }, { title: 'API Central certificate' }],
    fields: [
      { name: 'clientId', label: 'Client ID', type: 'text', required: true, placeholder: 'API Central client id', step: 0 },
      { name: 'clientSecret', label: 'Client Secret', type: 'password', required: true, placeholder: 'API Central client secret', step: 0 },
      { name: 'certificatePem', label: 'Client Certificate (PEM)', type: 'textarea', required: true, placeholder: '-----BEGIN CERTIFICATE-----', step: 1 },
      { name: 'privateKeyPem', label: 'Private Key (PEM)', type: 'password', required: true, placeholder: '-----BEGIN PRIVATE KEY-----', step: 1 },
    ],
  },
}

export const connectorsHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes

  // List available connectors (must be before :connectorId route)
  http.get(`*/api/connectors/available`, () => {
    return HttpResponse.json({ connectors: mockAvailableConnectors })
  }),

  // Phase 4 catalog endpoint — returns ConnectorCatalogResponse. Fixture
  // mirrors the production catalog shape so local dev exercises the real
  // useConnectorCatalog() code path. Only a few entries are included; the
  // full set is verified by liftoff-connector-service tests.
  http.get(`*/api/connectors/catalog`, () => {
    return HttpResponse.json({
      version: 'vmock',
      categoryLabels: {
        crm_sales: 'CRM & Sales',
        productivity_comms: 'Productivity & Communication',
        engineering: 'Engineering',
        customer_support: 'Customer Support',
        finance: 'Finance & Payments',
        accounting: 'Accounting',
        hr: 'HR & Payroll',
        storage: 'Storage',
        meetings_scheduling: 'Meetings & Scheduling',
        data: 'Data & Analytics',
        knowledge: 'Knowledge',
        observability: 'Observability',
        marketing_comms: 'Marketing',
        social_messaging: 'Social & Messaging',
        project_management: 'Project Management',
        e_commerce: 'E-Commerce',
        error_tracking: 'Error Tracking',
        instant_connect: 'Instant Connect',
        incident_management: 'Incident Management',
        ats: 'Applicant Tracking',
      },
      connectors: mockAvailableConnectors.map((c) => {
        const category =
          c.type === 'zendesk' || c.type === 'intercom' ? 'customer_support' :
          c.type === 'google_drive' || c.type === 'microsoft_onedrive' || c.type === 'dropbox' || c.type === 'box' ? 'storage' :
          c.type === 'notion' || c.type === 'atlassian_confluence' ? 'knowledge' :
          'productivity_comms'
        return {
          type: c.type,
          displayName: c.name,
          category,
          status: 'available',
          auth: {
            kind: c.supportsOAuth ? 'static_oauth' : 'api_key',
          },
        }
      }),
    })
  }),

  // Get connector health stats (must be before :connectorId route)
  http.get(`*/api/connectors/health/stats`, () => {
    return HttpResponse.json({
      totalConnectors: mockConnectors.length,
      healthyConnectors: mockConnectors.length,
      degradedConnectors: 0,
      errorConnectors: 0,
      activeIncidents: 0,
      avgSyncSuccessRate: 99.5,
    })
  }),

  // API key field config (must be before :connectorId route)
  http.get(`*/api/connectors/apikey/:connectorType/config`, ({ params }) => {
    const connectorType = params.connectorType as string
    const config = apiKeyFieldConfigs[connectorType]
    if (!config) {
      return HttpResponse.json(
        { error: `Connector type '${connectorType}' does not support API key authentication` },
        { status: 400 },
      )
    }
    return HttpResponse.json({
      connectorType,
      displayName: config.displayName,
      fields: config.fields,
      // Mirror the real apikey-router response so multi-step forms (e.g. ADP)
      // paginate in mock mode.
      steps: config.steps,
    })
  }),

  // API key connect
  http.post(`*/api/connectors/apikey/:connectorType/connect`, async ({ params, request }) => {
    const connectorType = params.connectorType as ConnectorType
    const body = await request.json() as Record<string, string>
    const connectorId = `connector-apikey-${Date.now()}`

    // Simulate storing — add to mock connectors so it appears as connected
    const primaryKey = body.apiKey || body.consumerKey || ''
    const hint = primaryKey.length >= 4 ? `•••${primaryKey.slice(-4)}` : null
    const config = apiKeyFieldConfigs[connectorType]

    mockConnectors.push({
      id: connectorId,
      tenantId: body.tenantId || 'tenant-1',
      type: connectorType,
      name: config?.displayName || connectorType,
      status: 'active',
      config: {},
      apiKeyHint: hint,
      lastSyncAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credential: {
        id: `cred-${connectorId}`,
        status: 'active',
        expiresAt: null,
        lastRefreshedAt: null,
      },
    })

    return HttpResponse.json({
      success: true,
      connectorId,
      connectorType,
    })
  }),

  // Keypair setup — generates a mock RSA public key and instructions for Snowflake
  http.post(`*/api/connectors/keypair/:connectorType/setup`, async ({ params, request }) => {
    const body = await request.json() as Record<string, string>
    const username = (body.username || 'USER').toUpperCase()
    const setupToken = `mock-setup-${params.connectorType}-${Date.now()}`
    return HttpResponse.json({
      publicKey: `-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0mock+public+key+for+${username}\n-----END PUBLIC KEY-----`,
      instructions: `ALTER USER ${username} SET RSA_PUBLIC_KEY='<paste public key here>';`,
      setupToken,
    })
  }),

  // Keypair verify — simulates verifying the public key was registered
  http.post(`*/api/connectors/keypair/:connectorType/verify`, async ({ params, request }) => {
    const connectorType = params.connectorType as ConnectorType
    const body = await request.json() as Record<string, string>
    const connectorId = `connector-keypair-${connectorType}-${Date.now()}`
    mockConnectors.push({
      id: connectorId,
      tenantId: body.tenantId || 'tenant-1',
      type: connectorType,
      name: connectorType.charAt(0).toUpperCase() + connectorType.slice(1),
      status: 'active',
      config: {},
      apiKeyHint: null,
      lastSyncAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credential: {
        id: `cred-${connectorId}`,
        status: 'active',
        expiresAt: null,
        lastRefreshedAt: null,
      },
    })
    return HttpResponse.json({ success: true, connectorId, connectorType })
  }),

  // Start OAuth flow — points popup at /oauth/callback with success params so
  // OAuthCallbackPage broadcasts success immediately and the connector appears connected.
  http.post(`*/api/connectors/oauth/:connectorType/start`, async ({ params, request }) => {
    const connectorType = params.connectorType as ConnectorType
    const body = await request.json() as { returnUrl?: string; tenantId?: string }

    const connectorId = `mock-connector-${connectorType}-${Date.now()}`

    // Add connector to mock list so the refetch after connect shows it as active
    mockConnectors.push({
      id: connectorId,
      tenantId: body.tenantId || 'tenant-1',
      type: connectorType,
      name: connectorType.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      status: 'active',
      config: {},
      apiKeyHint: null,
      lastSyncAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      credential: {
        id: `cred-${connectorId}`,
        status: 'active',
        expiresAt: null,
        lastRefreshedAt: null,
      },
    })

    // returnUrl is ${origin}/oauth/callback — append success params so the popup
    // broadcasts immediately via BroadcastChannel and closes itself.
    const returnUrl = body.returnUrl ?? `${new URL(request.url).origin}/oauth/callback`
    const authUrl = `${returnUrl}?connected=${connectorType}&connectorId=${connectorId}`

    return HttpResponse.json({ authUrl, state: 'mock-state' })
  }),

  // List connectors
  http.get(`*/api/connectors`, () => {
    return HttpResponse.json({ connectors: mockConnectors })
  }),

  // Get single connector
  http.get(`*/api/connectors/:connectorId`, ({ params }) => {
    const connector = mockConnectors.find(c => c.id === params.connectorId)
    if (!connector) {
      return HttpResponse.json({ error: 'Connector not found' }, { status: 404 })
    }
    return HttpResponse.json(connector)
  }),

  // Update connector status
  http.patch(`*/api/connectors/:connectorId/status`, async ({ params, request }) => {
    const body = await request.json() as { status: string }
    const connector = mockConnectors.find(c => c.id === params.connectorId)
    if (!connector) {
      return HttpResponse.json({ error: 'Connector not found' }, { status: 404 })
    }
    return HttpResponse.json({
      ...connector,
      status: body.status,
      updatedAt: new Date().toISOString(),
    })
  }),

  // Delete connector
  http.delete(`*/api/connectors/:connectorId`, () => {
    return new HttpResponse(null, { status: 204 })
  }),
]
