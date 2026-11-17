// A safety category added after a tenant's row was written must not read as off.
//
// parseSensitiveWork used to cast the column straight through — `return raw as
// SensitiveWorkConfig`. The type promises six booleans; the column holds
// whatever was written the day the row was created. The cast asserted the
// difference away, so every category added later read back `undefined`, which is
// falsy, which is OFF, silently, for every pre-existing tenant.
//
// mergeToMain shows the cost. A row written before it existed has five
// categories on and no mergeToMain key at all, so the control governing merges
// to a default branch reads as off while /dashboard/oversight implies it is
// configurable. Nobody turned it off; it was never on. Merging to a default
// branch is not something the agent that did it can undo.
//
// The fix is the class, not the key: a missing category takes the default, so
// the NEXT one added lands enabled for existing tenants too.
import { OversightService } from '../service';
import { DEFAULT_SENSITIVE_WORK } from '../types';

/** parseSensitiveWork is private and has no dependencies; reach it directly
 *  rather than standing up a service with a database behind it. */
const parse = (raw: unknown) =>
  (OversightService.prototype as unknown as {
    parseSensitiveWork: (r: unknown) => Record<string, boolean>;
  }).parseSensitiveWork.call({}, raw);

describe('parseSensitiveWork', () => {
  it('fills a category the stored row predates', () => {
    // Exactly the Liftoff row: the original five, no mergeToMain.
    const stored = {
      customerCommunication: true,
      financialActions: true,
      dataChanges: true,
      externalPublishing: true,
      hiringDecisions: true,
    };
    expect(parse(stored).mergeToMain).toBe(true);
  });

  it('never returns undefined for any declared category', () => {
    // The property the old cast pretended to have. undefined is falsy, so an
    // absent key is not a gap in the data — it is a control that is off.
    const parsed = parse({ dataChanges: true });
    for (const key of Object.keys(DEFAULT_SENSITIVE_WORK)) {
      expect(typeof parsed[key]).toBe('boolean');
    }
  });

  it('does not overturn a category the tenant switched off', () => {
    // An explicit false is a decision. Defaults fill gaps; they do not win
    // arguments.
    expect(parse({ mergeToMain: false }).mergeToMain).toBe(false);
    expect(parse({ customerCommunication: false }).customerCommunication).toBe(false);
  });

  it('applies the same filling to a JSON string column', () => {
    const parsed = parse(JSON.stringify({ dataChanges: true }));
    expect(parsed.mergeToMain).toBe(true);
    expect(parsed.dataChanges).toBe(true);
  });

  it('falls back to the defaults on null or unparseable JSON', () => {
    expect(parse(null)).toEqual(DEFAULT_SENSITIVE_WORK);
    expect(parse('{not json')).toEqual(DEFAULT_SENSITIVE_WORK);
  });

  it('defaults mergeToMain ON', () => {
    // Stated as its own assertion: this is a deliberate change of default, and
    // a future edit flipping it back should have to delete a test that says why.
    expect(DEFAULT_SENSITIVE_WORK.mergeToMain).toBe(true);
  });
});
