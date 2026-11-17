// The fences that apply to an agent WITHOUT a graph.
//
// Seventeen of the distiller's ~20 checks sit behind `if (workflowSteps.length
// > 0)`, and most belong there — a check about step ordering has nothing to say
// about an agent that has no steps. But three of them are not really about
// graphs at all. They are about obligations the agent has to the person waiting
// for it, and a conversational agent has exactly the same obligations while
// being invisible to every one of those checks.
//
// That asymmetry is not a small gap. Roughly a third of production
// distillations run with no bound integrations and emit no graph, so the agents
// least covered by the distiller's fences are a large and ordinary population,
// not an edge case.
//
// Each check here is the prose counterpart of a graph check, and each answers
// the same question in the place the answer can live when there are no steps:
//
//   findMissingReplyContract        -> does the agent say it will reply?
//   findMissingDeliveryStep         -> does it say how it reaches a person?
//   findUnsafeCustomerFacingCopy    -> is the copy it was HANDED safe to send?
//
// The third is the one worth reading twice. In a graph, unsafe copy is a
// literal `toolArgs.body` the runtime dispatches verbatim. In prose there is no
// such field — but authored prose routinely contains a TEMPLATE, quoted, that
// the agent is told to send. That quoted text is dispatched just as literally,
// and it is invisible to the graph check because there is no step to attach it
// to.

/** What the distiller's other fences return. Structural match, not an import,
 *  so this module stays free of the 8,000-line service it reports into. */
export interface ProseFenceProblem {
  type: string;
  stepId: string;
  detail: string;
}

/** The prose the model authored, as the fences see it. */
export interface ProseFields {
  systemPrompt?: string | null;
  userInstructions?: string | null;
  instructionsMd?: string | null;
}

function allProse(fields: ProseFields): string {
  return [fields.systemPrompt, fields.userInstructions, fields.instructionsMd]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n\n');
}

/**
 * A conversational agent that never says it will answer.
 *
 * The graph version asks whether a terminal step declares what it produced.
 * With no graph the equivalent question is whether the INSTRUCTIONS ever tell
 * the agent to reply to the person who asked — and an agent whose instructions
 * describe only the work will do the work and say nothing.
 *
 * For example, an agent can review a pull request, post a substantive review,
 * and reply nothing; the thread shows the person their own message and
 * silence. Every layer below the prompt is working. Nothing anywhere says that
 * reporting back is part of the job, so nothing is missing when it does not
 * happen.
 *
 * Only when someone is waiting. On a cron or an event the action IS the
 * outcome and there is no one in the thread to answer, so requiring a reply
 * would demand a message nobody reads.
 */
export function findMissingProseReplyContract(
  fields: ProseFields,
  triggerConfig: { type?: string } | undefined,
  hasGraph: boolean,
): ProseFenceProblem[] {
  if (hasGraph) return [];
  if (!readerIsWaiting(triggerConfig)) return [];

  const prose = allProse(fields).toLowerCase();
  if (prose.length === 0) return [];
  // What is required is that the agent's OUTPUT is stated — not that a
  // particular verb appears. The graph rule asks whether a terminal step
  // declares what it produced; the prose equivalent is whether the instructions
  // name a deliverable or an act of telling someone at all.
  //
  // Both halves are accepted deliberately. "Reply in the thread" states it, and
  // so does "generate a report": a named artifact handed back IS the answer,
  // and a fence that insisted on the word "reply" would reject correct agents
  // and teach the model to append the word rather than to finish the job.
  //
  // What it still catches is prose describing only internal work — read this,
  // check that, decide the other — with nothing at the end that reaches the
  // person waiting.
  const statesAnOutput =
    /\b(repl(y|ies|ying)|respond(s|ing)?|answer(s|ing)?|report back|let (them|the \w+) know|notify|tell (the|them))\b/.test(prose)
    || /\b(produce|generate|write|compose|draft|deliver|return|post|send|share|publish|summari[sz]e)\b[^.]{0,60}\b(report|summary|brief|draft|answer|response|message|output|result|recommendation|analysis|memo|note)\b/.test(prose);
  if (statesAnOutput) return [];

  return [{
    type: 'missing_prose_reply_contract',
    stepId: 'userInstructions',
    detail:
      'This agent is triggered by a person in a conversation and its instructions never say '
      + 'it answers them. An agent told only how to do the work does the work and says nothing: '
      + 'the person sees their own message and silence, which reads as broken rather than busy. '
      + 'State plainly, in userInstructions or instructionsMd, that the agent replies in the '
      + 'thread with what it found or did. This is not a formatting rule — it is the difference '
      + 'between finishing the job and finishing half of it.',
  }];
}

/**
 * The obligation to reach a person, when the prose is all there is.
 *
 * Same obligation `findMissingDeliveryStep` enforces on a graph: the team has
 * no team-chat or email connector bound, its responsibilities say to reach
 * someone, and `open_chat_thread` is the only way left to do it. With no graph
 * there is no step to require, so what has to be true is that the instructions
 * NAME the tool — a model that has never been told the tool exists does not
 * discover it mid-run.
 */
export function findMissingProseDelivery(
  required: boolean,
  fields: ProseFields,
  hasGraph: boolean,
): ProseFenceProblem[] {
  if (hasGraph || !required) return [];
  const prose = allProse(fields);
  if (prose.length === 0) return [];
  if (prose.includes('open_chat_thread')) return [];

  return [{
    type: 'missing_prose_delivery',
    stepId: 'userInstructions',
    detail:
      'This team has no team-chat or email connector bound and its responsibilities say to reach '
      + 'a person, but the instructions never name `open_chat_thread` — the only way it has left. '
      + 'Name the tool in userInstructions and say what to put in its title and body. Do not '
      + 'substitute an escalation: that ends the run and records it as work that got stuck, which '
      + 'is a different outcome from telling someone what happened.',
  }];
}

/**
 * Authored copy inside the prose that a customer will read verbatim.
 *
 * The graph check reads `toolArgs.body`. There is no such field here, but
 * authored prose routinely embeds a quoted template the agent is told to send,
 * and that text reaches the customer exactly as written — no model rewrites it
 * at run time, which is the whole reason the graph rule exists.
 *
 * Only QUOTED runs of prose are examined. The instructions themselves are read
 * by a model, not by a customer, so an em dash in an instruction is
 * unremarkable; an em dash inside the sentence the agent was told to send is
 * the workspace voice rules being broken in the one place they apply.
 */
export function findUnsafeProseCopy(
  fields: ProseFields,
  hasGraph: boolean,
): ProseFenceProblem[] {
  if (hasGraph) return [];
  const out: ProseFenceProblem[] = [];
  const prose = allProse(fields);
  if (prose.length === 0) return out;

  // Quoted runs long enough to be a message rather than a term of art. A short
  // quotation is naming something ("the `subject` field"), not scripting a
  // sentence.
  const quoted = [...prose.matchAll(/["“]([^"”]{25,400})["”]/g)].map((m) => m[1]);
  for (const text of quoted) {
    if (text.includes('—')) {
      out.push({
        type: 'unsafe_prose_copy',
        stepId: 'userInstructions',
        detail:
          `The instructions script a message containing an em dash: "${text.slice(0, 80)}...". `
          + 'Quoted copy is sent as authored — no model rewrites it at run time — so the workspace '
          + 'voice rules apply to it exactly as they apply to a graph\'s message body. Rewrite the '
          + 'sentence with a full stop, a comma, or a colon.',
      });
    }
    if (/\bAI agent\b|\bthe agent\b|\bautomated\b|\bAI-generated\b|\bbot\b/i.test(text)) {
      out.push({
        type: 'unsafe_prose_copy',
        stepId: 'userInstructions',
        detail:
          `The instructions script a message that calls the team an agent, a bot, or automated: `
          + `"${text.slice(0, 80)}...". The product never refers to itself that way in front of a `
          + 'customer. Rewrite it in the first person, or name the team.',
      });
    }
  }
  return out;
}

/** Whether a person is waiting on this run. Mirrors the graph rule's own
 *  reading of the trigger, so the two cannot drift on what "someone is
 *  waiting" means. */
function readerIsWaiting(triggerConfig: { type?: string } | undefined): boolean {
  const type = (triggerConfig?.type ?? '').toLowerCase();
  return type === 'chat' || type === 'manual' || type === '' || type === 'conversational';
}
