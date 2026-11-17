// The PullRequest record, once, for every host that publishes one.
//
// GitHub, GitLab and Bitbucket all publish entityType 'PullRequest' on the same
// topics, deliberately — see the note on the gitlab entry in
// catalog/connectors.ts: GitLab "publishes under the SAME entityTypes GitHub
// uses ... so one software-delivery-team subscription matches events from both
// hosts". Everything downstream leans on that: a subscription predicate filters
// on these field names, and a workflow step templates on them.
//
// It was two independent copies (github.ts and gitlab.ts each declared their
// own `PullRequestDataSchema`), and they had already drifted — GitHub's carried
// action, baseSha, mergeable, additions, deletions, changedFiles and
// triggeredBy; GitLab's carried none of them. Nothing failed, because nothing
// compared them: "one shape across hosts" was a convention maintained by hand,
// on exactly the contract that must not be per-host.
//
// A predicate written against a field one host stops publishing does not error.
// It stops matching, and a subscription that silently stops firing is the
// hardest kind of break to notice.
//
// Every host-specific field is optional, so a host that does not populate one
// parses cleanly. Field SEMANTICS that differ per host are documented here
// rather than in each normalizer, because the consumer reading `number` or
// `repository` is the one who needs to know.

import { z } from 'zod';

export const PullRequestDataSchema = z.object({
  id: z.string().describe('Host pull-request / merge-request id (string form of the numeric id).'),
  number: z
    .number()
    .describe('Per-repository number: GitHub PR number, GitLab merge-request IID. NOT globally unique — an IID of 1 exists in every GitLab project, so it is only meaningful alongside the repository.'),
  title: z.string(),
  body: z.string().optional(),
  state: z.string().describe('Host vocabulary: GitHub open | closed; GitLab opened | closed | merged | locked.'),
  author: z.string(),
  authorId: z.number(),

  headRef: z.string().optional().describe('Source branch. Webhook payloads carry it; reactive search-poll items may not, so it is optional and not predicate-critical.'),
  headSha: z.string().optional(),
  baseRef: z.string().optional().describe('Target branch.'),

  merged: z.boolean(),
  draft: z.boolean(),

  assignees: z.array(z.string()).optional(),
  reviewers: z.array(z.string()).optional(),
  labels: z.array(z.string()).optional(),

  repository: z
    .string()
    .optional()
    .describe('Human-facing repository identity. GitLab publishes the project WEB URL here, not a path or id — do not pass it to an API expecting a project identifier; use repositoryId.'),
  repositoryId: z.number().optional().describe('Host-native numeric repository id (GitLab project id).'),

  createdAt: z.string(),
  updatedAt: z.string(),
  mergedAt: z.string().optional(),
  closedAt: z
    .string()
    .optional()
    .describe('Close timestamp — anchor for "X days since merged" patterns.'),

  // ── Host-specific, all optional ──────────────────────────────────────
  // Published by some hosts and not others. Optional so a host that omits one
  // still parses, and declared HERE so a predicate author can see which fields
  // are not guaranteed across hosts.
  action: z.string().optional().describe('GitHub webhook action (opened, synchronize, ...). Absent on GitLab.'),
  baseSha: z.string().optional().describe('Absent on GitLab.'),
  mergeable: z.boolean().optional().describe('Absent on GitLab.'),
  additions: z.number().optional().describe('Absent on GitLab.'),
  deletions: z.number().optional().describe('Absent on GitLab.'),
  changedFiles: z.number().optional().describe('Absent on GitLab.'),
  triggeredBy: z.string().optional().describe('Absent on GitLab.'),
});

export type PullRequestData = z.infer<typeof PullRequestDataSchema>;
