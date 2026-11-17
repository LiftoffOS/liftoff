// What can be recognised by shape is removed by shape, and the sentence
// still reads. These are realistic leaks, plus the shapes a model reaches
// for around an id.

import { scrubIdentifiers } from '../workforce-plans/identifier-scrub.js';

const ID = '122662dd-de4e-4b0d-8873-50cd6a00daaf';

describe('scrubIdentifiers', () => {
  it('takes the parenthetical an id sits in, and the space before it', () => {
    expect(scrubIdentifiers(`the paused "Support Triage" team (id ${ID}) with 48 tasks`))
      .toBe('the paused "Support Triage" team with 48 tasks');
    expect(scrubIdentifiers(`the team (${ID}) ran`)).toBe('the team ran');
    expect(scrubIdentifiers(`the team (id: \`${ID}\`) ran`)).toBe('the team ran');
  });

  it('takes the first item of a parenthetical list and keeps the rest', () => {
    expect(scrubIdentifiers(`"Support Triage" (id ${ID}, currently paused, 52 tasks) is the busiest`))
      .toBe('"Support Triage" (currently paused, 52 tasks) is the busiest');
  });

  it('takes an id from the middle or end of a list', () => {
    expect(scrubIdentifiers(`(paused, id ${ID}, 48 tasks)`)).toBe('(paused, 48 tasks)');
    expect(scrubIdentifiers(`(paused, 48 tasks, id ${ID})`)).toBe('(paused, 48 tasks)');
  });

  it('takes "with id X", "whose id is X", "id: X" and the words that hang them on', () => {
    expect(scrubIdentifiers(`The Support Triage team with id ${ID} (paused, 48 tasks) ran the most.`))
      .toBe('The Support Triage team (paused, 48 tasks) ran the most.');
    expect(scrubIdentifiers(`the team whose id is ${ID} ran`)).toBe('the team ran');
    expect(scrubIdentifiers(`Team: Support Triage. ID: ${ID}. Status: paused.`))
      .toBe('Team: Support Triage. Status: paused.');
    expect(scrubIdentifiers(`confirm you are targeting that id ${ID}.`)).toBe('confirm you are targeting that.');
  });

  it('takes a bare id, back-ticked or single-quoted, and leaves a JSON value\'s double quotes standing', () => {
    expect(scrubIdentifiers(`run ${ID} finished`)).toBe('run finished');
    expect(scrubIdentifiers(`run '${ID}' finished`)).toBe('run finished');
    expect(scrubIdentifiers(`run \`${ID}\` finished`)).toBe('run finished');
    expect(scrubIdentifiers(`run "${ID}" finished`)).toBe('run "" finished');
    expect(scrubIdentifiers(`ran ${ID.toUpperCase()}.`)).toBe('ran.');
    expect(scrubIdentifiers('a story... with an ellipsis')).toBe('a story... with an ellipsis');
  });

  it('takes the dash or colon a sentence hangs the id on, and leaves none dangling', () => {
    expect(scrubIdentifiers(`is "Support Triage" (41 tasks) \u2014 id ${ID}. Note there is a second team.`))
      .toBe('is "Support Triage" (41 tasks). Note there is a second team.');
    expect(scrubIdentifiers(`Team: Support Triage - ${ID}, paused.`)).toBe('Team: Support Triage, paused.');
    expect(scrubIdentifiers(`the busiest team: ${ID}`)).toBe('the busiest team');
    // A hyphen inside a word, and a dash between clauses, stay.
    expect(scrubIdentifiers('a well-known team \u2014 and a quiet one.')).toBe('a well-known team \u2014 and a quiet one.');
  });

  it('leaves the word "id" alone when no identifier follows it', () => {
    expect(scrubIdentifiers('Send me your Slack user id and the channel.')).toBe('Send me your Slack user id and the channel.');
  });

  it('takes a connector tool name outside code, and keeps a double-underscore token inside it', () => {
    expect(scrubIdentifiers('I checked with github__list_pull_requests and found three.'))
      .toBe('I checked with and found three.');
    expect(scrubIdentifiers('user__name in the Django lookup', { inCode: true }))
      .toBe('user__name in the Django lookup');
  });

  it("takes the turn's own tool names, whole, back-ticks included", () => {
    expect(scrubIdentifiers('Call `team_update` with the handle, then team_get again.', { toolNames: ['team_update', 'team_get'] }))
      .toBe('Call with the handle, then again.');
    // Not a prefix match: a tool name inside a longer word stays.
    expect(scrubIdentifiers('the team_updates table', { toolNames: ['team_update'] })).toBe('the team_updates table');
  });

  it('keeps JSON parseable', () => {
    const json = `{"team":"Support Triage","id":"${ID}","tasks":48}`;
    const out = scrubIdentifiers(json);
    expect(JSON.parse(out)).toEqual({ team: 'Support Triage', id: '', tasks: 48 });
  });

  it('returns text with nothing to scrub byte-identical', () => {
    const text = 'Twelve runs this week,  two  spaces kept , and (brackets) too.';
    expect(scrubIdentifiers(text)).toBe(text);
  });
});
