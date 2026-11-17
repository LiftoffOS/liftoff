// The fences an agent WITHOUT a graph is subject to.
//
// Seventeen of the distiller's checks sit behind a graph gate, and most belong
// there. These three do not: they are about what the agent owes the person
// waiting for it, and a conversational agent owes exactly the same things while
// being invisible to every graph check. Plenty of distillations bind no
// integrations and emit no graph, so without this the least-fenced agents
// would be an ordinary population rather than an edge case.
//
// Each fence is tested BOTH ways — that it fires, and that it stays quiet on
// correct output. A fence only tested for silence is a fence nobody has seen
// work.

import {
  findMissingProseReplyContract,
  findMissingProseDelivery,
  findUnsafeProseCopy,
} from '../prose-fences';

const CHAT = { type: 'chat' };
const CRON = { type: 'cron' };

describe('findMissingProseReplyContract', () => {
  it('fires when the prose describes only internal work', () => {
    // An agent can review a pull request, post a substantive review, and reply
    // nothing. If nothing anywhere says reporting back is part of the job,
    // nothing is missing when it does not happen.
    const p = findMissingProseReplyContract(
      { userInstructions: 'Read the diff. Check the tests. Decide if it is risky.' },
      CHAT,
      false,
    );
    expect(p).toHaveLength(1);
    expect(p[0].detail).toContain('says nothing');
  });

  it('accepts prose that says it replies', () => {
    expect(findMissingProseReplyContract(
      { userInstructions: 'Read the diff, then reply in the thread with what you found.' },
      CHAT, false,
    )).toEqual([]);
  });

  it('accepts a named deliverable as the contract', () => {
    // "Generate a report" states the output. A fence insisting on the word
    // "reply" would reject correct agents and teach the model to append it.
    expect(findMissingProseReplyContract(
      { userInstructions: 'Query Salesforce contacts. Generate a report.' },
      CHAT, false,
    )).toEqual([]);
  });

  it('says nothing when nobody is waiting', () => {
    // On a cron the action IS the outcome; demanding a reply would require a
    // message no one reads.
    expect(findMissingProseReplyContract(
      { userInstructions: 'Read the diff. Check the tests.' }, CRON, false,
    )).toEqual([]);
  });

  it('defers to the graph rule when there is a graph', () => {
    // The graph counterpart already ran and is sharper: it can name the step.
    expect(findMissingProseReplyContract(
      { userInstructions: 'Read the diff.' }, CHAT, true,
    )).toEqual([]);
  });
});

describe('findMissingProseDelivery', () => {
  const prose = { userInstructions: 'Summarise the week and produce a report.' };

  it('fires when the obligation exists and the tool is never named', () => {
    const p = findMissingProseDelivery(true, prose, false);
    expect(p).toHaveLength(1);
    expect(p[0].detail).toContain('open_chat_thread');
  });

  it('accepts prose that names the tool', () => {
    expect(findMissingProseDelivery(
      true, { userInstructions: 'Post the summary with open_chat_thread.' }, false,
    )).toEqual([]);
  });

  it('says nothing when the obligation does not apply', () => {
    expect(findMissingProseDelivery(false, prose, false)).toEqual([]);
  });

  it('defers to the graph rule when there is a graph', () => {
    expect(findMissingProseDelivery(true, prose, true)).toEqual([]);
  });
});

describe('findUnsafeProseCopy', () => {
  it('fires on a scripted message containing an em dash', () => {
    // Quoted copy is sent as authored. No model rewrites it at run time, which
    // is the whole reason the graph rule exists.
    const p = findUnsafeProseCopy(
      { userInstructions: 'Reply with "Thanks for reaching out — we have received your request."' },
      false,
    );
    expect(p).toHaveLength(1);
    expect(p[0].type).toBe('unsafe_prose_copy');
  });

  it('fires on a scripted message that calls the team a bot', () => {
    const p = findUnsafeProseCopy(
      { userInstructions: 'Open with "This is an automated response from our support bot system."' },
      false,
    );
    expect(p.length).toBeGreaterThan(0);
  });

  it('ignores an em dash in the INSTRUCTIONS themselves', () => {
    // The instructions are read by a model, not a customer. The voice rules
    // apply to what gets sent, not to how the agent was briefed.
    expect(findUnsafeProseCopy(
      { userInstructions: 'Be concise — never pad the answer.' }, false,
    )).toEqual([]);
  });

  it('ignores a short quotation naming a term of art', () => {
    // Quoting a field name is not scripting a sentence.
    expect(findUnsafeProseCopy(
      { userInstructions: 'Put it in the "subject" field.' }, false,
    )).toEqual([]);
  });

  it('defers to the graph rule when there is a graph', () => {
    expect(findUnsafeProseCopy(
      { userInstructions: 'Reply with "Thanks — we got it and will respond shortly."' }, true,
    )).toEqual([]);
  });

  it('handles empty prose without inventing a problem', () => {
    expect(findUnsafeProseCopy({}, false)).toEqual([]);
  });
});
