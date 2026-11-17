// Liftoff chat is where a team reports. It is not what a team falls back to.
//
// `open_chat_thread` used to condition itself on the workspace having no chat
// or email connector bound. Every team with Slack was therefore told not to use
// the one destination that always exists and never interrupts anyone, which
// left `notifications_send` as the only way to say anything. That tool mails
// immediately and ignores the digest schedule the recipient chose, so the
// advice pushed routine progress reports onto the one channel that costs the
// reader something.
//
// These assert the direction rather than the wording: chat carries no
// no-connector precondition, and the interrupting tool points routine reporting
// back at chat. Rewrite the prose freely; restoring the precondition fails.
import { STANDARD_TOOLS } from '../standard-tools';

function describeTool(name: string): string {
  const tool = STANDARD_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not registered`);
  return tool.description;
}

describe('the team chat is the ordinary reporting destination', () => {
  it('open_chat_thread is not conditioned on the absence of a connector', () => {
    const description = describeTool('open_chat_thread');
    expect(description).not.toMatch(/has no [^.]*connector/i);
    expect(description).not.toMatch(/no chat tool is connected/i);
  });

  it('open_chat_thread does not present itself as a substitute for a named channel', () => {
    // The floor must not cost the connector post. A template naming a Slack
    // channel still means that channel; this is additional, not instead.
    expect(describeTool('open_chat_thread')).toMatch(/as well|does not replace/i);
  });

  it('notifications_send sends routine reporting to the chat instead', () => {
    const description = describeTool('notifications_send');
    expect(description).toMatch(/team chat/i);
    expect(description).toMatch(/do not use it to report/i);
  });

  it('notifications_send names the three situations that justify interrupting', () => {
    const description = describeTool('notifications_send');
    expect(description).toMatch(/blocked/i);
    expect(description).toMatch(/only a person can make/i);
    expect(description).toMatch(/outside/i);
  });
});
