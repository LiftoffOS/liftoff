// team__propose_update Tool
//
// Change an EXISTING team by editing its prose — the same two source fields
// the settings page edits. The platform rebuilds the team from the new prose
// BEFORE it saves anything, the way the settings page's Save does, so the
// schedule, prompts and workflows are re-derived together and cannot drift
// apart, and a rebuild that fails changes nothing. Nothing here writes a
// trigger, a prompt or a workflow: prose in, distillation derives, always.
//
// The change is applied as EDITS to the stored prose — the before/after the
// model showed the person — each landing exactly once, or refused. A full
// replacement is accepted only to rewrite a field. Both fields used to be
// full-replacement only, with the model asked to carry everything it did not
// change verbatim; one copy stopped a third of the way from the end, mid-word,
// and the team lost its last workflow step and its outcomes while the reply
// said everything else was untouched. A person confirms a before and an
// after; that is what gets applied.
//
// Kept for one release as a thin call to the workspace actions: the stored
// prose is read through `team_get`, the edited text goes to `team_update`
// (platform-backend's preview → confirm tool), and the call is relayed as it
// is: without a confirmationId the result is the preview and the handle,
// with one it is the applied change. The person's confirmation stays what it
// always was here, a "yes" in this conversation; the handle is what carries
// it to the platform. ESM .js imports.

import { getRegisteredWorkforcePlanTool } from './dispatcher.js';
import type { WorkforcePlanTool, WorkforcePlanToolContext } from './types.js';
import { refuseExecutionMechanics } from '../prose-for-the-person.js';

type UpdateOutput =
  | { ok: true; distilled: true; message: string }
  | { ok: true; preview: unknown; confirmationId: string; message: string }
  | { ok: false; error: string };

type ProseField = 'responsibilities' | 'additionalContext';

interface ProseEdit {
  field: ProseField;
  current: string;
  replacement: string;
}

/** Apply the edits to the stored text of one field. Each `current` must occur
 *  exactly once: absent, the edit was written against text the team does not
 *  carry; more than once, it is ambiguous. Either is refused with the field
 *  and the text named, so the model can look again rather than guess. */
function applyProseEdits(
  stored: string,
  edits: ReadonlyArray<Pick<ProseEdit, 'current' | 'replacement'>>,
  field: ProseField,
): { text: string } | { error: string } {
  let text = stored;
  for (const edit of edits) {
    const first = text.indexOf(edit.current);
    if (first === -1) {
      return {
        error:
          `The ${field} text does not contain the current text of one edit: "${clip(edit.current)}". `
          + 'Read team__get_config again and quote the current text exactly as stored.',
      };
    }
    if (text.indexOf(edit.current, first + 1) !== -1) {
      return {
        error:
          `The current text of one edit occurs more than once in ${field}: "${clip(edit.current)}". `
          + 'Quote enough surrounding text to make it unique.',
      };
    }
    text = text.slice(0, first) + edit.replacement + text.slice(first + edit.current.length);
  }
  return { text };
}

function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 80 ? oneLine : `${oneLine.slice(0, 80)}…`;
}

function readEdits(raw: unknown): ProseEdit[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return { error: 'edits must be a list.' };
  const edits: ProseEdit[] = [];
  for (const item of raw) {
    const e = item as Record<string, unknown>;
    const field = e?.field;
    if (field !== 'responsibilities' && field !== 'additionalContext') {
      return { error: 'Each edit names its field: responsibilities or additionalContext.' };
    }
    if (typeof e.current !== 'string' || e.current.length === 0 || typeof e.replacement !== 'string') {
      return { error: 'Each edit carries the current text (non-empty) and the replacement text.' };
    }
    edits.push({ field, current: e.current, replacement: e.replacement });
  }
  return edits;
}

/** The stored prose the edits apply to, read through the same workspace
 *  action team__get_config uses. */
async function readStoredProse(
  internalAgentId: string,
  ctx: WorkforcePlanToolContext,
): Promise<{ responsibilities: string | null; additionalContext: string | null } | { error: string }> {
  const teamGet = getRegisteredWorkforcePlanTool('team_get');
  if (!teamGet) {
    return { error: "The agent's current text could not be read just now: the workspace could not be reached. Try again in a moment." };
  }
  const result = (await teamGet.execute({ teamId: internalAgentId }, ctx)) as Record<string, unknown>;
  if (result.refused === true || typeof result.id !== 'string') {
    return { error: 'No agent with that id exists in this workspace.' };
  }
  return {
    responsibilities: typeof result.responsibilities === 'string' ? result.responsibilities : null,
    additionalContext: typeof result.additionalContext === 'string' ? result.additionalContext : null,
  };
}

export const teamProposeUpdateTool: WorkforcePlanTool = {
  definition: {
    name: 'team__propose_update',
    description:
      'Update an existing agent by editing its plain-language configuration source: '
      + 'responsibilities and/or additional context. Use it for any change to what an agent '
      + 'does or when it runs, including schedule changes, which you express in words inside '
      + 'the prose ("Runs every Tuesday at 9am") and never as a cron expression. MANDATORY '
      + 'sequence: call team__get_config first, then send the change as `edits`: each is the '
      + 'current text exactly as stored and its replacement; the platform applies each to '
      + 'the stored prose exactly once and refuses an edit whose current text is not found '
      + 'exactly once, so everything else stays as it is. Use a full replacement field only '
      + 'to rewrite a whole field. Called without confirmationId it returns a preview of the '
      + 'exact before and after and a confirmationId; show the user the preview, and only '
      + 'when they confirm in this conversation call it again with the same edits plus the '
      + 'confirmationId. The platform rebuilds the agent from the new prose before saving, so '
      + 'the reply carries the result: tell the user the agent is updated, or that nothing '
      + 'changed when the rebuild did not go through.',
    input_schema: {
      type: 'object',
      properties: {
        internalAgentId: {
          type: 'string',
          description: 'The agent\'s id, from org__get_existing_structure.',
        },
        edits: {
          type: 'array',
          description:
            'The changes, as the before/after you showed the user. Preferred over a full '
            + 'replacement: nothing outside the quoted text changes.',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string', enum: ['responsibilities', 'additionalContext'] },
              current: { type: 'string', description: 'The current text, exactly as team__get_config returned it. Must occur exactly once in the field.' },
              replacement: { type: 'string', description: 'The new text that replaces it.' },
            },
            required: ['field', 'current', 'replacement'],
          },
        },
        responsibilities: {
          type: 'string',
          description:
            'Full replacement responsibilities text, only when rewriting the whole field. '
            + 'Omit otherwise.',
        },
        additionalContext: {
          type: 'string',
          description:
            'Full replacement additional context text, only when rewriting the whole field. '
            + 'Omit otherwise. Both fields are what the person reads and edits on the '
            + 'agent\'s page: written in the person\'s terms, never naming a tool, a browser or '
            + 'session, or how a site is reached. An edit that names a mechanic is refused '
            + 'with the phrase to rewrite.',
        },
        confirmationId: {
          type: 'string',
          description: 'The handle the preview returned; send it, with the same edits, once the user has confirmed.',
        },
      },
      required: ['internalAgentId'],
    },
  },

  async execute(
    rawInput: Record<string, unknown>,
    ctx: WorkforcePlanToolContext,
  ): Promise<UpdateOutput> {
    const internalAgentId = String(rawInput.internalAgentId ?? '');
    let responsibilities =
      typeof rawInput.responsibilities === 'string' ? rawInput.responsibilities : undefined;
    let additionalContext =
      typeof rawInput.additionalContext === 'string' ? rawInput.additionalContext : undefined;
    const confirmationId =
      typeof rawInput.confirmationId === 'string' && rawInput.confirmationId ? rawInput.confirmationId : undefined;

    const edits = readEdits(rawInput.edits);
    if (!Array.isArray(edits)) return { ok: false, error: edits.error };

    if (edits.length === 0 && responsibilities === undefined && additionalContext === undefined) {
      return { ok: false, error: 'Provide edits, or responsibilities and/or additionalContext.' };
    }

    // Edits land on the stored text, read now rather than carried by the
    // model, so what changes is exactly the quoted text and nothing else.
    if (edits.length > 0) {
      const stored = await readStoredProse(internalAgentId, ctx);
      if ('error' in stored) return { ok: false, error: stored.error };
      for (const field of ['responsibilities', 'additionalContext'] as const) {
        const own = edits.filter((e) => e.field === field);
        if (own.length === 0) continue;
        const base = field === 'responsibilities'
          ? (responsibilities ?? stored.responsibilities ?? '')
          : (additionalContext ?? stored.additionalContext ?? '');
        const applied = applyProseEdits(base, own, field);
        if ('error' in applied) return { ok: false, error: applied.error };
        if (field === 'responsibilities') responsibilities = applied.text;
        else additionalContext = applied.text;
      }
    }
    // The person's layer stays in the person's terms, on an edit as on a draft.
    const refusal = refuseExecutionMechanics({ responsibilities, additionalContext });
    if (refusal) return { ok: false, error: refusal };

    const teamUpdate = getRegisteredWorkforcePlanTool('team_update');
    if (!teamUpdate) {
      return { ok: false, error: 'The workspace could not be reached, so nothing was changed. Ask the user to try again in a moment.' };
    }
    const result = (await teamUpdate.execute({
      teamId: internalAgentId,
      ...(responsibilities !== undefined ? { responsibilities } : {}),
      ...(additionalContext !== undefined ? { additionalContext } : {}),
      ...(confirmationId ? { confirmationId } : {}),
    }, ctx)) as Record<string, unknown>;

    if (result.refused === true) return relayRefusal(result);
    if (typeof result.confirmationId === 'string') {
      return {
        ok: true,
        preview: result.preview,
        confirmationId: result.confirmationId,
        message:
          'Nothing is changed yet. Show the user the exact before and after in preview, and '
          + 'when they confirm call this tool again with the same edits plus this confirmationId.',
      };
    }
    return {
      ok: true,
      distilled: true,
      message:
        'The agent is rebuilt from the new text and saved. Tell the user the change is '
        + 'in place and the updated team is on the Teams page.',
    };
  },
};

function relayRefusal(r: Record<string, unknown>): UpdateOutput {
  const reason = String(r.reason ?? '');
  if (reason === 'not_found') return { ok: false, error: 'No agent with that id exists in this workspace.' };
  if (reason === 'forbidden' || reason === 'not_a_member') {
    return { ok: false, error: 'This person is not allowed to change agents in this workspace.' };
  }
  if (reason === 'distill_failed') {
    return {
      ok: false,
      error:
        'The agent could not be rebuilt from the new text, so nothing was changed. Ask the '
        + 'user to try again in a moment.',
    };
  }
  if (reason.startsWith('confirmation_')) {
    return { ok: false, error: `${String(r.message ?? reason)} Call this tool again without confirmationId to preview the change afresh.` };
  }
  return { ok: false, error: `Update failed: ${String(r.message ?? reason)}` };
}
