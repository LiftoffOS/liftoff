// MessageIllustration — animated mini chat preview.
//
// Shows a compact chat conversation with messages appearing one at a time,
// each preceded by a typing indicator. Mimics the actual chat experience
// the user will have. Matches the product-mirror animation style from
// ControlAnimation (review cards) and DesignAnimation (typing + card reveals).
//
// Cycle: typing dots → user message → typing dots → agent message → hold → reset

import { useEffect, useRef, useState } from 'react'

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const ACCENT = '#FB411F'
const BORDER = '#e4e4e4'
const MUTED = '#999'

// Conversation lines — short, natural, shows the back-and-forth
const CONVERSATIONS = [
  [
    { role: 'user', text: 'How did everything go?' },
    { role: 'agent', text: 'All done. 2 items need your review.' },
  ],
  [
    { role: 'user', text: 'I\'ve got feedback for you.' },
    { role: 'agent', text: 'I\'m listening. What should I change?' },
  ],
  [
    { role: 'user', text: 'What are you working on?' },
    { role: 'agent', text: 'Finishing up the last batch now.' },
  ],
]

// Phases: 0=empty, 1=user typing, 2=user msg visible, 3=agent typing, 4=agent msg visible, 5=hold
const PHASE_TYPING = 1200
const PHASE_SHOW = 400
const PHASE_AGENT_TYPING = 1600
const PHASE_HOLD = 2800

export default function MessageIllustration() {
  const [convoIndex, setConvoIndex] = useState(0)
  const [phase, setPhase] = useState(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const conversation = CONVERSATIONS[convoIndex % CONVERSATIONS.length]

  useEffect(() => {
    const schedule = (next: number, delay: number) => {
      timerRef.current = setTimeout(() => setPhase(next), delay)
    }

    switch (phase) {
      case 0: schedule(1, 600); break                       // brief pause → user typing
      case 1: schedule(2, PHASE_TYPING); break              // typing dots → show user msg
      case 2: schedule(3, PHASE_SHOW); break                // user visible → agent typing
      case 3: schedule(4, PHASE_AGENT_TYPING); break        // typing dots → show agent msg
      case 4: schedule(5, PHASE_SHOW); break                // agent visible → hold
      case 5:                                                // hold → reset with next convo
        timerRef.current = setTimeout(() => {
          setConvoIndex(i => i + 1)
          setPhase(0)
        }, PHASE_HOLD)
        break
    }

    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [phase])

  const userMsg = conversation[0]
  const agentMsg = conversation[1]

  return (
    <div style={styles.container}>
      {/* Mini chat window */}
      <div style={styles.chatWindow}>
        {/* Header bar */}
        <div style={styles.header}>
          <div style={styles.headerDot} />
          <span style={styles.headerText}>Chat</span>
        </div>

        {/* Messages area */}
        <div style={styles.messagesArea}>
          {/* User message */}
          <div style={{
            ...styles.messageRow,
            ...styles.messageRowUser,
            opacity: phase >= 1 ? 1 : 0,
            transform: phase >= 2 ? 'translateY(0)' : 'translateY(6px)',
            transition: `opacity 480ms ${EASE}, transform 480ms ${EASE}`,
          }}>
            {phase === 1 ? (
              <div style={{ ...styles.bubble, ...styles.bubbleUser }}>
                <TypingDots />
              </div>
            ) : (
              <div style={{ ...styles.bubble, ...styles.bubbleUser }}>
                <span style={styles.messageText}>{userMsg.text}</span>
              </div>
            )}
          </div>

          {/* Agent message */}
          <div style={{
            ...styles.messageRow,
            ...styles.messageRowAgent,
            opacity: phase >= 3 ? 1 : 0,
            transform: phase >= 4 ? 'translateY(0)' : 'translateY(6px)',
            transition: `opacity 480ms ${EASE}, transform 480ms ${EASE}`,
          }}>
            {phase === 3 ? (
              <div style={{ ...styles.bubble, ...styles.bubbleAgent }}>
                <TypingDots accent />
              </div>
            ) : (
              <div style={{ ...styles.bubble, ...styles.bubbleAgent }}>
                <span style={styles.messageText}>{agentMsg.text}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes msg-dot-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-3px); opacity: 1; }
        }
      `}</style>
    </div>
  )
}

function TypingDots({ accent }: { accent?: boolean }) {
  const color = accent ? ACCENT : MUTED
  return (
    <div style={{ display: 'flex', gap: 3, alignItems: 'center', padding: '2px 0' }}>
      {[0, 1, 2].map(i => (
        <div
          key={i}
          style={{
            width: 4,
            height: 4,
            borderRadius: '50%',
            backgroundColor: color,
            animation: `msg-dot-bounce 1.2s ease-in-out ${i * 0.15}s infinite`,
          }}
        />
      ))}
    </div>
  )
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    width: 260,
    margin: '0 auto',
  },
  chatWindow: {
    borderRadius: 12,
    border: `1px solid ${BORDER}`,
    overflow: 'hidden',
    background: '#fff',
    boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 12px',
    borderBottom: `1px solid ${BORDER}`,
    background: '#fafafa',
  },
  headerDot: {
    width: 7,
    height: 7,
    borderRadius: '50%',
    background: '#22c55e',
  },
  headerText: {
    fontSize: 11,
    fontWeight: 500,
    color: MUTED,
    letterSpacing: '0.02em',
  },
  messagesArea: {
    padding: '14px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    height: 116,
  },
  messageRow: {
    display: 'flex',
  },
  messageRowUser: {
    justifyContent: 'flex-end',
  },
  messageRowAgent: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '85%',
    padding: '7px 11px',
    borderRadius: 10,
    fontSize: 11,
    lineHeight: 1.45,
  },
  bubbleUser: {
    background: '#f5f5f5',
    border: `1px solid ${BORDER}`,
    color: '#1e1e1e',
    borderBottomRightRadius: 4,
  },
  bubbleAgent: {
    background: '#fff5f3',
    border: '1px solid rgba(251, 65, 31, 0.15)',
    color: '#1e1e1e',
    borderBottomLeftRadius: 4,
  },
  messageText: {
    display: 'block',
  },
}
