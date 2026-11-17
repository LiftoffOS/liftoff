// Codegen aid for ComposioPollSpec entries (NOT runtime).
//
// Given (connectorType, action, entityType, eventTopics), fetch the Composio
// action's input schema and emit a draft PollEntity with pagination + since
// resolved from the input params — so populating a connector is verify-and-paste,
// not guess. Anything unresolved (e.g. a header-only cursor) is printed as a
// WARN so there are no silent gaps. recordsPath + fields still come from the
// vendor's documented response schema (Composio's output schema is shallow).
//
// Usage: ts-node scripts/probe-poll-spec.ts <toolkit> <ACTION_SLUG> [entityType] [topic,topic]
//   COMPOSIO_API_KEY must be set.

import { Composio } from '@composio/core';

interface Draft {
  action: string;
  pagination?: Record<string, unknown>;
  since?: Record<string, unknown>;
  warnings: string[];
}

function resolvePagination(props: Record<string, { type?: string; description?: string }>): { pagination?: Record<string, unknown>; warn: string[] } {
  const keys = Object.keys(props);
  const has = (re: RegExp) => keys.find(k => re.test(k));
  const limitArg = has(/^(per_page|page_size|limit)$/i);
  const warn: string[] = [];
  if (has(/^cursor$/i)) {
    const cursorArg = has(/^cursor$/i)!;
    warn.push(`cursor pagination: confirm the response path to the next cursor (Composio strips Link headers — if the cursor is header-only, this connector is single-page).`);
    return { pagination: { mode: 'cursor', cursorArg, limitArg, cursorPath: ['<VERIFY: pagination.next_cursor | data.pagination.nextLink>'] }, warn };
  }
  if (has(/^after$/i)) {
    // `after` is ambiguous: some APIs want the last row's id (afterId), others
    // want a response-supplied cursor echoed back (cursor + cursorPath, which
    // ALSO gives the reliable "no more pages" signal when absent — e.g.
    // incident.io's pagination_meta.after). Default to cursor + make the caller
    // verify, because afterId silently over-pages when the response cursor differs.
    warn.push(`'after' pagination: VERIFY whether it echoes a response cursor (use mode 'cursor' + cursorPath, stops when absent) or takes the last row's id (mode 'afterId'). Defaulting to cursor.`);
    return { pagination: { mode: 'cursor', cursorArg: has(/^after$/i)!, limitArg, cursorPath: ['<VERIFY: pagination_meta.after | meta.next_cursor>'] }, warn };
  }
  if (has(/^(offset|_skip|skip)$/i)) return { pagination: { mode: 'offset', skipArg: has(/^(offset|_skip|skip)$/i)!, limitArg, hasMorePath: ['<VERIFY: has_more | more>'] }, warn };
  if (has(/^page$/i)) return { pagination: { mode: 'page', pageArg: has(/^page$/i)!, limitArg, totalPagesPath: ['<VERIFY: pagination.total_pages>'] }, warn };
  warn.push('no pagination param found — single page per cycle unless the response carries a cursor.');
  return { warn };
}

function resolveSince(props: Record<string, { type?: string; description?: string }>): { since?: Record<string, unknown>; warn: string[] } {
  const keys = Object.keys(props);
  const find = (re: RegExp) => keys.find(k => re.test(k));
  const warn: string[] = [];
  const updatedGt = find(/^updated_at_gt(e)?$/i) || find(/^(since|modified_since|updated_since)$/i);
  const createdGt = find(/^created_at_gt(e)?$/i);
  if (updatedGt) return { since: { mode: 'server', field: '<VERIFY updated ts path>', serverArg: { name: updatedGt, format: 'iso' } }, warn };
  if (createdGt) return { since: { mode: 'server', field: '<VERIFY created ts path>', serverArg: { name: createdGt, format: 'iso' } }, warn };
  const sortBy = find(/^sort(_by(_field)?)?$/i);
  if (sortBy) { warn.push(`no server updated-since filter — use sortDesc on '${sortBy}' + client-side since gate.`); return { since: { mode: 'sortDesc', field: '<VERIFY updated ts path>', sortArg: { byArg: sortBy, byValue: '<VERIFY updated sort value>', dirArg: '<VERIFY dir arg>', descValue: '<VERIFY>' } }, warn }; }
  warn.push('no server since filter and no sort param — polling will re-scan; rely on version dedup.');
  return { warn };
}

async function main(): Promise<void> {
  const [toolkit, action, entityType = '<Entity>', topics = 'entity.created'] = process.argv.slice(2);
  if (!toolkit || !action) { console.error('usage: probe-poll-spec <toolkit> <ACTION_SLUG> [entityType] [topics]'); process.exit(1); }
  const c = new Composio({ apiKey: process.env.COMPOSIO_API_KEY! });
  const tools = await c.tools.getRawComposioTools({ toolkits: [toolkit], limit: 500 });
  const t = tools.find(x => x.slug === action);
  if (!t) { console.error(`action ${action} not found in toolkit ${toolkit}`); process.exit(1); }
  const props = (t.inputParameters?.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const pag = resolvePagination(props);
  const since = resolveSince(props);
  const draft: Draft = { action, pagination: pag.pagination, since: since.since, warnings: [...pag.warn, ...since.warn] };
  console.log(`\n// ${toolkit} — paste into COMPOSIO_POLL_SPECS after filling <VERIFY …> from the vendor docs:`);
  console.log(`${toolkit}: { connectorType: '${toolkit}', entities: [{`);
  console.log(`  entityType: '${entityType}', eventTopics: [${topics.split(',').map(s => `'${s}'`).join(', ')}],`);
  console.log(`  action: '${action}', recordsPath: ['<VERIFY response array path>'], idField: 'id',`);
  if (draft.since) console.log(`  since: ${JSON.stringify(draft.since)},`);
  if (draft.pagination) console.log(`  pagination: ${JSON.stringify(draft.pagination)},`);
  console.log(`  fields: { /* <VERIFY from vendor response schema> */ },`);
  console.log(`}] },`);
  if (draft.warnings.length) console.log('\n// WARNINGS:\n' + draft.warnings.map(w => '//  - ' + w).join('\n'));
}

main().catch(e => { console.error('ERR', (e as Error).message); process.exit(1); });
