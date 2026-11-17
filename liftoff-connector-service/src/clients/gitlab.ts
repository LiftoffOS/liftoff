// GitLab Connector Client (reactive polling)
//
// GitLab.com ships a first-party MCP (https://gitlab.com/api/v4/mcp) used for
// agent CRUD, but that MCP exposes NO "list my merge requests / issues" tool,
// so it can't serve the deterministic enumeration the polling scheduler needs.
// Instead we poll GitLab's documented REST API with the connector's OAuth token
// (scope `api`), mirroring how GitHubMCPClient polls the GitHub search API:
//   MRs:    GET /api/v4/merge_requests?scope=<s>&updated_after=<since>&order_by=updated_at&sort=desc
//   Issues: GET /api/v4/issues?scope=<s>&updated_after=<since>&order_by=updated_at&sort=desc
// GitHub's poller uses involves:@me (author/assignee/reviewer/mentioned) in one
// query. GitLab has no single "involves me" scope, so we UNION the per-user
// scopes a review bot cares about: created_by_me, assigned_to_me, and — for MRs
// only — reviews_for_me (the primary review-bot trigger: MRs where this account
// is a requested reviewer). Issues have no reviewer concept, so they union only
// created_by_me + assigned_to_me. `updated_after` gives incremental change
// detection; `order_by=updated_at&sort=desc` returns newest activity first.
// We deliberately avoid scope=all: on gitlab.com the global endpoint tries to
// return every MR/issue the account can view across all projects and times out
// (408) / 500s.
//
// The scheduler polls the catalog `polling[].entityType` values, which are
// 'PullRequest' and 'Issue' (identical to GitHub) — NOT 'MergeRequest' — so a
// single software-delivery-team subscription matches events from both hosts.
// list() therefore accepts 'PullRequest' (→ merge_requests) and 'Issue'.
//
// Only list() is implemented — agent CRUD on GitLab goes through the vendor MCP
// tool-gateway path, not this structured client. The token is obtained exactly
// like GitHubMCPClient: an OAuthTokenProvider bound to connectorType 'gitlab'
// over the same CredentialStore.

import {
  CompensationClient, ExternalRecord, CreateResult, UpdateResult, DeleteResult,
  ListFilters, ListResult,
} from './types.js';
import { OAuthTokenProvider } from '../mcp/token-provider.js';
import { CredentialStore } from '../mcp/credential-store.js';
import { logger } from '../infra/logging.js';

export interface GitLabClientConfig {
  tenantId: string;
  credentialStore: CredentialStore;
}

// Decode the scope-sequencing cursor "<scopeIndex>:<page>". A missing/empty/
// malformed token restarts the union at scope 0, page 1 (both 1-based page and
// 0-based scope index are what list() re-encodes on every call).
function parsePageToken(pageToken?: string): { scopeIndex: number; page: number } {
  if (!pageToken) return { scopeIndex: 0, page: 1 };
  const [rawScope, rawPage] = pageToken.split(':');
  const scopeIndex = Number(rawScope);
  const page = Number(rawPage);
  return {
    scopeIndex: Number.isInteger(scopeIndex) && scopeIndex >= 0 ? scopeIndex : 0,
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export class GitLabClient implements CompensationClient {
  readonly connector = 'gitlab';
  private readonly tokenProvider: OAuthTokenProvider;
  private readonly tenantId: string;
  private readonly baseUrl = 'https://gitlab.com/api/v4';

  constructor(config: GitLabClientConfig) {
    this.tenantId = config.tenantId;
    this.tokenProvider = new OAuthTokenProvider(
      { tenantId: config.tenantId, connectorType: 'gitlab' },
      config.credentialStore,
    );
  }

  async list(entityType: string, filters?: ListFilters): Promise<ListResult> {
    // Map the polled entityType to the REST collection. The catalog polls
    // 'PullRequest'/'Issue' (mirroring GitHub); a GitLab merge request is served
    // from /merge_requests but published under the 'PullRequest' entityType.
    const path =
      entityType === 'PullRequest' ? 'merge_requests'
      : entityType === 'Issue' ? 'issues'
      : undefined;
    if (!path) return { records: [], hasMore: false, unsupported: true };

    // GitLab has no single "involves me" scope, so we UNION the per-user scopes
    // a review bot cares about. reviews_for_me (MRs where this account is a
    // requested reviewer) exists only for merge requests; issues have no
    // reviewer concept, so they union just created_by_me + assigned_to_me.
    const scopes = entityType === 'PullRequest'
      ? ['created_by_me', 'assigned_to_me', 'reviews_for_me']
      : ['created_by_me', 'assigned_to_me'];

    // The scheduler deep-paginates one entityType by re-calling list() while
    // nextPageToken is set, so we sequence the scopes THROUGH pageToken, encoded
    // as "<scopeIndex>:<page>". No/empty token starts at scope 0, page 1.
    const { scopeIndex, page } = parsePageToken(filters?.pageToken);
    const perPage = filters?.limit ?? 100;

    const params = new URLSearchParams({
      scope: scopes[scopeIndex],
      order_by: 'updated_at',
      sort: 'desc',
      per_page: String(perPage),
      page: String(page),
    });
    if (filters?.since instanceof Date) {
      params.set('updated_after', filters.since.toISOString());
    }

    const token = await this.tokenProvider.getToken();
    try {
      const res = await fetch(`${this.baseUrl}/${path}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`GitLab ${path} API ${res.status}: ${await res.text()}`);
      }
      const items = ((await res.json()) as Array<Record<string, unknown>>) ?? [];
      const records = items.map(it => ({ id: String(it.id), data: it }));

      // Advance the cursor. A full page means the current scope has more rows —
      // stay on it and bump the page. A short page drains this scope: move to the
      // next scope's first page, or finish (undefined) once every scope is drained.
      // An MR matching several scopes (e.g. authored AND requested-as-reviewer) is
      // published once per scope; the downstream reactive-subscription cooldown
      // dedups those, and list() is stateless per call so it cannot (and must not
      // try to) dedup across scopes itself.
      let nextPageToken: string | undefined;
      if (items.length === perPage) {
        nextPageToken = `${scopeIndex}:${page + 1}`;
      } else if (scopeIndex + 1 < scopes.length) {
        nextPageToken = `${scopeIndex + 1}:1`;
      }
      return { records, nextPageToken, hasMore: nextPageToken != null };
    } catch (err) {
      logger.warn('GitLab list failed', {
        entityType, path, tenantId: this.tenantId, error: (err as Error).message,
      });
      throw err;
    }
  }

  // ── Tool-gateway REST operations ──────────────────────────────────────
  // The review roles' tools (get/create merge-request + notes) run over the
  // documented GitLab REST API with the connector's `api`-scoped OAuth token —
  // NOT GitLab's vendor MCP, which requires a distinct `mcp`-scope token
  // (dynamic-client-registration only) our static OAuth app can't hold. REST
  // covers the whole surface, so gitlab is a native-REST tool connector (no
  // `mcp` field in the catalog; makeMCPClientExecutor still supplies the token
  // provider because the credential shape is identical to the poller's).

  private encodeProject(project: unknown): string {
    // Accept a numeric project id OR a namespace path ("group/project");
    // URL-encode so the path form survives GitLab's /projects/:id segment.
    return encodeURIComponent(String(project ?? '').trim());
  }

  private async apiFetch(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; json: any; text: string }> {
    const token = await this.tokenProvider.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json: any;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return { ok: res.ok, status: res.status, json, text };
  }

  // get_merge_request / get_merge_request_diffs / get_merge_request_notes.
  // The registry function's entityType selects the sub-resource; all three take
  // { project, merge_request_iid } in the tool payload (GitLab MR REST needs a
  // project id/path AND the MR iid, which extractEntityId can't surface alone).
  async read(entityType: string, entityId: string | undefined, payload?: Record<string, any>): Promise<ExternalRecord> {
    const p = payload ?? {};
    const project = this.encodeProject(p.project ?? p.projectId);
    const iid = String(p.merge_request_iid ?? p.mergeRequestIid ?? entityId ?? '').trim();
    if (!project) throw new Error('gitlab read: `project` (id or group/path) is required');
    if (!iid) throw new Error('gitlab read: `merge_request_iid` is required');
    const base = `/projects/${project}/merge_requests/${iid}`;
    switch (entityType) {
      case 'merge_request': {
        const r = await this.apiFetch('GET', base);
        if (!r.ok) throw new Error(`gitlab get_merge_request ${r.status}: ${r.text}`);
        return { id: String(r.json?.iid ?? iid), data: r.json };
      }
      case 'merge_request_diffs': {
        const r = await this.apiFetch('GET', `${base}/diffs?per_page=100`);
        if (!r.ok) throw new Error(`gitlab get_merge_request_diffs ${r.status}: ${r.text}`);
        return { id: iid, data: { diffs: r.json } };
      }
      case 'merge_request_notes': {
        const r = await this.apiFetch('GET', `${base}/notes?per_page=100&sort=asc&order_by=created_at`);
        if (!r.ok) throw new Error(`gitlab get_merge_request_notes ${r.status}: ${r.text}`);
        return { id: iid, data: { notes: r.json } };
      }
      default:
        throw new Error(`gitlab read: unsupported entity type "${entityType}"`);
    }
  }

  // create_merge_request (software-engineer opens the MR) /
  // create_merge_request_note (reviewer/security/perf leaves a review comment).
  async create(entityType: string, data: Record<string, any>): Promise<CreateResult> {
    const p = data ?? {};
    const project = this.encodeProject(p.project ?? p.projectId);
    if (!project) return { success: false, id: '', error: 'gitlab create: `project` (id or group/path) is required' };
    try {
      switch (entityType) {
        case 'merge_request': {
          const source_branch = p.source_branch ?? p.sourceBranch;
          const target_branch = p.target_branch ?? p.targetBranch;
          const title = p.title;
          if (!source_branch || !target_branch || !title) {
            return { success: false, id: '', error: 'gitlab create_merge_request requires source_branch, target_branch, title' };
          }
          const r = await this.apiFetch('POST', `/projects/${project}/merge_requests`, {
            source_branch, target_branch, title,
            description: p.description ?? undefined,
            remove_source_branch: p.remove_source_branch ?? true,
          });
          if (!r.ok) return { success: false, id: '', error: `gitlab create_merge_request ${r.status}: ${r.text}` };
          return { success: true, id: String(r.json?.iid ?? ''), data: r.json };
        }
        case 'merge_request_note': {
          const iid = String(p.merge_request_iid ?? p.mergeRequestIid ?? '').trim();
          if (!iid) return { success: false, id: '', error: 'gitlab create_merge_request_note requires merge_request_iid' };
          if (!p.body) return { success: false, id: '', error: 'gitlab create_merge_request_note requires body' };
          const r = await this.apiFetch('POST', `/projects/${project}/merge_requests/${iid}/notes`, { body: p.body });
          if (!r.ok) return { success: false, id: '', error: `gitlab create_merge_request_note ${r.status}: ${r.text}` };
          return { success: true, id: String(r.json?.id ?? ''), data: r.json };
        }
        default:
          return { success: false, id: '', error: `gitlab create: unsupported entity type "${entityType}"` };
      }
    } catch (err) {
      return { success: false, id: '', error: (err as Error).message };
    }
  }

  // Update/delete/compensation are not part of the review loop; explicit
  // not-supported keeps the CompensationClient surface honest (INV-4: never a
  // fabricated success).
  async update(): Promise<UpdateResult> {
    return { success: false, error: 'gitlab: update not supported' };
  }
  async delete(): Promise<DeleteResult> {
    return { success: false, error: 'gitlab: delete not supported' };
  }
  async restore(): Promise<UpdateResult> {
    return { success: false, error: 'not supported' };
  }
  async semanticInverse(): Promise<DeleteResult> {
    return { success: false, data: { error: 'not supported' } } as DeleteResult;
  }
}
