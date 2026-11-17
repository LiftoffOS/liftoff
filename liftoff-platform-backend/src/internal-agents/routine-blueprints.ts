// Routines people can pick, without anyone typing a cron expression.
//
// Routines are authored by distillation from prose, and that stays true here:
// a blueprint does not create a schedule. It produces the SENTENCE that goes
// into the team member's standing guidance, and the distiller turns that into a
// trigger the same way it would if the person had typed it themselves.
//
// That is the whole design constraint. A blueprint that wrote a cron expression
// directly would be a second authoring path, and the version history, the
// rollback, and the analyzer's guards all hang off distillation being the only
// one.
//
// One definition, two renderings: the picker on the team-member settings page,
// and the prose the distiller reads. Adding a blueprint is adding an entry
// here — no UI change, no new endpoint.

/** A slot the person fills in. Typed, because "every weekday at 9am" and
 *  "every 15 minutes" need different controls and different validation. */
export type SlotType = 'time-of-day' | 'weekday' | 'interval-minutes' | 'text';

export interface BlueprintSlot {
  key: string;
  /** Shown next to the control. */
  label: string;
  type: SlotType;
  /** Used when the person does not change it. Every slot has one, so a
   *  blueprint is always one click from usable. */
  default: string;
  /** Only for `text` — what to put in the empty field. */
  placeholder?: string;
}

export interface RoutineBlueprint {
  id: string;
  /** What the person picks from the list. */
  title: string;
  /** One line under the title. */
  summary: string;
  slots: BlueprintSlot[];
  /**
   * The sentence handed to the distiller, with `{slot}` filled in.
   *
   * Written as an instruction to the team member, in its own voice, because
   * that is what the rest of its guidance looks like — a blueprint should be
   * indistinguishable from something the person wrote.
   */
  prose: string;
  /** Connector types this only makes sense with. Empty means always offerable. */
  requiresConnectorTypes?: string[];
}

export const ROUTINE_BLUEPRINTS: RoutineBlueprint[] = [
  {
    id: 'morning-inbox-sweep',
    title: 'Check my inbox each morning',
    summary: 'Looks for anything that needs a reply and tells you what matters.',
    slots: [
      { key: 'time', label: 'Time', type: 'time-of-day', default: '08:30' },
    ],
    prose:
      'Each weekday at {time}, review the inbox for messages that need a reply, and tell me '
      + 'which ones matter and why. Stay silent when there is nothing worth raising.',
    requiresConnectorTypes: ['google_mail', 'outlook'],
  },
  {
    id: 'weekly-summary',
    title: 'Send a weekly summary',
    summary: 'A short written recap on the day you choose.',
    slots: [
      { key: 'weekday', label: 'Day', type: 'weekday', default: 'Friday' },
      { key: 'time', label: 'Time', type: 'time-of-day', default: '16:00' },
      {
        key: 'topic', label: 'What to cover', type: 'text',
        default: 'what changed this week and what needs attention next week',
        placeholder: 'what changed this week…',
      },
    ],
    prose:
      'Every {weekday} at {time}, write a short summary of {topic}. This one is a report, so '
      + 'send it every time even when the week was quiet.',
  },
  {
    id: 'watch-for-changes',
    title: 'Watch something and tell me when it changes',
    summary: 'Checks on an interval and stays quiet until something moves.',
    slots: [
      { key: 'interval', label: 'Check every', type: 'interval-minutes', default: '60' },
      {
        key: 'what', label: 'What to watch', type: 'text',
        default: 'the thing I asked you to keep an eye on',
        placeholder: 'the deploy status…',
      },
    ],
    prose:
      'Every {interval} minutes, check {what}. Reply with exactly "[SILENT]" when you have '
      + 'checked and nothing has changed — I only want to hear from you when something has.',
  },
  {
    id: 'daily-standup-post',
    title: 'Post a daily update to a channel',
    summary: 'A short status post each working day.',
    slots: [
      { key: 'time', label: 'Time', type: 'time-of-day', default: '09:15' },
      {
        key: 'channel', label: 'Where', type: 'text',
        default: 'the team channel', placeholder: '#team-updates',
      },
    ],
    prose:
      'Each weekday at {time}, post a short update to {channel} covering what happened since '
      + 'the last one. This is a scheduled post, so send it every day even if it is brief.',
    requiresConnectorTypes: ['slack', 'microsoft_teams'],
  },
];

/** Fill the slots and produce the sentence for the team member's guidance.
 *
 *  Unknown slots keep their default rather than leaving a `{placeholder}` in
 *  the prose — a literal brace reaching the distiller would be read as content
 *  and paraphrased into the instructions. */
export function renderBlueprintProse(
  blueprint: RoutineBlueprint,
  values: Record<string, string | undefined>,
): string {
  return blueprint.prose.replace(/\{(\w+)\}/g, (_whole, key: string) => {
    const slot = blueprint.slots.find((s) => s.key === key);
    const supplied = values[key]?.trim();
    return supplied && supplied.length > 0 ? supplied : (slot?.default ?? '');
  });
}

/** The blueprints worth offering for a team member with these connectors.
 *
 *  A blueprint whose integration is not connected would produce a routine that
 *  cannot run, and the person would not find out until it failed on a
 *  schedule. */
export function blueprintsFor(connectorTypes: string[]): RoutineBlueprint[] {
  const have = new Set(connectorTypes);
  return ROUTINE_BLUEPRINTS.filter(
    (b) => !b.requiresConnectorTypes?.length || b.requiresConnectorTypes.some((t) => have.has(t)),
  );
}

export function findBlueprint(id: string): RoutineBlueprint | null {
  return ROUTINE_BLUEPRINTS.find((b) => b.id === id) ?? null;
}
