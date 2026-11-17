// Notion Connector Normalizer
//
// Notion is reactive via native polling. notion is a vendor-hosted MCP client
// (mcp.notion.com/mcp); the polling scheduler hands NotionMCPClient.list('Page')
// results to normalize() as { results: [page] }. The page objects come straight
// from the Notion `search` tool response, so the field set is the documented
// Notion page object shape (id, url, timestamps, archived, parent) plus a
// best-effort title pulled from the title-type property in `properties`.
//
// There is no server-side `since` filter; list() sorts by last_edited_time
// descending and the scheduler dedups by version (last_edited_time).

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { hashCanonicalJson } from '../infra/idempotency.js';

interface NotionRichText {
  plain_text?: string;
}

interface NotionProperty {
  id?: string;
  type?: string;
  title?: NotionRichText[];
}

interface NotionParent {
  type?: string;
  page_id?: string;
  database_id?: string;
  workspace?: boolean;
  block_id?: string;
}

interface NotionPage {
  id?: string;
  object?: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
  archived?: boolean;
  parent?: NotionParent;
  properties?: Record<string, NotionProperty>;
}

interface NotionPayload {
  results?: NotionPage[];
}

const PageDataSchema = z.object({
  id: z.string().describe('Notion page id (UUID).'),
  title: z.string().optional().describe('Best-effort page title, plain text of the title-type property.'),
  url: z.string().optional().describe('Public/workspace URL of the page.'),
  createdTime: z.string().optional().describe('Page creation ISO timestamp.'),
  lastEditedTime: z.string().optional().describe('Page last-edited ISO timestamp — anchor for "alert when a doc changes" patterns.'),
  archived: z.boolean().optional().describe('Whether the page is archived (Notion has no hard delete via API).'),
  parentType: z.string().optional().describe('Parent container type (page_id, database_id, workspace, block_id).'),
  parentId: z.string().optional().describe('Id of the parent page/database/block, when applicable.'),
});

// Extract a best-effort title from a Notion page's properties. The title lives
// in whichever property has type 'title'; its value is an array of rich-text
// runs whose plain_text concatenates to the visible title.
function extractTitle(page: NotionPage): string | undefined {
  const props = page.properties;
  if (!props) return undefined;
  for (const prop of Object.values(props)) {
    if (prop?.type === 'title' && Array.isArray(prop.title)) {
      const text = prop.title.map(rt => rt?.plain_text ?? '').join('').trim();
      if (text) return text;
    }
  }
  return undefined;
}

function parentId(parent?: NotionParent): string | undefined {
  if (!parent) return undefined;
  return parent.page_id ?? parent.database_id ?? parent.block_id;
}

export class NotionNormalizer implements ConnectorNormalizer {
  connectorType = 'notion';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    Page: PageDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    const pages = (payload as NotionPayload)?.results ?? [];
    const records: NormalizedRecord[] = [];

    for (const page of pages) {
      if (page?.id === undefined || page.id === null) continue;
      const id = String(page.id);
      const declared: Record<string, unknown> = {
        id,
        title: extractTitle(page),
        url: page.url,
        createdTime: page.created_time,
        lastEditedTime: page.last_edited_time,
        archived: page.archived,
        parentType: page.parent?.type,
        parentId: parentId(page.parent),
      };
      records.push({
        entityType: 'Page',
        externalId: id,
        data: declared,
        metadata: {
          source: 'notion',
          syncedAt: new Date(),
          version: page.last_edited_time ?? hashCanonicalJson(page),
        },
      });
    }

    return records;
  }

  extractEntityType(_record: unknown): string {
    return 'Page';
  }

  extractExternalId(record: unknown): string {
    return String((record as NotionPage).id ?? '');
  }

  extractVersion(record: unknown): string | undefined {
    return (record as NotionPage).last_edited_time;
  }
}
