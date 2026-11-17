import { useChatAttachments } from '../../hooks/useChatAttachments'
import { useState, useEffect, useRef } from 'react'
import type { JSX } from 'react'
import { useNavigate } from 'react-router'
import { Button, Tooltip } from '../../components'
import { useAuth } from '../../contexts/AuthContext'
import {
  useGettingStartedPreference,
  GETTING_STARTED_REMIND_LATER_KEY
} from '../../hooks/useGettingStartedPreference'
import { useWorkspaceMembers } from '../../hooks/useTenantMembers'
import { useInternalAgents } from '../../hooks/useInternalAgents'
import { useLiftoffThreads } from '../../hooks/useLiftoffThreads'
import { useLiftoffUnreadCount } from '../../hooks/useLiftoffUnread'
import BackpackIcon from '../../assets/icons/backpack.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import ArrowRightIcon from '../../assets/icons/arrow-right.svg?react'
import PeopleIcon from '../../assets/icons/people.svg?react'
import UserRoundPlusIcon from '../../assets/icons/user-round-plus.svg?react'
import SquareChartGanttIcon from '../../assets/icons/square-chart-gantt.svg?react'
import { UserAvatar } from '../../components/UserAvatar'
import ChatInput from '../../components/Chat/ChatInput'
import { ChatInputActions } from '../../components/Chat/ChatInputActions'
import { VoiceInputButton } from '../../components/Chat/VoiceControls'
import { FileUploadButton } from '../../components/FileAttach'
import { useVoiceChat } from '../../hooks/useVoiceChat'
import { useTenant } from '../../hooks/useTenant'
import type { DisplayAttachment } from '../../services/internalAgents'
import { buildMentionRoster, toMentionListItems, parseAgentMention } from '../../utils/agentMention'
import type { ChatSeedState } from '../../types/chatSeed'
import { track } from '../../lib/analytics'
import './HomePage.css'
import '../../components/connectionModals.css'

function getTimeOfDay(): string {
  const hour = new Date().getHours()
  if (hour >= 4 && hour < 12) return 'this morning'
  if (hour >= 12 && hour < 17) return 'this afternoon'
  if (hour >= 17 && hour < 21) return 'this evening'
  return 'tonight'
}

const getGettingStartedCards = (hasTeams: boolean) => [
  {
    id: '1',
    icon: 'teams',
    title: hasTeams ? 'Bring on A New Team' : 'Bring on Your First Team',
    description: hasTeams
      ? 'Launch a new agent that can start working autonomously right away.'
      : 'Launch an agent that can start working autonomously right away.',
    action: 'Get Started',
    actionType: 'primary' as const,
  },
  {
    id: '2',
    icon: 'planning',
    title: 'Plan with Your Chief AI Officer',
    description: 'Create an AI workforce plan for your company',
    action: 'Start Planning',
    actionType: 'link' as const,
  },
  {
    id: '3',
    icon: 'invite',
    title: 'Invite People',
    description: 'Bring your colleagues into your workspace to collaborate.',
    action: 'Send Invites',
    actionType: 'link' as const,
  },
  {
    id: '4',
    icon: 'learn',
    title: 'Learn How Liftoff Works',
    description: 'Learn how to use Liftoff to its full potential.',
    action: 'Start Learning',
    actionType: 'link' as const,
  },
]

const icons: Record<string, JSX.Element> = {
  teams: (
    <PeopleIcon width="20" height="20" />
  ),
  learn: (
    <BackpackIcon width="20" height="20" />
  ),
  planning: (
    <SquareChartGanttIcon width="20" height="20" />
  ),
  invite: (
    <UserRoundPlusIcon width="20" height="20" />
  ),
}

export default function HomePage() {
  const navigate = useNavigate()
  const { account, currentTenant } = useAuth()
  const { currentTenant: tenant } = useTenant()
  const [chatInputValue, setChatInputValue] = useState('')
  const [attachments, setAttachments] = useState<DisplayAttachment[]>([])
  const teamsQuery = useInternalAgents({ status: 'active' })
  const viewedRef = useRef(false)

  const teams = teamsQuery.data?.pages?.flatMap(p => p.internalAgents) ?? []
  const mentionRoster = buildMentionRoster(teams.map(t => ({ id: t.id, role: t.role })))
  const mentionItems = toMentionListItems(mentionRoster)

  // Offer to resume only when there is something to resume. A button promising
  // continuity that opens an empty list is worse than no button, and a brand new
  // workspace would get exactly that.
  const liftoffThreads = useLiftoffThreads()
  const hasPastConversations =
    (liftoffThreads.data?.pages?.[0]?.threads.length ?? 0) > 0

  // The dot on the Resume button reads the same count the history modal's row
  // dots read, exactly as Message Team's dot shares the teams list's query, so
  // the two indicators cannot disagree.
  const { data: liftoffUnreadCount } = useLiftoffUnreadCount()
  const hasUnreadLiftoffReplies = (liftoffUnreadCount ?? 0) > 0

  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('dashboard_home_viewed', {})
  }, [])

  const handleBringOnInternalAgent = () => {
    track('dashboard_add_function_clicked', {})
    navigate('/dashboard/agents/explore')
  }

  const handleChatSend = () => {
    const message = chatInputValue.trim()
    if (!message) return

    const { strippedText, target } = parseAgentMention(message, mentionRoster)
    const targetMention = target || mentionRoster[0]

    const seedState: ChatSeedState = {
      seedMessage: strippedText,
      seedAttachments: attachments,
      ...(targetMention.kind === 'team' && { agentId: targetMention.id }),
    }

    const routeMap: Record<string, string> = {
      liftoff: '/dashboard/liftoff',
      caio: '/dashboard/agents/plan',
      insights: '/dashboard/insights',
      team: '/dashboard/agents/chat',
    }

    const targetRoute = routeMap[targetMention.kind]
    if (targetRoute) {
      setChatInputValue('')
      setAttachments([])
      navigate(targetRoute, { state: seedState })
    }
  }

  // Attaching, written once for all five composers.
  //
  // This page names NO surface and NO thread, and both omissions are the point.
  // It has no thread because it creates one on send, and it has no surface
  // because handleChatSend below routes to Liftoff, the Chief AI Officer, the
  // Insights Manager or a team depending on an @mention it parses at that
  // moment — after the file has already been uploaded. Passing a surface here
  // would store a guess; the claim that runs when the message actually lands is
  // what records where it went.
  const attaching = useChatAttachments({
    tenantId: tenant?.id,
    attachments,
    setAttachments,
  })

  const voice = useVoiceChat({
    tenantId: tenant?.id,
    surface: 'agent_chat',
    composerText: chatInputValue,
    setComposerText: setChatInputValue,
    assistantText: null,
    activity: null,
    onSend: handleChatSend,
    onStopRun: () => {},
    onError: () => {},
  })

  const { data: workspaceMembers = [], isLoading: isLoadingMembers } = useWorkspaceMembers(currentTenant?.id)

  const {
    isHidden: permanentlyHidden,
    isLoading: prefsLoading,
    hideGettingStarted
  } = useGettingStartedPreference()

  // Dismissal for THIS session, which is the only part a click changes.
  const [sessionAllowsGettingStarted, setSessionAllowsGettingStarted] = useState(() => {
    const remindLater = sessionStorage.getItem(GETTING_STARTED_REMIND_LATER_KEY)
    return !remindLater
  })

  // The stored preference is the other half, folded in here rather than
  // written back into the session flag by an effect. While preferences load,
  // permanentlyHidden is not yet known and this reads as the session alone,
  // which is what the header CTA below relies on to avoid flashing.
  const showGettingStarted = sessionAllowsGettingStarted && !(!prefsLoading && permanentlyHidden)

  const shouldShowBanner = showGettingStarted && !prefsLoading && !permanentlyHidden

  // The header CTA and the first Getting Started card open the same destination,
  // so they hand off rather than compete: the card carries the action while the
  // section is up, and the header button takes over the moment it is dismissed,
  // for the session or for good. Keyed on showGettingStarted, not
  // shouldShowBanner, which is false while preferences load and would flash the
  // button in and out under a banner that was always coming.
  const showHeaderCta = !showGettingStarted

  const handleDontShowAgain = () => {
    track('dashboard_getting_started_dismissed', { mode: 'dont_show_again' })
    hideGettingStarted()
    setSessionAllowsGettingStarted(false)
  }

  const handleRemindLater = () => {
    track('dashboard_getting_started_dismissed', { mode: 'remind_later' })
    sessionStorage.setItem(GETTING_STARTED_REMIND_LATER_KEY, 'true')
    setSessionAllowsGettingStarted(false)
  }

  return (
    <div className="home-page">
      {/* Header */}
      <header className="home-page__header">
        <h1 className="home-page__title">
          Welcome back{account?.firstName ? `, ${account.firstName}` : ''}!
        </h1>
        {showHeaderCta && (
          <Button variant="primary" onClick={handleBringOnInternalAgent}>
            Add Agent
          </Button>
        )}
      </header>

      {/* Chat Input Section */}
      <section className="home-page__section">
        <h2 className="home-page__chat-heading">How can I help you {getTimeOfDay()}?</h2>
        <div className="home-page__chat-input-wrapper">
          <ChatInput
            value={chatInputValue}
            onChange={setChatInputValue}
            onSend={handleChatSend}
            disabled={false}
            placeholder="Ask anything, type @ to mention an agent"
            mentionItems={mentionItems}
            attachments={attachments}
            onRemoveAttachment={attaching.onRemoveAttachment}
            onFilesAdded={attaching.onFilesAdded}
            leftActions={
              // No browser here: this surface has no thread to hang a session on.
              // The slot is simply left empty rather than the order restated.
              <ChatInputActions
                attach={
                  <FileUploadButton
                    onAttach={attaching.onAttach}
                    {...(attaching.mediaContext ? { mediaContext: attaching.mediaContext } : {})}
                    existingMediaCount={attaching.existingMediaCount}
                    onErrors={attaching.onErrors}
                  />
                }
                voice={
                  <VoiceInputButton
                    isListening={voice.isListening}
                    onToggle={voice.toggleListening}
                    levelRef={voice.levelRef}
                  />
                }
              />
            }
          />
        </div>
        {hasPastConversations && (
          <div className="home-page__resume">
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/dashboard/liftoff', { state: { openHistory: true } })}
            >
              {/* One span so the label and its dot are a single flex item:
                * the button is a gapped flex row, and a sibling dot would be
                * centred a gap away instead of riding the text's corner. */}
              <span className="home-page__resume-label">
                Resume Previous Conversation
                {hasUnreadLiftoffReplies && (
                  <span className="home-page__resume-dot" aria-hidden="true" />
                )}
              </span>
              {/* The dot is not the only signal: colour alone reaches neither
                * a screen reader nor a colour-blind reader, so the state
                * rides on the control's accessible name too. */}
              {hasUnreadLiftoffReplies && (
                <span className="sr-only">, unread replies</span>
              )}
            </Button>
          </div>
        )}
      </section>

      {/* Getting Started */}
      {shouldShowBanner && (
        <section className="home-page__section">
          <div className="home-page__section-header">
            <h2 className="home-page__section-title">Getting Started</h2>
            <div className="home-page__section-actions">
              <button className="home-page__text-btn" onClick={handleDontShowAgain}>
                Do not Show Again
              </button>
              <button className="home-page__text-btn home-page__text-btn--dismiss" onClick={handleRemindLater}>
                Remind Me Later
                <XIcon width="14" height="14" />
              </button>
            </div>
          </div>

          <div className="home-page__getting-started">
            {getGettingStartedCards(currentTenant?.hasCreatedInternalAgent ?? false).map((card) => (
              <div key={card.id} className="getting-started-card">
                <div className="getting-started-card__icon">
                  {icons[card.icon]}
                </div>
                <div className="getting-started-card__content">
                  <h3 className="getting-started-card__title">{card.title}</h3>
                  <p className="getting-started-card__description">{card.description}</p>
                  <button
                    className={`getting-started-card__action ${card.actionType === 'primary' ? 'getting-started-card__action--primary' : ''}`}
                    onClick={() => {
                      const destinationMap: Record<string, string> = {
                        '1': '/dashboard/agents/explore',
                        '2': '/dashboard/agents/plan',
                        '3': '/dashboard/settings/workspace?section=workspaceMembers',
                        '4': '/dashboard/support',
                      }
                      const dest = destinationMap[card.id] ?? '/dashboard'
                      track('dashboard_getting_started_card_clicked', { card_id: card.id as '1' | '2' | '3' | '4', destination: dest })
                      navigate(dest)
                    }}
                  >
                    {card.action}
                    <ArrowRightIcon width="14" height="14" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Workspace Members */}
      {workspaceMembers && workspaceMembers.length > 1 && (
        <section className="home-page__section home-page__section--workspace-members-bottom">
          <div className="home-page__workspace-members-centered">
            <h2 className="home-page__section-title">Workspace Members</h2>
            <div className="home-page__workspace-members">
              {isLoadingMembers ? (
                <>
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="workspace-member-card workspace-member-card--skeleton">
                      <div className="workspace-member-card__avatar skeleton-pulse" />
                    </div>
                  ))}
                </>
              ) : (
                <>
                  {workspaceMembers.slice(0, 8).map((member) => (
                    <Tooltip key={member.id} text={member.account.firstName || member.account.email} position="top">
                      <div
                        className="workspace-member-card"
                        role="presentation"
                        onClick={() => track('dashboard_workspace_member_avatar_clicked', { has_more: false })}
                      >
                        <UserAvatar
                          person={{ accountId: member.accountId, ...member.account }}
                          className="workspace-member-card__avatar"
                        />
                      </div>
                    </Tooltip>
                  ))}
                  {workspaceMembers.length > 8 && (
                    <Tooltip text="View all" position="top">
                      <a
                        href="/dashboard/settings/workspace?section=workspaceMembers"
                        className="workspace-member-card workspace-member-card--more"
                        onClick={() => track('dashboard_workspace_member_avatar_clicked', { has_more: true })}
                      >
                        <div className="workspace-member-card__avatar workspace-member-card__avatar--more">
                          +{workspaceMembers.length - 8}
                        </div>
                      </a>
                    </Tooltip>
                  )}
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  )
}
