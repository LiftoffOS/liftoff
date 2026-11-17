/**
 * Which route answered, and whether the other was considered.
 *
 * The catalog and the provider's own web search sit side by side in the tool
 * list and nothing ranks across them: the model picks by reading their
 * descriptions. So the only way to learn how often a capability that could
 * have served is passed over is to record it per turn and count later.
 *
 * `servedNamesIn` is the cheap half of that — a keyword match against the
 * same list the scrubber hides from the model, so the two cannot drift. It
 * says a question MENTIONED something served here. It does not say a
 * capability would have answered it well, and the audit field is named
 * `catalogSkipped` rather than anything that reads as a defect for exactly
 * that reason: on the Palo Alto query that prompted this, the open web gave
 * the better answer.
 */

import { servedNamesIn } from '../capability-tools';

describe('servedNamesIn', () => {
  it('finds a served site named in a question', () => {
    expect(servedNamesIn('find homes for sale in Palo Alto on Zillow')).toContain('zillow');
  });

  it('finds several, de-duplicated, whatever the casing', () => {
    const found = servedNamesIn('Compare CARFAX and Carfax against Edmunds for this VIN');
    expect(found).toContain('carfax');
    expect(found).toContain('edmunds');
    expect(found.filter((n) => n === 'carfax')).toHaveLength(1);
  });

  it('says nothing about a question that names nothing served', () => {
    expect(servedNamesIn('what did we decide about the pricing model last week')).toEqual([]);
  });

  it('matches whole words only, so a longer word is not a mention', () => {
    // "apify" inside another token is not somebody asking for it.
    expect(servedNamesIn('the rapifying of the process')).toEqual([]);
  });

  it('does not match a name that merely resembles a served one', () => {
    expect(servedNamesIn('we should ask the hunters about it')).toEqual([]);
  });
});
