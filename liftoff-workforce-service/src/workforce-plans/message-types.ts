// The two row types a hand-over writes on the Chief AI Officer's thread.
//
// Both are markers every chat surface shares, spelled identically in
// platform-backend (agent-chat/colleague-message-type.ts and
// agent-chat/hitl-status-message.ts) and read by one renderer in
// liftoff-react. Duplicated rather than imported because these are separate
// deployables; the spellings must not drift, and the tests pin them.

/** A colleague's reply inside this conversation: the Insights Manager or
 *  Liftoff, brought in by the Chief AI Officer, speaking in its own words.
 *  Conversation, not narration: the client renders it as an ordinary bubble
 *  attributed through `contributors`, and the reply clock treats it as a
 *  reply, because it is the answer the person was waiting for. */
export const COLLEAGUE_MESSAGE_TYPE = 'colleague';

/** A status line about the conversation rather than something said in it: a
 *  colleague the Chief AI Officer brought in stopped to wait on a person.
 *  Kept out of the model's history and rendered as a status row. */
export const HITL_STATUS_MESSAGE_TYPE = 'hitl_status';

/** A status line saying the person handed the browser back ("<name> handed
 *  the browser back"). The person's, not the Chief AI Officer's: kept out of
 *  the model's history (the segment reaches it through the Browser section),
 *  rendered as a status row, never a reply. Spelled as platform-backend
 *  spells it. */
export const BROWSER_HANDBACK_MESSAGE_TYPE = 'browser_handback';

/** A status line saying what the person pointed at in the browser without
 *  taking over ("<name> pointed at link "Sports""). As the hand-back row. */
export const BROWSER_POINT_MESSAGE_TYPE = 'browser_point';
