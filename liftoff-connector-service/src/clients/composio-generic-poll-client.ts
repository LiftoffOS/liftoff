// Generic Composio poll client.
//
// One CompensationClient that interprets a ComposioPollSpec's PollEntity: builds
// the request args (pagination + since), calls the Composio action or HTTP proxy,
// extracts the record array, refines the since watermark client-side, stamps a
// `__pollEntity` discriminator, and returns records + a paginated nextPageToken.
// Replaces the per-connector bespoke poll clients.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { getComposio, composioProxyRequest } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';
import { hashCanonicalJson } from '../infra/idempotency.js';
import type { ComposioPollSpec, PollEntity, SinceSpec, PagSpec, SinceFormat } from '../polling/composio-poll-spec.js';

// Record id: the id path, or a stable content hash when empty + idFallbackHash.
function recordId(r: Record<string, unknown>, ent: PollEntity): string {
  const id = String(getPath(r, ent.idField ?? 'id') ?? '');
  return id || (ent.idFallbackHash ? hashCanonicalJson(r) : '');
}

// Hard bound on pages fetched in one poll cycle (the scheduler loops on
// nextPageToken); prevents a runaway if a vendor never signals "no more".
const MAX_PAGES = 100;
// Unlikely-in-cursor separator used to carry a page ordinal inside the token.
const TOKEN_SEP = '::@::';

// ── path + value helpers ─────────────────────────────────────────────────────
export function getPath(obj: unknown, path: string | string[]): unknown {
  const segs = Array.isArray(path) ? path : String(path).split('.');
  let cur: unknown = obj;
  for (const s of segs) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[s];
  }
  return cur;
}

// Set a value at a dot-path, creating intermediate objects. Lets a SinceSpec
// serverArg target a nested filter (e.g. 'filter.createdAt.gt') as well as a
// flat arg (e.g. 'updated_at_gt').
function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const segs = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i];
    if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {};
    cur = cur[s] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1]] = value;
}

// A cursor value is sometimes a full next-page URL; extract its `cursor` query
// param when so, else use the value verbatim.
function cursorValue(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (/^https?:\/\//.test(v)) {
    try { return new URL(v).searchParams.get('cursor') || v; } catch { return v; }
  }
  return v;
}

// Response envelope → record array. Explicit recordsPath, else common shapes.
export function extractArray(data: unknown, recordsPath?: string[]): Array<Record<string, unknown>> {
  if (recordsPath) {
    const v = getPath(data, recordsPath);
    return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
  }
  if (Array.isArray(data)) return data as Array<Record<string, unknown>>;
  // 'value' covers OData/Microsoft Graph envelopes (Dynamics 365, etc.).
  for (const cand of [['data', 'items'], ['data'], ['items'], ['results'], ['records'], ['value']]) {
    const v = getPath(data, cand);
    if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  }
  return [];
}

function toMs(v: unknown): number {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000; // sec vs ms heuristic
  if (typeof v === 'string') { const ms = new Date(v).getTime(); return Number.isNaN(ms) ? 0 : ms; }
  return 0;
}

function fmtSince(ms: number, format: SinceFormat, offsetDays?: number): string | number {
  const d = new Date(ms - (offsetDays ?? 0) * 24 * 60 * 60 * 1000);
  switch (format) {
    case 'iso': return d.toISOString();
    case 'dateOnly': return d.toISOString().slice(0, 10);
    case 'unixSec': return Math.floor(d.getTime() / 1000);
    case 'unixMs': return d.getTime();
    case 'pipedriveDateTime': return d.toISOString().slice(0, 19).replace('T', ' ');
    // 'YYYY-MM-DD HH:MM:SS' (space, no T/Z) — Jotform submission filters, etc.
    case 'spaceDateTime': return d.toISOString().slice(0, 19).replace('T', ' ');
  }
}

// ── page-token packing (bounds every pagination mode at MAX_PAGES) ────────────
function unpack(tok?: string): { raw: string; ord: number } {
  if (!tok) return { raw: '', ord: 0 };
  const i = tok.lastIndexOf(TOKEN_SEP);
  if (i < 0) return { raw: tok, ord: 0 };
  return { raw: tok.slice(0, i), ord: Number(tok.slice(i + TOKEN_SEP.length)) || 0 };
}
function pack(raw: string, ord: number): string { return `${raw}${TOKEN_SEP}${ord}`; }

// Composio proxy queryParams are string|number only; drop undefined + coerce.
function toQueryParams(args: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v == null) continue;
    out[k] = typeof v === 'string' || typeof v === 'number' ? v : String(v);
  }
  return out;
}

export class ComposioGenericPollClient implements CompensationClient {
  readonly connector: string;
  constructor(
    private readonly spec: ComposioPollSpec,
    private readonly tenantId: string,
    private readonly connectedAccountId: string,
  ) {
    this.connector = spec.connectorType;
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    const ent = this.spec.entities.find(e => e.entityType === entityType);
    if (!ent) return { records: [], hasMore: false, unsupported: true };

    const sinceMs = filters?.since instanceof Date ? filters.since.getTime() : 0;
    const { raw: pageRaw, ord } = unpack(filters?.pageToken);
    const args: Record<string, unknown> = { ...(ent.staticArgs ?? {}) };
    this.applyPagination(args, ent.pagination, pageRaw);
    this.applySince(args, ent.since, sinceMs);
    if (ent.since?.mode === 'durableCursor' && filters?.syncCursor) {
      this.applyDurableResume(args, ent, filters.syncCursor, pageRaw);
    }

    let data: unknown;
    try {
      if ((this.spec.transport ?? 'action') === 'proxy') {
        data = await composioProxyRequest<unknown>({
          connectedAccountId: this.connectedAccountId,
          method: ent.proxy!.method,
          endpoint: ent.proxy!.endpoint,
          queryParams: { ...ent.proxy!.queryParams, ...toQueryParams(args) },
        });
      } else {
        const resp = await getComposio().tools.execute(ent.action!, {
          userId: this.tenantId,
          connectedAccountId: this.connectedAccountId,
          arguments: args,
          dangerouslySkipVersionCheck: true,
        });
        if (resp.successful === false) throw new Error(resp.error || `${ent.action} returned successful=false`);
        data = resp.data;
      }
    } catch (err) {
      logger.warn('Composio generic poll failed', {
        connectorType: this.connector, entityType, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }

    const rows = extractArray(data, ent.recordsPath);
    const kept = rows.filter(r => this.sinceGate(r, ent.since, sinceMs));
    const records: ExternalRecord[] = kept.map(r => ({
      id: recordId(r, ent),
      data: { ...r, __pollEntity: entityType },
    }));
    const nextRaw = this.computeNextRaw(data, rows, ent, pageRaw, sinceMs);
    // Bound every mode at MAX_PAGES. If the vendor still signals more but we've
    // hit the cap, stop — but log it: silent truncation would look like "caught
    // up" when a backlog remains (the next cycle resumes from the advanced since).
    if (nextRaw !== undefined && ord + 1 >= MAX_PAGES) {
      logger.warn('Composio generic poll hit MAX_PAGES — truncating this cycle', {
        connectorType: this.connector, entityType, tenantId: this.tenantId, maxPages: MAX_PAGES,
      });
    }
    const nextPageToken = nextRaw !== undefined && ord + 1 < MAX_PAGES ? pack(nextRaw, ord + 1) : undefined;
    const syncCursor = ent.since?.mode === 'durableCursor'
      ? this.computeDurableCursor(data, rows, ent) : undefined;
    return { records, hasMore: Boolean(nextPageToken), nextPageToken, syncCursor };
  }

  // durableCursor: resume from the persisted token. A `T:` token (separate
  // incremental token, e.g. Ashby syncToken) is sent on EVERY page — it defines
  // the delta window while the cursor paginates within it. A `C:` (or bare)
  // pagination-cursor resume (Instantly forward cursor / Ashby backfill
  // continuation) is applied only on the FIRST page; later pages use pageToken.
  private applyDurableResume(args: Record<string, unknown>, ent: PollEntity, persisted: string, pageRaw: string): void {
    const p = ent.pagination;
    if (persisted.startsWith('T:')) {
      const tokenArg = ent.since?.durable?.tokenArg;
      if (tokenArg) args[tokenArg] = persisted.slice(2);
      return;
    }
    if (pageRaw) return; // cursor-resume is first-page only
    const cur = persisted.startsWith('C:') ? persisted.slice(2) : persisted;
    if (p?.mode === 'cursor' && p.cursorArg) args[p.cursorArg] = cur;
    else if (p?.mode === 'afterId' && p.afterArg) args[p.afterArg] = cur;
  }

  // durableCursor: the token to persist for next cycle. Prefer a separate
  // incremental token (Ashby syncToken, on the final page) → `T:`; else carry the
  // pagination cursor as the forward resume (Instantly next cursor; Ashby
  // backfill continuation before a syncToken exists) → `C:`. Returns undefined
  // when this page carries nothing new (scheduler keeps the prior token).
  private computeDurableCursor(data: unknown, rows: Array<Record<string, unknown>>, ent: PollEntity): string | undefined {
    const tokenPath = ent.since?.durable?.tokenPath;
    if (tokenPath) {
      const tok = getPath(data, tokenPath);
      if (tok != null && String(tok) !== '') return `T:${String(tok)}`;
    }
    const p = ent.pagination;
    if (p?.mode === 'cursor' && p.cursorPath) {
      const cur = cursorValue(getPath(data, p.cursorPath));
      if (cur) return `C:${cur}`;
      // caught-up (next cursor absent) but rows exist → resume after the last id
      if (rows.length > 0) { const id = recordId(rows[rows.length - 1], ent); if (id) return `C:${id}`; }
    } else if (p?.mode === 'afterId' && rows.length > 0) {
      const id = recordId(rows[rows.length - 1], ent);
      if (id) return `C:${id}`;
    }
    return undefined;
  }

  private applyPagination(args: Record<string, unknown>, p: PagSpec | undefined, pageRaw: string): void {
    if (!p) return;
    if (p.limitArg && p.limit != null) args[p.limitArg] = p.limit;
    switch (p.mode) {
      case 'page':    args[p.pageArg!] = Number(pageRaw || '1') || 1; break;
      case 'offset':  args[p.skipArg!] = Number(pageRaw || '0') || 0; break;
      case 'cursor':  if (pageRaw) args[p.cursorArg!] = pageRaw; break;
      case 'afterId': if (pageRaw) args[p.afterArg!] = pageRaw; break;
      case 'none':    break;
    }
  }

  private applySince(args: Record<string, unknown>, s: SinceSpec | undefined, sinceMs: number): void {
    if (!s) return;
    if (s.mode === 'server' && sinceMs && s.serverArg) {
      const v = fmtSince(sinceMs, s.serverArg.format, s.serverArg.offsetDays);
      // template wraps the value for filter-expression APIs (Google Meet,
      // Jotform); otherwise the arg is the bare formatted value.
      setPath(args, s.serverArg.name, s.serverArg.template ? s.serverArg.template.replace('{value}', String(v)) : v);
      if (s.windowEndArg) setPath(args, s.windowEndArg.name, fmtSince(Date.now(), s.windowEndArg.format));
    }
    if (s.mode === 'sortDesc' && s.sortArg) {
      args[s.sortArg.byArg] = s.sortArg.byValue;
      if (s.sortArg.dirArg) args[s.sortArg.dirArg] = s.sortArg.descValue;
    }
  }

  private sinceGate(r: Record<string, unknown>, s: SinceSpec | undefined, sinceMs: number): boolean {
    if (!sinceMs || !s || s.mode === 'none' || !s.field) return true;
    const t = toMs(getPath(r, s.field));
    return t === 0 || t >= sinceMs; // keep timestamp-less rows (dedup handles them)
  }

  private computeNextRaw(
    data: unknown, rows: Array<Record<string, unknown>>, ent: PollEntity, pageRaw: string, sinceMs: number,
  ): string | undefined {
    const p = ent.pagination;
    if (!p || p.mode === 'none') return undefined;
    // An empty raw page means the vendor has no more records — stop regardless of
    // any cursor. Guards cursor APIs whose next-cursor persists past the end
    // (e.g. Instagram's paging.cursors.after) from looping to MAX_PAGES.
    if (rows.length === 0) return undefined;
    const full = p.limit != null && rows.length >= p.limit;
    // sortDesc: stop once this page's oldest DEFINED ts predates `since`.
    let reachedPastSince = false;
    if (sinceMs && ent.since?.mode === 'sortDesc' && ent.since.field) {
      const times = rows.map(r => toMs(getPath(r, ent.since!.field!))).filter(t => t > 0);
      reachedPastSince = times.length > 0 && Math.min(...times) < sinceMs;
    }
    const hasMore = p.hasMorePath ? Boolean(getPath(data, p.hasMorePath)) : full;
    switch (p.mode) {
      case 'page': {
        const page = Number(pageRaw || '1') || 1;
        const total = p.totalPagesPath ? Number(getPath(data, p.totalPagesPath) ?? 0) : Infinity;
        // hasMore honors an explicit next-signal (next_page URL, `next` link)
        // when present, else falls back to a full page — identical to the old
        // `full` behavior for page specs that set no hasMorePath.
        return hasMore && !reachedPastSince && page < total ? String(page + 1) : undefined;
      }
      case 'offset': {
        const skip = Number(pageRaw || '0') || 0;
        return hasMore && !reachedPastSince ? String(skip + (p.limit ?? rows.length)) : undefined;
      }
      case 'cursor': {
        const c = p.cursorPath ? cursorValue(getPath(data, p.cursorPath)) : undefined;
        return c && !reachedPastSince ? c : undefined;
      }
      case 'afterId': {
        const last = rows[rows.length - 1];
        const id = last ? recordId(last, ent) : '';
        // hasMore honors an explicit has_more flag when present (avoids a wasted
        // final page), else a full page — identical to `full` when unset.
        return hasMore && id && !reachedPastSince ? id : undefined;
      }
      default: return undefined;
    }
  }

  // read-only surface (polling only)
  async read(): Promise<ExternalRecord> { throw new Error(`${this.connector}: generic poll client supports list() only`); }
  async create(): Promise<CreateResult> { return { success: false, id: '', error: `${this.connector} read-only via polling` }; }
  async update(): Promise<UpdateResult> { return { success: false, error: `${this.connector} read-only via polling` }; }
  async delete(): Promise<DeleteResult> { return { success: false, error: `${this.connector} read-only via polling` }; }
  async restore(): Promise<UpdateResult> { return { success: false, error: 'not supported' }; }
  async semanticInverse(): Promise<DeleteResult> { return { success: false, data: { error: 'not supported' } } as DeleteResult; }
}
