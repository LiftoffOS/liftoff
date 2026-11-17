// GitHub Connector Normalizer
// Per Section 12: Connector ingestion

import { z } from 'zod';
import type { JSONSchema7 } from 'json-schema';
import { ConnectorNormalizer, NormalizedRecord } from './types.js';
import { buildEntitySchemas } from './zod-helpers.js';
import { PullRequestDataSchema } from './shared/pull-request-schema';

interface GitHubWebhookPayload {
  action?: string;
  sender?: {
    id: number;
    login: string;
    type: string;
    avatar_url: string;
  };
  repository?: {
    id: number;
    name: string;
    full_name: string;
    private: boolean;
    owner: { id: number; login: string };
    html_url: string;
    default_branch: string;
  };
  issue?: {
    id: number;
    number: number;
    title: string;
    body?: string;
    state: string;
    user: { id: number; login: string };
    assignees?: Array<{ id: number; login: string }>;
    labels?: Array<{ id: number; name: string; color: string }>;
    milestone?: { id: number; title: string; number: number };
    created_at: string;
    updated_at: string;
    closed_at?: string;
  };
  pull_request?: {
    id: number;
    number: number;
    title: string;
    body?: string;
    state: string;
    user: { id: number; login: string };
    head: { ref: string; sha: string };
    base: { ref: string; sha: string };
    merged: boolean;
    mergeable?: boolean;
    draft: boolean;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    assignees?: Array<{ id: number; login: string }>;
    requested_reviewers?: Array<{ id: number; login: string }>;
    labels?: Array<{ id: number; name: string; color: string }>;
    created_at: string;
    updated_at: string;
    merged_at?: string;
    closed_at?: string;
  };
  comment?: {
    id: number;
    body: string;
    user: { id: number; login: string };
    created_at: string;
    updated_at: string;
  };
  review?: {
    id: number;
    state: string;
    body?: string;
    user: { id: number; login: string };
    submitted_at: string;
  };
}


const IssueDataSchema = z.object({
  id: z.string().describe('GitHub issue id.'),
  number: z.number(),
  title: z.string(),
  body: z.string().optional(),
  state: z.string(),
  action: z.string().optional(),
  author: z.string(),
  authorId: z.number(),
  assignees: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),
  milestone: z.string().optional(),
  milestoneNumber: z.number().optional(),
  repository: z.string().optional(),
  repositoryId: z.number().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  closedAt: z.string().optional().describe('Issue close timestamp — anchor for "alert N days after closure" patterns.'),
  triggeredBy: z.string().optional(),
});

const CommentDataSchema = z.object({
  id: z.string().describe('GitHub comment id.'),
  body: z.string(),
  author: z.string(),
  authorId: z.number(),
  parentType: z.string(),
  parentId: z.number().optional(),
  action: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  triggeredBy: z.string().optional(),
});

const ReviewDataSchema = z.object({
  id: z.string().describe('GitHub review id.'),
  state: z.string(),
  body: z.string().optional(),
  author: z.string(),
  authorId: z.number(),
  pullRequestId: z.number().optional(),
  action: z.string().optional(),
  submittedAt: z.string(),
  triggeredBy: z.string().optional(),
});

export class GitHubNormalizer implements ConnectorNormalizer {
  connectorType = 'github';

  entitySchemas: Record<string, JSONSchema7> = buildEntitySchemas({
    PullRequest: PullRequestDataSchema,
    Issue: IssueDataSchema,
    Comment: CommentDataSchema,
    Review: ReviewDataSchema,
  });

  normalize(payload: unknown): NormalizedRecord[] {
    // Reactive polling path: the scheduler wraps GitHubMCPClient.list() search
    // results as { results: [item, ...] }. Each item is a flat issue/PR object;
    // a PR carries a nested `pull_request` field, an Issue does not. Re-wrap each
    // into the webhook shape the existing per-entity normalizers consume.
    const wrapped = (payload as { results?: Array<Record<string, unknown>> })?.results;
    if (Array.isArray(wrapped)) {
      const out: NormalizedRecord[] = [];
      for (const item of wrapped) {
        if (item?.pull_request) {
          out.push(this.normalizeSearchPullRequest(item));
        } else if (item?.id) {
          // Issue search items match the webhook issue shape closely enough.
          out.push(this.normalizeIssue({ issue: item } as unknown as GitHubWebhookPayload));
        }
      }
      return out;
    }

    const ghPayload = payload as GitHubWebhookPayload;
    const records: NormalizedRecord[] = [];

    if (ghPayload.pull_request) {
      records.push(this.normalizePullRequest(ghPayload));
    } else if (ghPayload.issue) {
      records.push(this.normalizeIssue(ghPayload));
    }

    if (ghPayload.comment) {
      records.push(this.normalizeComment(ghPayload));
    }

    if (ghPayload.review) {
      records.push(this.normalizeReview(ghPayload));
    }

    return records;
  }

  private normalizePullRequest(payload: GitHubWebhookPayload): NormalizedRecord {
    const pr = payload.pull_request!;
    const repo = payload.repository;

    return {
      entityType: 'PullRequest',
      externalId: String(pr.id),
      data: PullRequestDataSchema.parse({
        id: String(pr.id),
        number: pr.number,
        title: pr.title,
        body: pr.body,
        state: pr.state,
        action: payload.action,
        author: pr.user.login,
        authorId: pr.user.id,
        headRef: pr.head.ref,
        headSha: pr.head.sha,
        baseRef: pr.base.ref,
        baseSha: pr.base.sha,
        merged: pr.merged,
        mergeable: pr.mergeable,
        draft: pr.draft,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        assignees: pr.assignees?.map((a) => a.login),
        reviewers: pr.requested_reviewers?.map((r) => r.login),
        labels: pr.labels?.map((l) => l.name),
        repository: repo?.full_name,
        repositoryId: repo?.id,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        mergedAt: pr.merged_at,
        closedAt: pr.closed_at,
        triggeredBy: payload.sender?.login,
      }),
      metadata: {
        source: 'github',
        syncedAt: new Date(),
        version: pr.updated_at,
      },
    };
  }

  // Reactive search-poll PR item (lighter than a webhook PR: no head/base refs).
  private normalizeSearchPullRequest(item: Record<string, unknown>): NormalizedRecord {
    const user = (item.user ?? {}) as { login?: string; id?: number };
    const prLink = (item.pull_request ?? {}) as { merged_at?: string | null };
    const labels = Array.isArray(item.labels)
      ? (item.labels as Array<{ name?: string }>).map(l => l.name).filter((n): n is string => !!n)
      : undefined;
    return {
      entityType: 'PullRequest',
      externalId: String(item.id),
      data: PullRequestDataSchema.parse({
        id: String(item.id),
        number: item.number,
        title: item.title,
        body: item.body,
        state: item.state,
        author: user.login,
        authorId: user.id,
        merged: !!prLink.merged_at,
        draft: (item.draft as boolean) ?? false,
        assignees: Array.isArray(item.assignees)
          ? (item.assignees as Array<{ login?: string }>).map(a => a.login).filter((n): n is string => !!n)
          : undefined,
        labels,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        closedAt: item.closed_at,
        mergedAt: prLink.merged_at ?? undefined,
      }),
      metadata: {
        source: 'github',
        syncedAt: new Date(),
        version: item.updated_at as string,
      },
    };
  }

  private normalizeIssue(payload: GitHubWebhookPayload): NormalizedRecord {
    const issue = payload.issue!;
    const repo = payload.repository;

    return {
      entityType: 'Issue',
      externalId: String(issue.id),
      data: IssueDataSchema.parse({
        id: String(issue.id),
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        action: payload.action,
        author: issue.user.login,
        authorId: issue.user.id,
        assignees: issue.assignees?.map((a) => a.login),
        labels: issue.labels?.map((l) => l.name),
        milestone: issue.milestone?.title,
        milestoneNumber: issue.milestone?.number,
        repository: repo?.full_name,
        repositoryId: repo?.id,
        createdAt: issue.created_at,
        updatedAt: issue.updated_at,
        closedAt: issue.closed_at,
        triggeredBy: payload.sender?.login,
      }),
      metadata: {
        source: 'github',
        syncedAt: new Date(),
        version: issue.updated_at,
      },
    };
  }

  private normalizeComment(payload: GitHubWebhookPayload): NormalizedRecord {
    const comment = payload.comment!;
    const parentId = payload.pull_request?.id || payload.issue?.id;
    const parentType = payload.pull_request ? 'PullRequest' : 'Issue';

    return {
      entityType: 'Comment',
      externalId: String(comment.id),
      data: CommentDataSchema.parse({
        id: String(comment.id),
        body: comment.body,
        author: comment.user.login,
        authorId: comment.user.id,
        parentType,
        parentId,
        action: payload.action,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at,
        triggeredBy: payload.sender?.login,
      }),
      metadata: {
        source: 'github',
        syncedAt: new Date(),
        version: comment.updated_at,
      },
    };
  }

  private normalizeReview(payload: GitHubWebhookPayload): NormalizedRecord {
    const review = payload.review!;
    const prId = payload.pull_request?.id;

    return {
      entityType: 'Review',
      externalId: String(review.id),
      data: ReviewDataSchema.parse({
        id: String(review.id),
        state: review.state,
        body: review.body,
        author: review.user.login,
        authorId: review.user.id,
        pullRequestId: prId,
        action: payload.action,
        submittedAt: review.submitted_at,
        triggeredBy: payload.sender?.login,
      }),
      metadata: {
        source: 'github',
        syncedAt: new Date(),
        version: review.submitted_at,
      },
    };
  }

  extractEntityType(record: unknown): string {
    const r = record as GitHubWebhookPayload;
    if (r.pull_request) return 'PullRequest';
    if (r.issue) return 'Issue';
    if (r.comment) return 'Comment';
    if (r.review) return 'Review';
    return 'Unknown';
  }

  extractExternalId(record: unknown): string {
    const r = record as GitHubWebhookPayload;
    if (r.pull_request) return String(r.pull_request.id);
    if (r.issue) return String(r.issue.id);
    if (r.comment) return String(r.comment.id);
    if (r.review) return String(r.review.id);
    return '';
  }

  extractVersion(record: unknown): string | undefined {
    const r = record as GitHubWebhookPayload;
    if (r.pull_request) return r.pull_request.updated_at;
    if (r.issue) return r.issue.updated_at;
    if (r.comment) return r.comment.updated_at;
    if (r.review) return r.review.submitted_at;
    return undefined;
  }
}
