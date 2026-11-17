import { http, HttpResponse } from 'msw'
import type { KnowledgeItem, BrowseResult } from '../../services/knowledge'
import type { CreateKnowledgeItemInput } from '../../services/knowledge'

let mockItems: KnowledgeItem[] = [
  {
    id: 'knowledge-1',
    tenantId: 'tenant-1',
    title: 'Getting Started with Liftoff',
    sourceUrl: 'https://help.example.com/getting-started',
    connectorId: 'connector-zendesk',
    connectorType: 'zendesk',
    externalId: 'article-1001',
    contentType: 'article',
    excerpt: 'A comprehensive guide to getting started with Liftoff for new users.',
    metadata: { category: 'onboarding', views: 1240 },
    importMode: 'auto_import',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-01T10:00:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
  },
  {
    id: 'knowledge-1b',
    tenantId: 'tenant-1',
    title: 'How to Set Up Integrations',
    sourceUrl: 'https://help.example.com/integrations-setup',
    connectorId: 'connector-zendesk',
    connectorType: 'zendesk',
    externalId: 'article-1002',
    contentType: 'article',
    excerpt: 'Step-by-step guide to connecting your tools to Liftoff.',
    metadata: { category: 'integrations', views: 890 },
    importMode: 'auto_import',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-01T10:00:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
  },
  {
    id: 'knowledge-1c',
    tenantId: 'tenant-1',
    title: 'Billing and Subscription FAQ',
    sourceUrl: 'https://help.example.com/billing-faq',
    connectorId: 'connector-zendesk',
    connectorType: 'zendesk',
    externalId: 'article-1003',
    contentType: 'article',
    excerpt: 'Answers to common questions about billing, upgrades, and cancellations.',
    metadata: { category: 'billing', views: 2100 },
    importMode: 'auto_import',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-01T10:00:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-01T10:00:00Z',
    updatedAt: '2026-05-01T10:00:00Z',
  },
  {
    id: 'knowledge-2',
    tenantId: 'tenant-1',
    title: 'Q1 2026 Product Roadmap',
    sourceUrl: 'https://drive.google.com/file/d/mock-file-1',
    connectorId: 'connector-gdrive',
    connectorType: 'google_drive',
    externalId: 'gdrive-file-1',
    contentType: 'document',
    excerpt: 'Detailed breakdown of product priorities and milestones for Q1 2026.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 48200 },
    importMode: 'file_select',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-03T14:30:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-03-15T09:00:00Z',
    updatedAt: '2026-05-03T14:30:00Z',
  },
  {
    id: 'knowledge-4',
    tenantId: 'tenant-1',
    title: 'Engineering Onboarding Guide',
    sourceUrl: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit',
    connectorId: 'connector-gdrive',
    connectorType: 'google_drive',
    externalId: 'gdrive-file-2',
    contentType: 'document',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 31400 },
    importMode: 'file_select',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-03T14:30:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-03-20T11:00:00Z',
    updatedAt: '2026-05-03T14:30:00Z',
  },
  {
    id: 'knowledge-5',
    tenantId: 'tenant-1',
    title: 'Brand Guidelines v4',
    sourceUrl: 'https://docs.google.com/presentation/d/EXAMPLE_DOC_ID/edit',
    connectorId: 'connector-gdrive',
    connectorType: 'google_drive',
    externalId: 'gdrive-file-3',
    contentType: 'document',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.presentation', size: 55600 },
    importMode: 'file_select',
    syncStatus: 'synced',
    lastSyncedAt: '2026-05-03T14:30:00Z',
    syncError: null,
    parentId: null,
    extractionStatus: 'done',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-01T09:00:00Z',
    updatedAt: '2026-05-03T14:30:00Z',
  },
  {
    id: 'knowledge-6',
    tenantId: 'tenant-1',
    title: '2026 Annual Budget',
    sourceUrl: 'https://docs.google.com/spreadsheets/d/EXAMPLE_DOC_ID/edit',
    connectorId: 'connector-gdrive',
    connectorType: 'google_drive',
    externalId: 'gdrive-file-4',
    contentType: 'document',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.spreadsheet', size: 29800 },
    importMode: 'file_select',
    syncStatus: 'syncing',
    lastSyncedAt: null,
    syncError: null,
    parentId: null,
    extractionStatus: 'pending',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-10T15:00:00Z',
    updatedAt: '2026-05-07T08:00:00Z',
  },
  {
    id: 'knowledge-7',
    tenantId: 'tenant-1',
    title: 'Security Audit Report 2025',
    sourceUrl: 'https://docs.google.com/document/d/EXAMPLE_DOC_ID/edit',
    connectorId: 'connector-gdrive',
    connectorType: 'google_drive',
    externalId: 'gdrive-file-5',
    contentType: 'document',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 78300 },
    importMode: 'file_select',
    syncStatus: 'error',
    lastSyncedAt: '2026-04-28T10:00:00Z',
    syncError: 'Failed to extract text from document',
    parentId: null,
    extractionStatus: 'error',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-04-15T10:00:00Z',
    updatedAt: '2026-05-06T12:00:00Z',
  },
  {
    id: 'knowledge-3',
    tenantId: 'tenant-1',
    title: 'Engineering Handbook',
    sourceUrl: null,
    connectorId: null,
    connectorType: null,
    externalId: null,
    contentType: 'document',
    excerpt: 'Internal handbook covering engineering processes, standards, and best practices.',
    metadata: {},
    importMode: 'manual',
    syncStatus: 'synced',
    lastSyncedAt: null,
    syncError: null,
    parentId: null,
    extractionStatus: 'none',
    extractedText: null,
    extractedAt: null,
    createdAt: '2026-02-10T08:00:00Z',
    updatedAt: '2026-04-20T11:00:00Z',
  },
]

const zendeskBrowseResults: BrowseResult[] = [
  {
    id: 'zd-article-1',
    title: 'How to reset your password',
    url: 'https://support.example.com/articles/how-to-reset-password',
    contentType: 'article',
    excerpt: 'Step-by-step instructions for resetting your account password.',
    metadata: { section: 'Account Management', votes: 142 },
  },
  {
    id: 'zd-article-2',
    title: 'Getting started guide',
    url: 'https://support.example.com/articles/getting-started',
    contentType: 'article',
    excerpt: 'Everything you need to know to get up and running quickly.',
    metadata: { section: 'Onboarding', votes: 398 },
  },
  {
    id: 'zd-article-3',
    title: 'How to invite team members',
    url: 'https://support.example.com/articles/invite-team-members',
    contentType: 'article',
    excerpt: 'Learn how to add colleagues to your workspace.',
    metadata: { section: 'Team Management', votes: 87 },
  },
  {
    id: 'zd-article-4',
    title: 'Billing and subscription FAQ',
    url: 'https://support.example.com/articles/billing-faq',
    contentType: 'article',
    excerpt: 'Answers to common questions about billing cycles, invoices, and plan changes.',
    metadata: { section: 'Billing', votes: 211 },
  },
  {
    id: 'zd-article-5',
    title: 'Connecting your first integration',
    url: 'https://support.example.com/articles/first-integration',
    contentType: 'article',
    excerpt: 'A walkthrough for connecting external tools and services.',
    metadata: { section: 'Integrations', votes: 174 },
  },
  {
    id: 'zd-article-6',
    title: 'Understanding agent permissions',
    url: 'https://support.example.com/articles/agent-permissions',
    contentType: 'article',
    excerpt: 'Overview of how agent-level permissions and scopes work.',
    metadata: { section: 'Agents', votes: 63 },
  },
  {
    id: 'zd-article-7',
    title: 'Exporting your data',
    url: 'https://support.example.com/articles/export-data',
    contentType: 'article',
    excerpt: 'How to export your workspace data in various formats.',
    metadata: { section: 'Data & Privacy', votes: 55 },
  },
  {
    id: 'zd-article-8',
    title: 'Troubleshooting sync errors',
    url: 'https://support.example.com/articles/troubleshoot-sync',
    contentType: 'article',
    excerpt: 'Common sync errors and how to resolve them.',
    metadata: { section: 'Troubleshooting', votes: 129 },
  },
]

const intercomBrowseResults: BrowseResult[] = [
  {
    id: 'ic-article-1',
    title: 'How to reset your password',
    url: 'https://intercom.help/example/en/articles/1001-reset-password',
    contentType: 'article',
    excerpt: 'Follow these steps to securely reset your account password.',
    metadata: { collection: 'Account', reads: 3201 },
  },
  {
    id: 'ic-article-2',
    title: 'Getting started guide',
    url: 'https://intercom.help/example/en/articles/1002-getting-started',
    contentType: 'article',
    excerpt: 'Start here to learn the basics and set up your workspace.',
    metadata: { collection: 'Onboarding', reads: 7842 },
  },
  {
    id: 'ic-article-3',
    title: 'Managing notifications',
    url: 'https://intercom.help/example/en/articles/1003-notifications',
    contentType: 'article',
    excerpt: 'Customize how and when you receive notifications.',
    metadata: { collection: 'Settings', reads: 1450 },
  },
  {
    id: 'ic-article-4',
    title: 'How to upgrade your plan',
    url: 'https://intercom.help/example/en/articles/1004-upgrade-plan',
    contentType: 'article',
    excerpt: 'Steps to upgrade to a higher-tier plan and what changes.',
    metadata: { collection: 'Billing', reads: 2180 },
  },
  {
    id: 'ic-article-5',
    title: 'Two-factor authentication setup',
    url: 'https://intercom.help/example/en/articles/1005-2fa-setup',
    contentType: 'article',
    excerpt: 'Improve account security by enabling 2FA.',
    metadata: { collection: 'Security', reads: 990 },
  },
  {
    id: 'ic-article-6',
    title: 'Understanding usage limits',
    url: 'https://intercom.help/example/en/articles/1006-usage-limits',
    contentType: 'article',
    excerpt: 'What counts toward your usage limits and how to monitor them.',
    metadata: { collection: 'Billing', reads: 1640 },
  },
  {
    id: 'ic-article-7',
    title: 'Creating and managing teams',
    url: 'https://intercom.help/example/en/articles/1007-teams',
    contentType: 'article',
    excerpt: 'How to organize workspace members into teams.',
    metadata: { collection: 'Team Management', reads: 870 },
  },
  {
    id: 'ic-article-8',
    title: 'API rate limits explained',
    url: 'https://intercom.help/example/en/articles/1008-api-rate-limits',
    contentType: 'article',
    excerpt: 'Details on rate limits for API integrations and how to handle them.',
    metadata: { collection: 'Developers', reads: 1120 },
  },
]

const driveBrowseResults: BrowseResult[] = [
  {
    id: 'drive-folder-1',
    title: 'Q1 Reports',
    url: null,
    contentType: 'folder',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.folder' },
  },
  {
    id: 'drive-folder-2',
    title: 'Design Assets',
    url: null,
    contentType: 'folder',
    excerpt: null,
    metadata: { mimeType: 'application/vnd.google-apps.folder' },
  },
  {
    id: 'drive-file-1',
    title: 'Product Requirements Document — v2.3',
    url: 'https://docs.google.com/document/d/mock-1/edit',
    contentType: 'document',
    excerpt: 'Detailed requirements for the upcoming product release cycle.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 62400 },
  },
  {
    id: 'drive-file-2',
    title: 'Engineering Roadmap 2026',
    url: 'https://docs.google.com/document/d/mock-2/edit',
    contentType: 'document',
    excerpt: 'High-level engineering initiatives and milestones for 2026.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 43100 },
  },
  {
    id: 'drive-file-3',
    title: 'Quarterly Business Review — Q4 2025',
    url: 'https://docs.google.com/presentation/d/mock-3/edit',
    contentType: 'document',
    excerpt: 'Executive summary and metrics from the Q4 2025 business review.',
    metadata: { mimeType: 'application/vnd.google-apps.presentation', size: 18700 },
  },
  {
    id: 'drive-file-4',
    title: 'Onboarding Checklist Template',
    url: 'https://docs.google.com/document/d/mock-4/edit',
    contentType: 'document',
    excerpt: 'Standardized checklist for onboarding new team members.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 11200 },
  },
  {
    id: 'drive-file-5',
    title: 'Budget Forecast 2026',
    url: 'https://docs.google.com/spreadsheets/d/mock-5/edit',
    contentType: 'document',
    excerpt: 'Annual budget projections by department.',
    metadata: { mimeType: 'application/vnd.google-apps.spreadsheet', size: 29800 },
  },
  {
    id: 'drive-file-6',
    title: 'Brand Guidelines v4',
    url: 'https://docs.google.com/presentation/d/mock-6/edit',
    contentType: 'document',
    excerpt: 'Official brand guidelines including colors, typography, and usage.',
    metadata: { mimeType: 'application/vnd.google-apps.presentation', size: 55600 },
  },
  {
    id: 'drive-file-7',
    title: 'Customer Feedback Analysis — March 2026',
    url: 'https://docs.google.com/document/d/mock-7/edit',
    contentType: 'document',
    excerpt: 'Synthesis of customer feedback collected during March 2026.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 34900 },
  },
  {
    id: 'drive-file-8',
    title: 'Security Audit Report 2025',
    url: 'https://docs.google.com/document/d/mock-8/edit',
    contentType: 'document',
    excerpt: 'Annual security audit findings and remediation actions.',
    metadata: { mimeType: 'application/vnd.google-apps.document', size: 78300 },
  },
]

export const knowledgeHandlers = [
  // IMPORTANT: Specific routes must come before parameterized routes

  // Batch create (must be before /:id route)
  http.post('*/api/knowledge/batch', async ({ request }) => {
    const body = await request.json() as { items: CreateKnowledgeItemInput[] }
    const now = new Date().toISOString()
    const created: KnowledgeItem[] = (body.items ?? []).map((item) => {
      const newItem: KnowledgeItem = {
        id: Math.random().toString(36).slice(2),
        tenantId: 'tenant-1',
        title: item.title,
        sourceUrl: item.sourceUrl ?? null,
        connectorId: item.connectorId ?? null,
        connectorType: item.connectorType ?? null,
        externalId: item.externalId ?? null,
        contentType: item.contentType,
        excerpt: item.excerpt ?? null,
        metadata: item.metadata ?? {},
        importMode: item.importMode ?? 'manual',
        syncStatus: 'pending',
        lastSyncedAt: null,
        syncError: null,
        parentId: item.parentId ?? null,
        extractionStatus: item.extractionStatus ?? 'none',
        extractedText: null,
        extractedAt: null,
        createdAt: now,
        updatedAt: now,
      }
      mockItems.push(newItem)
      return newItem
    })
    return HttpResponse.json({ created })
  }),

  // Browse connector (must be before /:id route)
  http.get('*/api/knowledge/browse', ({ request }) => {
    const url = new URL(request.url)
    const connectorId = url.searchParams.get('connectorId') ?? ''
    const folderId = url.searchParams.get('folderId') ?? ''
    const query = (url.searchParams.get('query') ?? '').toLowerCase().trim()

    // When inside a folder, return file-only results
    if (folderId) {
      const folderContents: BrowseResult[] = [
        {
          id: `${folderId}-file-1`,
          title: 'Project Brief.docx',
          url: 'https://drive.google.com/file/d/mock-f1',
          contentType: 'document',
          excerpt: null,
          metadata: { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
        },
        {
          id: `${folderId}-file-2`,
          title: 'Budget Tracker.xlsx',
          url: 'https://drive.google.com/file/d/mock-f2',
          contentType: 'document',
          excerpt: null,
          metadata: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
        },
        {
          id: `${folderId}-file-3`,
          title: 'Presentation.pptx',
          url: 'https://drive.google.com/file/d/mock-f3',
          contentType: 'document',
          excerpt: null,
          metadata: { mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
        },
      ]
      const filtered = query ? folderContents.filter((r) => r.title.toLowerCase().includes(query)) : folderContents
      return HttpResponse.json({ results: filtered, nextCursor: null })
    }

    let results: BrowseResult[]
    if (connectorId.includes('zendesk')) {
      results = zendeskBrowseResults
    } else if (connectorId.includes('intercom')) {
      results = intercomBrowseResults
    } else {
      results = driveBrowseResults
    }

    const filtered = query ? results.filter((r) => r.title.toLowerCase().includes(query)) : results
    return HttpResponse.json({ results: filtered, nextCursor: null })
  }),

  // Import connector (must be before /:id route)
  http.post('*/api/knowledge/import', () => {
    return HttpResponse.json({ status: 'importing' })
  }),

  // Sync items (must be before /:id route)
  http.post('*/api/knowledge/sync', () => {
    return HttpResponse.json({ synced: mockItems.filter((i) => i.syncStatus === 'synced').length, errors: 0 })
  }),

  // List knowledge items
  http.get('*/api/knowledge', () => {
    return HttpResponse.json(mockItems)
  }),

  // Create knowledge item
  http.post('*/api/knowledge', async ({ request }) => {
    const body = await request.json() as CreateKnowledgeItemInput
    const now = new Date().toISOString()
    const newItem: KnowledgeItem = {
      id: Math.random().toString(36).slice(2),
      tenantId: 'tenant-1',
      title: body.title,
      sourceUrl: body.sourceUrl ?? null,
      connectorId: body.connectorId ?? null,
      connectorType: body.connectorType ?? null,
      externalId: body.externalId ?? null,
      contentType: body.contentType,
      excerpt: body.excerpt ?? null,
      metadata: body.metadata ?? {},
      importMode: body.importMode ?? 'manual',
      syncStatus: 'pending',
      lastSyncedAt: null,
      syncError: null,
      parentId: body.parentId ?? null,
      extractionStatus: body.extractionStatus ?? 'none',
      extractedText: null,
      extractedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    mockItems.push(newItem)
    return HttpResponse.json(newItem, { status: 201 })
  }),

  // Update knowledge item
  http.put('*/api/knowledge/:id', async ({ params, request }) => {
    const body = await request.json() as Partial<CreateKnowledgeItemInput>
    const item = mockItems.find((i) => i.id === params.id)
    if (!item) {
      return HttpResponse.json({ error: 'Knowledge item not found' }, { status: 404 })
    }
    const updated: KnowledgeItem = {
      ...item,
      ...(body.title !== undefined && { title: body.title }),
      ...(body.sourceUrl !== undefined && { sourceUrl: body.sourceUrl ?? null }),
      ...(body.connectorId !== undefined && { connectorId: body.connectorId ?? null }),
      ...(body.connectorType !== undefined && { connectorType: body.connectorType ?? null }),
      ...(body.externalId !== undefined && { externalId: body.externalId ?? null }),
      ...(body.contentType !== undefined && { contentType: body.contentType }),
      ...(body.excerpt !== undefined && { excerpt: body.excerpt ?? null }),
      ...(body.metadata !== undefined && { metadata: body.metadata ?? {} }),
      ...(body.importMode !== undefined && { importMode: body.importMode }),
      updatedAt: new Date().toISOString(),
    }
    mockItems = mockItems.map((i) => (i.id === params.id ? updated : i))
    return HttpResponse.json(updated)
  }),

  // Delete knowledge item
  http.delete('*/api/knowledge/:id', ({ params }) => {
    mockItems = mockItems.filter((i) => i.id !== params.id)
    return new HttpResponse(null, { status: 204 })
  }),
]
