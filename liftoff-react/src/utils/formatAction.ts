// Shared action label formatter for audit log display.
// Turns raw action strings from agent_audit_logs into human-readable labels.
//
// Used by: ActivityPage, HomePage (Recent Activity), AgentsPage (Last Activity)

// Known acronyms that must stay uppercase when title-casing connector/tool names.
const ACRONYMS = new Set(['mcp', 'hitl', 'sdk', 'api', 'ai', 'hris', 'dlq', 'oauth'])

function titleCase(s: string): string {
  return s
    .replace(/[-_]+/g, ' ')
    .split(' ')
    .map(word =>
      word.length > 0 && ACRONYMS.has(word.toLowerCase())
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ')
}

// Explicit human-readable labels for lifecycle, governance, and infrastructure events.
// These are events where the action name alone cannot describe what was actually done —
// tool calls (external-agent_*, connector__action, sandbox:*) are more informative and
// handled by the pattern matchers below.
const LABEL_MAP: Record<string, string> = {
  agent_invocation_completed: 'Task completed',
  agent_invocation_started:   'Task started',
  agent_escalation:           'Escalated to human',
  agent_execution:            'Task executed',
  developer_proxy_request:    'Claude Code request',
  correction_request:         'Correction requested',
  correction_failed:          'Correction failed',
  correction_timeout:         'Correction timed out',
  activated:                  'Activated',
  paused:                     'Paused',
  archived:                   'Archived',
  hitl_level_5_operation:       'Autonomous operation',
  hitl_level_4_auto_elevated:   'Auto-approved operation',
  human_feedback_resolved:      'Feedback resolved',
  hitl_late_feedback_submitted: 'Late feedback submitted',
  gmail_send_email:             'Sent email',
  slack_post_message:           'Posted to Slack',
  tool_call:                  'Tool call',
  runtime_status_changed:     'Status changed',
  sdk_pre_compact:            'Context compacted',
  sdk_post_compact:           'Context compacted',
  cleanup_completed:          'Cleanup completed',
  created_from_internal_agent:'Instructions compiled',
  retried:                    'Retried',
  compensated:                'Compensated',
  escalated:                  'Escalated',
  discarded:                  'Discarded',
}

export function formatActionLabel(action: string | null | undefined): string {
  if (!action) return ''
  if (LABEL_MAP[action]) return LABEL_MAP[action]

  // external-agent_coingecko_get_simple_price → "Get Simple Price"
  if (action.startsWith('external-agent_')) {
    const rest = action.slice('external-agent_'.length)
    const sep = rest.indexOf('_')
    return titleCase(sep > 0 ? rest.slice(sep + 1) : rest)
  }

  // sandbox:shell_exec → "Shell Exec"
  if (action.startsWith('sandbox:')) {
    return titleCase(action.slice('sandbox:'.length))
  }

  // github__create_issue or github_oauth__get_user → "Create Issue"
  if (action.includes('__')) {
    return titleCase(action.slice(action.indexOf('__') + 2))
  }

  // generic fallback
  return titleCase(action)
}
