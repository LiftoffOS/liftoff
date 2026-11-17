import { Tooltip } from '../index'
import MessageIllustration from '../MessageIllustration'
import AgentMessageOptions from '../AgentMessageOptions/AgentMessageOptions'
import XIcon from '../../assets/icons/x.svg?react'

interface MorePaneProps {
  /** The agent, when there is one behind the surface. The platform
   *  assistants (Liftoff, the Insights Manager) have no id at all, and the
   *  cards only need it for analytics and the MCP page's router state. */
  agentId?: string
  /** Display name already resolved by the caller. */
  agentName: string
  /** What people type after @Liftoff in Slack or Microsoft Teams, when the
   *  team has a messaging nickname distinct from its name. */
  nickname?: string
  onClose: () => void
}

/**
 * The chat page's More pane: the ways to reach this team or platform
 * assistant from Slack, Microsoft Teams or an AI coding tool, in the right
 * pane the browser live view also uses. This replaced the standalone
 * /dashboard/agents/message page, whose remaining card only offered to open
 * the chat you are already in.
 *
 * Fixed width, unlike the browser pane: there is nothing here worth trading
 * conversation width for, so it takes the shell's default and has no resizer.
 *
 * Stateless apart from what AgentMessageOptions holds, so the pane can be
 * rendered in a test with only the router + tenant contexts.
 */
export default function MorePane(p: MorePaneProps) {
  return (
    <aside className="chat-page__right-pane" aria-label="More">
      <div className="chat-page__right-pane-close">
        <Tooltip text="Close" position="bottom">
          <button
            type="button"
            className="chat-page__icon-btn"
            aria-label="Close more pane"
            onClick={p.onClose}
          >
            <XIcon width="20" height="20" />
          </button>
        </Tooltip>
      </div>

      <div className="chat-page__more-pane-body">
        {/* Same illustration the messaging page opens with. Its box is a fixed
            260px wide, which clears the pane's 360px drag minimum. */}
        <MessageIllustration />
        <h2 className="chat-page__more-pane-title">More Ways to Connect</h2>
        <AgentMessageOptions
          {...(p.agentId ? { agentId: p.agentId } : {})}
          agentName={p.agentName}
          {...(p.nickname ? { nickname: p.nickname } : {})}
        />
      </div>
    </aside>
  )
}
