// Wording for something delivered into a run that is already under way.
//
// The shared rule across both helpers below is sender attribution: the agent is
// told WHO is speaking and that this continues the current task rather than
// starting a new one. Who is speaking changes how the agent should read it, so
// the two cases are kept distinct — a person redirecting the work, and the
// platform continuing it — and neither is ever dressed up as the other.

export function frameInterrupt(i: {
  text: string; senderDisplayName: string | null; senderAccountId: string | null;
}): string {
  const who = i.senderDisplayName?.trim();
  return (who ? `${who} just sent a message while you were working: ` : 'A user message arrived while you were working: ')
    + `"${i.text}"\n`
    + 'This is a mid-run addition to the current task, not a new task. Take it into '
    + 'account — adjust course, answer it, or acknowledge it in your reply as appropriate.';
}

/**
 * Wording for a platform-initiated continuation of the run that just finished
 * (the B1 verify-on-stop nudge).
 *
 * Deliberately NOT frameInterrupt: that one says a user message arrived, and
 * attributing a platform check to a person would be a falsehood the agent then
 * reasons from — it would look for someone to answer, and might address them in
 * its reply. Same convention, honest attribution.
 */
export function frameSystemContinuation(i: { text: string }): string {
  return 'The platform is continuing your current task, not starting a new one.\n\n' + i.text;
}
