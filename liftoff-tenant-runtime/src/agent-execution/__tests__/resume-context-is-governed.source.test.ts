// A resumed run is governed as the first half was.
//
// Three rebuilds construct an ExecutionContext: executeTask, the wake-poll
// rebuild, and resumeWorkflow (a delay step, and the continuation of a run
// parked at its wall clock). The HITL gate reads `context.oversight` for the
// sensitive-work categories, and resumeWorkflow rebuilt its context without
// it — so a continuation dispatched an external publish the workspace asks to
// review, and no card was created. Pinned on the source: each rebuild reads
// the workspace's oversight, and none derives the level without it.

import { readFileSync } from 'fs';
import { join } from 'path';

const service = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');

function contextBuiltBy(methodSignature: string, endMarker: string): string {
  const start = service.indexOf(methodSignature);
  expect(start).toBeGreaterThan(-1);
  const end = service.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return service.slice(start, end);
}

describe('every ExecutionContext rebuild carries the workspace oversight', () => {
  it('resumeWorkflow reads oversight and derives the level from it', () => {
    const body = contextBuiltBy('  async resumeWorkflow(input: {', '// Fully constructed, and NOT cast.');
    expect(body).toContain('await hitlEnforcementService.getOversightSettings(input.tenantId)');
    expect(body).toContain('oversight: oversight || undefined,');
    expect(body).toContain("hitlEnforcementService.getDefaultHitlLevel(oversight?.autonomy || 'balanced')");
    expect(body).not.toContain('hitlLevel: runtimeConfig.hitlLevel ?? 3');
  });
});
