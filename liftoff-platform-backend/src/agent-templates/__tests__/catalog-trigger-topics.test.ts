// A template's trigger topic must be one a connector actually publishes.
//
// `defaultTriggerConfig` is not decoration: the hire uses
// `distillResult.triggerConfig ?? template.defaultTriggerConfig`
// (TeamExplorePage, TeamBuilder), so whenever distillation returns no trigger
// the template's own is what the agent is created with. An invented topic there
// is an event subscription nothing will ever deliver, and the failure is silent:
// the team is hired, looks healthy, and never runs.
//
// 18 templates carried one. Thirteen document analysts and a CP associate
// triggered on `document.uploaded`, which no connector publishes — cloud storage
// publishes `file.created` / `file.updated`, and the documents family publishes
// `document.created` / `document.updated`. Four more carried a vendor prefix
// nobody emits: `hris.employee.created` for `employee.created`,
// `sentry.issue.created` for `issue.created`, `greenhouse.application.created`
// for `candidate.created`, and `docusign.envelope.received` for `document.sent`.

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const CATALOG_DIR = path.join(__dirname, '..', 'catalog');
const CONNECTORS_TS = path.join(
  __dirname, '..', '..', '..', '..', 'liftoff-connector-service', 'src', 'catalog', 'connectors.ts',
);

/** Every topic the connector catalog declares on a polling row. Read from the
 *  connector-service source rather than a copy, so the two cannot drift. */
function publishedTopics(): Set<string> {
  const src = fs.readFileSync(CONNECTORS_TS, 'utf-8');
  const topics = new Set<string>();
  for (const block of src.match(/eventTopics:\s*\[[^\]]*\]/g) ?? []) {
    for (const quoted of block.match(/'[a-z_.]+'/g) ?? []) topics.add(quoted.replace(/'/g, ''));
  }
  return topics;
}

/** One row per declared topic, primary and secondary alike: `eventTopics` builds
 *  the per-binding filter, so an unpublished topic in there is as dead as one in
 *  `eventTopic`. */
function templateTriggers(): Array<{ filename: string; topic: string }> {
  return fs.readdirSync(CATALOG_DIR)
    .filter(f => f.endsWith('.yaml'))
    .flatMap(f => {
      const t = yaml.load(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf-8')) as {
        defaultTriggerConfig?: { eventTopic?: string; eventTopics?: string[] };
      };
      const declared = new Set(
        [t.defaultTriggerConfig?.eventTopic, ...(t.defaultTriggerConfig?.eventTopics ?? [])]
          .filter((x): x is string => Boolean(x)),
      );
      return [...declared].map(topic => ({ filename: f, topic }));
    });
}

// Skipped when the sibling checkout is absent (CI clones one repo), because a
// missing file is not evidence of a bad catalog.
const connectorCatalogPresent = fs.existsSync(CONNECTORS_TS);
const describeIfPresent = connectorCatalogPresent ? describe : describe.skip;

describeIfPresent('catalog trigger topics are deliverable', () => {
  const published = connectorCatalogPresent ? publishedTopics() : new Set<string>();

  it('reads a non-trivial set of topics from the connector catalog', () => {
    // Guards the parse itself: an empty set would make every assertion below
    // pass for the wrong reason.
    expect(published.size).toBeGreaterThan(20);
    expect(published.has('file.created')).toBe(true);
  });

  it.each(templateTriggers())('$filename triggers on a published topic ($topic)', ({ topic }) => {
    expect([...published]).toContain(topic);
  });
});
