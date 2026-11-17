// The Slack CONNECTOR must never be an agent's way to send.
//
// connector-service takes Slack's oauth.v2.access response and deliberately
// keeps `authed_user.access_token` as the connector credential, handing the
// xoxb BOT token to the workspace install instead. So a connector send is
// chat.postMessage with a USER token, and Slack renders it as that person.
//
// Offered both, an agent's posts through the connector arrive under a human's
// name and face, while the same agent's digest — which goes through the
// workspace bot — arrives as "Liftoff". Both tool sets would sit in one distill
// catalog, near-identical by name (`slack_send_message` vs
// `slack-<id>__send_message`), with nothing saying one is a person and one is
// the app.
//
// This withholds rather than discourages. Prompt wording is a soft preference,
// and the distiller ignoring a soft preference is a known defect class. An agent posting as a named human
// is never what the operator asked for, so the tool is simply not offered.
//
// Scoped to the WRITE verbs. Reading channels, history and users through the
// connector is legitimate and was never the problem.

/** Slack write verbs, as they appear after the connector alias prefix. */
const SLACK_SEND_VERBS = [
  'send_message',
  'post_message',
  'send_dm',
  'reply_in_thread',
  'update_message',
  'delete_message',
  'add_reaction',
  'upload_file',
] as const;

/** True for a Slack CONNECTOR tool that would post as the connecting user.
 *
 *  Connector tools are aliased `<type>-<connectorIdPrefix>__<verb>` (e.g.
 *  `slack-d77db9a0__send_message`). The platform's own app tools are bare
 *  `slack_send_message` with an underscore and no alias, so the `slack-`
 *  prefix plus `__` separator is what distinguishes them — matching on the verb
 *  alone would withhold the very tools this exists to promote.
 */
export function isSlackConnectorSendTool(toolName: string): boolean {
  if (!toolName.startsWith('slack-')) return false;
  const sep = toolName.indexOf('__');
  if (sep === -1) return false;
  const verb = toolName.slice(sep + 2).toLowerCase();
  return SLACK_SEND_VERBS.some((v) => verb === v);
}
