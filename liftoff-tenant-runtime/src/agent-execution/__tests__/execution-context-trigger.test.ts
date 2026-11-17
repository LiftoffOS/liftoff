// ExecutionContext.trigger must actually be populated.
//
// The field was declared on ExecutionContext and set by nothing, so
// `context.trigger` was undefined on EVERY run — event runs included. Two
// consumers already read it and both silently took the wrong branch:
//
//   1. WorkflowInputContract (service.ts) classified every run as manual/cron,
//      so `{{input.<field>}}` on an event run was never checked field by field
//      the way the code says it is.
//   2. A workflow step naming an operation instead of a host had no host to
//      resolve against, and refused.
//
// Only the second one made a noise, which is how this was finally found. The
// first had been quietly validating less than it claimed to.
//
// It was ALSO dropped at the Cloud Tasks boundary: the payload type carried
// `trigger`, the handler never passed it to executeTask, so a deferred run lost
// the untrusted_inbound marking on external-authored content. A deferred run is
// the same run and must not be less safe than the one that got the lock first.
//
// These assert the wiring by reading the source, because the alternative is
// standing up the whole execution service; a field that is declared, read by
// two consumers and assigned nowhere is exactly what a type checker cannot see.

import { readFileSync } from 'fs';
import { join } from 'path';

const SERVICE_SRC = readFileSync(join(__dirname, '..', 'service.ts'), 'utf8');
const HANDLER_SRC = readFileSync(
  join(__dirname, '..', '..', 'handlers', 'cloud-tasks-handler.ts'),
  'utf8',
);

describe('the trigger reaches the run that needs it', () => {
  it('the ExecutionContext literal assigns trigger', () => {
    // The literal that builds the context every run uses.
    const literal = SERVICE_SRC.slice(SERVICE_SRC.indexOf('const context: ExecutionContext = {'));
    const body = literal.slice(0, literal.indexOf('\n    };'));
    expect(body).toMatch(/^\s*trigger: input\.trigger,\s*$/m);
  });

  it('the Cloud Tasks handler forwards trigger to executeTask', () => {
    const call = HANDLER_SRC.slice(HANDLER_SRC.indexOf('executeTask({'));
    const body = call.slice(0, call.indexOf('});'));
    expect(body).toMatch(/trigger: payload\.trigger,/);
  });

  it('the enqueue path still puts trigger on the Cloud Task payload', () => {
    // Forwarding in the handler is worthless if the enqueue drops it.
    expect(SERVICE_SRC).toMatch(/trigger: input\.trigger, trustLevel: input\.trustLevel/);
  });

  it('both consumers still read it off the context', () => {
    // If either stops, this test should be revisited rather than deleted — the
    // point is that the field has readers, which is why it must have a writer.
    expect(SERVICE_SRC).toMatch(/state\.context\.trigger\?\.kind === 'connector_event'/);
    expect(SERVICE_SRC.match(/state\.context\.trigger/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
