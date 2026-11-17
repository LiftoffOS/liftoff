// An integration must not need every optional field to survive distillation.
//
// formatIntegrationsWithTools guards `selectedObjects` with a comment saying
// integrations "reach this function over HTTP from another service, where the
// type guarantees nothing about the payload" — and then dereferenced `i.type`
// and `i.name` unguarded on the next three lines.
//
// Both can be absent in real payloads:
//   - a STORED agent row carries `integrationId`, never `type`
//   - /_svc/distill (the HRBP teambuilder path) validates the id and the type
//     and never requires a `name`
//
// Either one threw 'Cannot read properties of undefined (reading toLowerCase)'
// and failed the entire distillation, surfacing to the caller as a bare 500 —
// for example when /_svc/distill is called with {id, type, selectedObjects}.

import { __formatIntegrationsWithToolsForTest as format } from '../distill-service';

type Catalog = Map<string, { name: string; description: string }>;

const catalog: Catalog = new Map([
  ['github-7d07a896__get_pull_request', { name: 'github-7d07a896__get_pull_request', description: 'read a PR' }],
  ['slack-d77db9a0__send_message', { name: 'slack-d77db9a0__send_message', description: 'post a message' }],
]);

 
const call = (integrations: unknown[]) => format(integrations as any, catalog as any);

describe('formatIntegrationsWithTools tolerates partial integration shapes', () => {
  it('does not throw when `name` is absent (the /_svc/distill payload)', () => {
    expect(() =>
      call([{ id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'github', selectedObjects: [] }]),
    ).not.toThrow();
  });

  it('does not throw when `type` is absent (a stored agent row)', () => {
    expect(() =>
      call([{ id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', integrationId: 'github', selectedObjects: [] }]),
    ).not.toThrow();
  });

  it('still matches the right tools via integrationId alone', () => {
    const out = call([
      { id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', integrationId: 'github', selectedObjects: [] },
    ]);
    expect(out).toContain('github-7d07a896__get_pull_request');
    // Matching by type must not drag in a different connector's tools.
    expect(out).not.toContain('slack-d77db9a0__send_message');
  });

  it('an integration with neither type nor name claims NO tools', () => {
    // The trap this guard exists for: `x.includes('')` is true for every x, so
    // an empty type or name matched every prefix in the workspace and would
    // have handed the distiller the entire catalog under one heading — which
    // is how a workflow ends up authored against tools the agent cannot call.
    const out = call([{ id: '00000000-0000-0000-0000-000000000000', selectedObjects: [] }]);
    expect(out).not.toContain('github-7d07a896__get_pull_request');
    expect(out).not.toContain('slack-d77db9a0__send_message');
  });

  it('does not throw when selectedObjects is absent', () => {
    expect(() => call([{ id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270', type: 'github' }])).not.toThrow();
  });
});
