import { useEffect, useMemo, useRef } from 'react'
import UserAvatar from '../UserAvatar'
import GuestAvatar from '../GuestAvatar'
import Tooltip from '../Tooltip'
import { track } from '../../lib/analytics'
import type {
  LiftoffBand,
  LiftoffConfidence,
  LiftoffScoreEntry,
  LiftoffScoreGroup,
  LiftoffScoreResponse,
  LiftoffGroupKey,
} from '../../types/liftoffScore'
import './LiftoffScorePanel.css'

interface LiftoffScorePanelProps {
  data: LiftoffScoreResponse | undefined
  isLoading: boolean
}

const GROUP_ORDER: LiftoffGroupKey[] = ['ai', 'person']
const GROUP_LABEL: Record<LiftoffGroupKey, string> = {
  ai: 'agents',
  person: 'People',
}

/**
 * Singular form, for the score tooltip.
 *
 * The anchor is the best score WITHIN a group, never across the workspace:
 * teams and people are separate scales and are not ranked against each other.
 * Naming the group here keeps the tooltip honest about which comparison the
 * number belongs to.
 */
const GROUP_PEER: Record<LiftoffGroupKey, string> = {
  ai: 'agent',
  person: 'person',
}

/** The band is what makes the number mean something without a manual. */
const BAND_LABEL: Record<LiftoffBand, string> = {
  strong: 'Strong',
  good: 'Good',
  needs_work: 'Needs work',
  poor: 'Struggling',
}

const CONFIDENCE_LABEL: Record<LiftoffConfidence, string> = {
  high: 'confident',
  medium: 'fairly confident',
  early: 'early days',
}

function notRatedText(entry: LiftoffScoreEntry): string {
  switch (entry.notRatedReason) {
    case 'single_partner':
      return 'Has only worked with one teammate, so we cannot tell their part from that teammate’s.'
    case 'no_shared_work':
      return 'Has not shared any work with the rest of the workspace yet.'
    case 'too_early':
    default: {
      const n = entry.taskCount
      const tasks = `${n} ${n === 1 ? 'task' : 'tasks'} so far.`
      return entry.tasksToRate
        ? `${tasks} About ${entry.tasksToRate} more and we can rate them.`
        : tasks
    }
  }
}

function EntityAvatar({ entry }: { entry: LiftoffScoreEntry }) {
  if (entry.accountId) {
    const [firstName, ...rest] = entry.displayName.split(' ')
    return (
      <UserAvatar
        className="lscore__avatar"
        person={{
          accountId: entry.accountId,
          firstName,
          lastName: rest.join(' ') || null,
          email: entry.email ?? '',
        }}
      />
    )
  }
  return <GuestAvatar className="lscore__avatar" label={entry.displayName} />
}

function hours(n: number): string {
  return n >= 10 ? `${Math.round(n)} hrs` : `${n} hrs`
}

function RatedRow({ entry }: { entry: LiftoffScoreEntry }) {
  const { score, band, confidence } = entry
  if (score === null || !band) return null

  return (
    <li className={`lscore__row lscore__row--${band}`}>
      <div className="lscore__ident">
        <EntityAvatar entry={entry} />
        <div className="lscore__ident-text">
          <span className="lscore__name">{entry.displayName}</span>
          <span className="lscore__basis">
            Based on {entry.taskCount} {entry.taskCount === 1 ? 'task' : 'tasks'}
            {confidence ? `, ${CONFIDENCE_LABEL[confidence]}` : ''}
          </span>
        </div>
      </div>

      <div className="lscore__verdict">
        <Tooltip
          text={`${BAND_LABEL[band]}. 100 is the best any ${GROUP_PEER[entry.group]} reaches in this workspace.`}
        >
          <span className="lscore__number">{score}</span>
        </Tooltip>
        <span className={`lscore__band lscore__band--${band}`}>{BAND_LABEL[band]}</span>
        <span className="lscore__halves">
          {entry.resultsBand && (
            <span>
              Results <b className={`lscore__half--${entry.resultsBand}`}>{BAND_LABEL[entry.resultsBand].toLowerCase()}</b>
            </span>
          )}
          {entry.teamworkBand && (
            <span>
              Teamwork <b className={`lscore__half--${entry.teamworkBand}`}>{BAND_LABEL[entry.teamworkBand].toLowerCase()}</b>
            </span>
          )}
        </span>
      </div>

      <ul className="lscore__drivers">
        {entry.drivers.map((d, i) => (
          <li key={i} className={`lscore__driver lscore__driver--${d.kind}`}>
            <span className="lscore__driver-mark" aria-hidden="true">
              {d.kind === 'helping' ? '✓' : '✗'}
            </span>
            <span className="lscore__driver-text">
              <span className="lscore__sr">{d.kind === 'helping' ? 'Helping: ' : 'Hurting: '}</span>
              {d.label}
              {d.benchmark ? <em className="lscore__bench"> {d.benchmark}</em> : null}
            </span>
          </li>
        ))}
        {/* An empty space where every other row has a next step reads as
            "we forgot", not "nothing needed". Say it. */}
        {!entry.action && (
          <li className="lscore__action lscore__action--none">
            <span className="lscore__driver-mark" aria-hidden="true">&mdash;</span>
            <span className="lscore__driver-text">Nothing to change right now</span>
          </li>
        )}
        {entry.action && (
          <li className="lscore__action">
            <span className="lscore__driver-mark" aria-hidden="true">&rarr;</span>
            <span className="lscore__driver-text">
              <span className="lscore__sr">Next step: </span>
              {entry.action.href ? (
                <a
                  href={entry.action.href}
                  className="lscore__action-link"
                  onClick={() => track('liftoff_score_action_clicked', { entity_kind: entry.kind })}
                >
                  {entry.action.label}
                </a>
              ) : (
                entry.action.label
              )}
              {typeof entry.action.hoursSavedPerMonth === 'number' && (
                <span className="lscore__payoff">
                  frees ~{hours(entry.action.hoursSavedPerMonth)}/month
                </span>
              )}
              {entry.action.evidence && (
                <span className="lscore__evidence">
                  It asked {entry.action.evidence.occurrences} times:{' '}
                  <q>{entry.action.evidence.quote}</q>
                </span>
              )}
            </span>
          </li>
        )}
      </ul>
    </li>
  )
}

function GroupSection({
  group,
  entries,
}: {
  group: LiftoffScoreGroup
  entries: LiftoffScoreEntry[]
}) {
  const rated = entries.filter(e => e.rated && e.score !== null)
  if (rated.length === 0) return null

  return (
    <section className="lscore__group">
      <header className="lscore__group-head">
        <h4 className={`lscore__group-name lscore__group-name--${group.key}`}>
          {GROUP_LABEL[group.key]}
        </h4>
        {typeof group.hoursSavedPerMonthAvailable === 'number' &&
          group.hoursSavedPerMonthAvailable > 0 && (
            <span className="lscore__group-payoff">
              ~{hours(group.hoursSavedPerMonthAvailable)}/month available from the steps below
            </span>
          )}
      </header>
      <ul className="lscore__rows">
        {rated.map(e => (
          <RatedRow key={e.entityKey} entry={e} />
        ))}
      </ul>
    </section>
  )
}

function Notice({ title, body }: { title: string; body: string }) {
  return (
    <div className="lscore__notice">
      <p className="lscore__notice-title">{title}</p>
      <p className="lscore__notice-body">{body}</p>
    </div>
  )
}

/**
 * LiftoffScore in the Insights report.
 *
 * Every number on screen is either the anchored 0-100 score or a fact in units
 * a person already understands. The estimator's own quantities (posterior mean,
 * spread, per-dimension sample counts) are deliberately absent: an earlier
 * version rendered them and the row was unreadable.
 */
export default function LiftoffScorePanel({ data, isLoading }: LiftoffScorePanelProps) {
  const viewedRef = useRef(false)

  const rated = useMemo(() => (data ? data.entries.filter(e => e.rated) : []), [data])
  const notRated = useMemo(() => (data ? data.entries.filter(e => !e.rated) : []), [data])

  useEffect(() => {
    if (viewedRef.current || !data) return
    viewedRef.current = true
    track('liftoff_score_viewed', {
      period: data.period,
      status: data.status,
      rated_count: rated.length,
      unrated_count: notRated.length,
    })
  }, [data, rated.length, notRated.length])

  if (isLoading) {
    return (
      <div className="insights-report__section" aria-busy="true">
        <h3 className="insights-report__section-title">LiftoffScore</h3>
        <div className="lscore__skeleton" />
        <div className="lscore__skeleton" />
      </div>
    )
  }

  if (!data) return null

  const groups = GROUP_ORDER.map(k => data.groups.find(g => g.key === k)).filter(
    (g): g is LiftoffScoreGroup => !!g,
  )

  return (
    <div className="insights-report__section lscore">
      <header className="lscore__head">
        <h3 className="insights-report__section-title lscore__title">LiftoffScore</h3>
        <span className="lscore__meta">{data.taskCount} tasks scored this month</span>
      </header>

      <p className="lscore__intro">
        How well each teammate works with the others, out of 100. Higher is better. Each row
        shows what is going well, what is holding it back, and the one change worth making.
      </p>

      {data.status === 'too_early' && (
        <Notice
          title="Not enough work scored yet"
          body="Scores appear once your workspace has around 20 scored tasks and a few teammates have worked together more than once. Nothing to do here, this fills in on its own."
        />
      )}

      {data.status === 'on_hold' && (
        <Notice
          title="Scores are on hold"
          body="Your workspace has split into groups that share no work, so scores from one cannot be compared with another. They come back once people from both groups work together."
        />
      )}

      {data.status === 'ok' && (
        <>
          {groups.map(g => (
            <GroupSection
              key={g.key}
              group={g}
              entries={data.entries.filter(e => e.group === g.key)}
            />
          ))}

          {notRated.length > 0 && (
            <section className="lscore__quiet">
              <h4 className="lscore__quiet-label">Not rated yet</h4>
              <ul className="lscore__quiet-rows">
                {notRated.map(e => (
                  <li key={e.entityKey} className="lscore__quiet-row">
                    <EntityAvatar entry={e} />
                    <span className="lscore__name">{e.displayName}</span>
                    <span className="lscore__quiet-why">{notRatedText(e)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="lscore__footnote">
            agents and people are scored on separate scales and are never ranked against each
            other. Within a scale, 100 is the best any member of that group reaches in this
            workspace, not perfection. A score rises on its own as we see more work. This is not a
            performance review.
          </p>
        </>
      )}
    </div>
  )
}
