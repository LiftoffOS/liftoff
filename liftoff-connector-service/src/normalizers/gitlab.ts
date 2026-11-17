// GitLab Connector Normalizer
// Per Section 12: Connector ingestion
//
// Mirrors src/normalizers/github.ts. The polling scheduler calls normalize()
// with { results: [item, ...] } where each item is a raw GitLab REST object
// (a merge request from /merge_requests or an issue from /issues). A merge
// request carries `source_branch`/`target_branch`; an issue does not — that is
// the discriminator.
//
// CRITICAL: a GitLab merge request is emitted with entityType 'PullRequest'
// (NOT 'MergeRequest') and an issue with 'Issue', identical to the GitHub
// normalizer, so one software-delivery-team subscription matches both hosts.
// The published connector-event entityType is stamped by the scheduler from the
// catalog `polling[].entityType` (also 'PullRequest'/'Issue'); emitting the same
// values here keeps the entity-schema registry keyed consistently.

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { PullRequestDataSchema } from './shared/pull-request-schema';

interface GitLabUser {
  id?: number;
  username?: string;
  name?: string;
}

interface GitLabMergeRequest {
  id: number;
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  author?: GitLabUser;
  source_branch?: string;
  target_branch?: string;
  sha?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  assignees?: GitLabUser[];
  reviewers?: GitLabUser[];
  labels?: string[];
  project_id?: number;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string | null;
  closed_at?: string | null;
}

interface GitLabIssue {
  id: number;
  iid?: number;
  title?: string;
  description?: string | null;
  state?: string;
  author?: GitLabUser;
  assignees?: GitLabUser[];
  labels?: string[];
  milestone?: { title?: string; iid?: number } | null;
  project_id?: number;
  web_url?: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string | null;
}

// Field names mirror src/normalizers/github.ts so a predicate written against a
// GitHub PullRequest/Issue also matches the GitLab-sourced record.

const IssueDataSchema = z.object({
  id: z.string().describe('GitLab issue id.'),
  number: z.number().describe('GitLab issue iid (per-project number).'),
  title: z.string(),
  body: z.string().optional(),
  state: z.string().describe('opened | closed'),
  author: z.string(),
  authorId: z.number(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.string().optional(),
  milestoneNumber: z.number().optional(),
  repository: z.string().optional().describe('Project web URL.'),
  repositoryId: z.number().optional().describe('GitLab project id.'),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional().describe('Issue close timestamp — anchor for "alert N days after closure" patterns.'),
});

function isMergeRequest(item: Record<string, unknown>): boolean {
  // Merge requests always carry branch refs; issues never do.
  return item.source_branch != null || item.target_branch != null;
}

export class GitLabNormalizer implements ConnectorNormalizer {
  connectorType = 'gitlab';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    PullRequest: PullRequestDataSchema,
    Issue: IssueDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    // Reactive polling path: the scheduler wraps GitLabClient.list() results as
    // { results: [item, ...] }. Each item is a flat MR/issue object.
    const wrapped = (payload as { results?: Array<Record<string, unknown>> })?.results;
    if (Array.isArray(wrapped)) {
      const out: NormalizedRecord[] = [];
      for (const item of wrapped) {
        if (isMergeRequest(item)) {
          out.push(this.normalizeMergeRequest(item as unknown as GitLabMergeRequest));
        } else if (item?.id != null) {
          out.push(this.normalizeIssue(item as unknown as GitLabIssue));
        }
      }
      return out;
    }

    // Single bare object (defensive; the polling path above is the live one).
    const item = payload as Record<string, unknown>;
    if (item?.id == null) return [];
    return isMergeRequest(item)
      ? [this.normalizeMergeRequest(item as unknown as GitLabMergeRequest)]
      : [this.normalizeIssue(item as unknown as GitLabIssue)];
  }

  private normalizeMergeRequest(mr: GitLabMergeRequest): NormalizedRecord {
    return {
      entityType: 'PullRequest',
      externalId: String(mr.id),
      data: PullRequestDataSchema.parse({
        id: String(mr.id),
        number: mr.iid,
        title: mr.title,
        body: mr.description ?? undefined,
        state: mr.state,
        author: mr.author?.username,
        authorId: mr.author?.id,
        headRef: mr.source_branch,
        headSha: mr.sha,
        baseRef: mr.target_branch,
        merged: mr.state === 'merged' || !!mr.merged_at,
        draft: mr.draft ?? mr.work_in_progress ?? false,
        assignees: mr.assignees?.map(a => a.username).filter((u): u is string => !!u),
        reviewers: mr.reviewers?.map(r => r.username).filter((u): u is string => !!u),
        labels: mr.labels,
        repository: mr.web_url,
        repositoryId: mr.project_id,
        createdAt: mr.created_at,
        updatedAt: mr.updated_at,
        mergedAt: mr.merged_at ?? undefined,
        closedAt: mr.closed_at ?? undefined,
      }),
      metadata: {
        source: 'gitlab',
        syncedAt: new Date(),
        version: mr.updated_at as string,
      },
    };
  }

  private normalizeIssue(issue: GitLabIssue): NormalizedRecord {
    return {
      entityType: 'Issue',
      externalId: String(issue.id),
      data: IssueDataSchema.parse({
        id: String(issue.id),
        number: issue.iid,
        title: issue.title,
        body: issue.description ?? undefined,
        state: issue.state,
        author: issue.author?.username,
        authorId: issue.author?.id,
        assignees: issue.assignees?.map(a => a.username).filter((u): u is string => !!u),
        labels: issue.labels,
        milestone: issue.milestone?.title,
        milestoneNumber: issue.milestone?.iid,
        repository: issue.web_url,
        repositoryId: issue.project_id,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at ?? undefined,
      }),
      metadata: {
        source: 'gitlab',
        syncedAt: new Date(),
        version: issue.updated_at as string,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as Record<string, unknown>;
    if (r?.id == null) return 'Unknown';
    return isMergeRequest(r) ? 'PullRequest' : 'Issue';
  }

  extractExternalId(record: unknown): string {
    const r = record as { id?: unknown };
    return r?.id != null ? String(r.id) : '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as { updated_at?: string };
    return r?.updated_at;
  }
}
