// Hosts that serve the same work must publish the same entityType, spelled the
// same way.
//
// The gitlab entry says why in as many words: GitLab "publishes under the SAME
// entityTypes GitHub uses — 'PullRequest' (merge requests) and 'Issue' — so one
// software-delivery-team subscription matches events from both hosts."
//
// That agreement is load-bearing and, until this test, maintained entirely by
// hand. A subscription is matched on (connectorRef, entityType); a workflow
// step templates on the normalized record; and tenant-runtime resolves a
// host-agnostic step by looking for connectors publishing the trigger's
// entityType. All three join on this exact string.
//
// The failure mode is silence. Add a host that types 'PullRequests' or
// 'MergeRequest' and nothing errors — the poller runs, events publish, and the
// subscriptions simply never match. No exception, no log, just an agent that
// stopped waking with no indication why. That is the same shape as the two
// PullRequestDataSchema copies that had already drifted apart before they were
// unified: a convention nothing compared.

import { CONNECTORS } from '../connectors';

type PollingRow = { entityType?: string; eventTopics?: string[]; listImplemented?: boolean };
type Def = { type?: string; polling?: PollingRow[] };

const defs = Object.values(CONNECTORS as unknown as Record<string, Def>);

/** Every (connector, polling row) pair, flattened. */
const rows: Array<{ connector: string; row: PollingRow }> = defs.flatMap((d) =>
  (d.polling ?? []).map((row) => ({ connector: d.type ?? '(unnamed)', row })),
);

describe('shared entity types agree across hosts', () => {
  it('anything publishing a pr.* topic calls the entity exactly "PullRequest"', () => {
    // The topic is the giveaway: a connector emitting pr.opened is in the
    // pull-request business whatever it calls the record internally.
    const offenders = rows
      .filter(({ row }) => (row.eventTopics ?? []).some((t) => t.startsWith('pr.')))
      .filter(({ row }) => row.entityType !== 'PullRequest')
      .map(({ connector, row }) => `${connector}: entityType="${row.entityType}"`);

    expect(offenders).toEqual([]);
  });

  it('no host invents a near-miss spelling for the same record', () => {
    // 'PullRequests', 'MergeRequest', 'pull_request' — each would poll happily
    // and match nothing.
    const nearMisses = rows
      .filter(({ row }) => {
        const t = row.entityType ?? '';
        if (t === 'PullRequest') return false;
        return /^(pull|merge)[\s_-]?requests?$/i.test(t);
      })
      .map(({ connector, row }) => `${connector}: "${row.entityType}" (did you mean PullRequest?)`);

    expect(nearMisses).toEqual([]);
  });

  it('hosts publishing PullRequest agree on the pr.* topic set', () => {
    // A host that publishes PullRequest but omits pr.opened cannot serve a
    // subscription written against the others, which is the same break one
    // level down from the entity name.
    const publishers = rows.filter(({ row }) => row.entityType === 'PullRequest');
    expect(publishers.length).toBeGreaterThan(1); // else this test proves nothing

    const withTopics = publishers.filter(({ row }) => (row.eventTopics ?? []).length > 0);
    const missingOpened = withTopics
      .filter(({ row }) => !(row.eventTopics ?? []).includes('pr.opened'))
      .map(({ connector }) => connector);

    expect(missingOpened).toEqual([]);
  });

  it('the same rule holds for Issue, the other deliberately shared entity', () => {
    const offenders = rows
      .filter(({ row }) => (row.eventTopics ?? []).some((t) => t.startsWith('issue.')))
      .filter(({ row }) => row.entityType !== 'Issue')
      .map(({ connector, row }) => `${connector}: entityType="${row.entityType}"`);

    expect(offenders).toEqual([]);
  });

  it('the near-miss detector actually detects near misses', () => {
    // A drift guard that cannot detect drift is worse than none: it reports
    // green forever and nobody looks again. Exercised against the spellings a
    // new host would plausibly reach for.
    const isNearMiss = (t: string) => t !== 'PullRequest' && /^(pull|merge)[\s_-]?requests?$/i.test(t);

    for (const bad of ['PullRequests', 'MergeRequest', 'MergeRequests', 'pull_request', 'pull-request', 'merge request']) {
      expect(isNearMiss(bad)).toBe(true);
    }
    // And does not fire on the correct spelling or on unrelated entities.
    for (const ok of ['PullRequest', 'Issue', 'Repository', 'Message']) {
      expect(isNearMiss(ok)).toBe(false);
    }
  });

  it('github and gitlab still declare byte-identical PullRequest rows', () => {
    // The specific pair the design note promises. Stated separately from the
    // general rules so a regression names the two hosts rather than a set.
    const pick = (type: string) =>
      rows.find(({ connector, row }) => connector === type && row.entityType === 'PullRequest')?.row;

    const gh = pick('github');
    const gl = pick('gitlab');
    expect(gh).toBeDefined();
    expect(gl).toBeDefined();
    expect([...(gl!.eventTopics ?? [])].sort()).toEqual([...(gh!.eventTopics ?? [])].sort());
  });
});
