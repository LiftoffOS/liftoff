// Every caller of externalAgentService.rediscover hands it the effect classes
// and classification versions the discovery returned. The cache upsert writes
// what it is handed, so a caller that built its own body without them nulled
// the class every tool already had on each rediscovery: the manual route and
// the health sweep both did, while the workspace action did not.

import { readFileSync } from 'fs';
import { join } from 'path';

const CALLERS = [
  'src/external-agents/rediscover-stream-router.ts',
  'src/external-agents/health-check-service.ts',
  'src/workspace-actions/collaborator.ts',
];

describe('externalAgentService.rediscover callers', () => {
  it.each(CALLERS)('%s forwards toolEffectClasses and toolClassificationVersions on every call', (file) => {
    const src = readFileSync(join(__dirname, '..', '..', '..', file), 'utf8');
    const calls = src.split('externalAgentService.rediscover(').slice(1);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      // The body is the object literal up to the options argument or the close.
      const body = call.slice(0, call.indexOf('rawMcpTools:'));
      expect(body).toContain('toolEffectClasses:');
      expect(body).toContain('toolClassificationVersions:');
    }
  });
});
