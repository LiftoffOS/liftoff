// The backfill's evidence must match the audit trail's real shape.
//
// `internal_agent_audit.changes` stores a create request as itself, and an
// update as `{ before, after }` where only `after` is the request; `before`
// is the row as it was and always carries a memoryScope. A query that looked
// for the key at the top level found it on no update row at all, so an
// explicitly restricted scope set through the API would still have read as
// "never set" and been replaced. This holds the query to the shape the
// service writes (service.ts logAudit('updated', { before, after })).

import { readFileSync } from 'fs';
import { join } from 'path';

const SCRIPT = readFileSync(join(__dirname, '..', 'backfill-template-memory-scope.ts'), 'utf8');
const SERVICE = readFileSync(join(__dirname, '..', '..', 'internal-agents', 'service.ts'), 'utf8');

describe('backfill-template-memory-scope eligibility', () => {
  it('reads a create audit at the top level and an update audit under after', () => {
    expect(SCRIPT).toContain("(au.action = 'created' AND au.changes ? 'memoryScope')");
    expect(SCRIPT).toContain("(au.action = 'updated' AND au.changes->'after' ? 'memoryScope')");
  });

  it('never reads before, which is the row and not the request', () => {
    expect(SCRIPT).not.toMatch(/changes->'before'/);
  });

  it('matches the shape the service actually writes for an update', () => {
    expect(SERVICE).toContain("'updated', { before: { ...current, workflowStepsHash: current.workflowStepsHash }, after: { ...input, workflowStepsHash: internalAgent.workflowStepsHash } }");
  });
});
