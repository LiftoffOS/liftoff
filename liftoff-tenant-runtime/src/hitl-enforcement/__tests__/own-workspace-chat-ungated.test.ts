// An agent may always tell its own people what it did.
//
// The external-content gate asks whether an action can be steered by untrusted
// text, which is the right question for an action that LEAVES the workspace and
// the wrong one for a message read by the people the agent reports to. Reading
// a sentence is not acting on it.
//
// What gating it produces is visible and absurd: a reviewer agent posts its
// review to a public pull request ungated, then needs a human to approve
// telling its owner it has (reason `external_content_write`, on a step its own
// approved workflow declares).
//
// The declared-scope exemption could never have covered it. That clearance
// requires `argumentsAuthored` — no `{{…}}` anywhere in the step's arguments —
// and a report interpolates by definition, so every reporting step in every
// graph is disqualified by construction rather than by oversight.

import { readFileSync } from 'fs';
import { resolve } from 'path';
import { isOwnWorkspaceChatTool, isInProcessBookkeepingTool } from '../tool-name-resolution';

describe('messaging the workspace is not an outbound action', () => {
  it('exempts the chat tool, bare and mcp-prefixed', () => {
    // The SDK calls the prefixed name and the catalog stores the bare one.
    expect(isOwnWorkspaceChatTool('open_chat_thread')).toBe(true);
    expect(isOwnWorkspaceChatTool('mcp__liftoff-tool-gateway__open_chat_thread')).toBe(true);
  });

  it('does not exempt a connector tool that merely ends the same way', () => {
    // `alias__open_chat_thread` is somebody else's tool reaching somebody else's
    // system. Exempting it by coincidence of spelling is the over-broad match
    // the bookkeeping list beside it was careful to avoid.
    expect(isOwnWorkspaceChatTool('some_vendor__open_chat_thread')).toBe(false);
  });

  it('exempts the request for the person to take the browser over, which lands in the pane beside the chat', () => {
    expect(isOwnWorkspaceChatTool('ask_person_to_take_over_browser_session')).toBe(true);
    expect(isOwnWorkspaceChatTool('mcp__liftoff-tool-gateway__ask_person_to_take_over_browser_session')).toBe(true);
    // Reading the page or acting on it is not a message to the workspace.
    for (const t of ['read_browser_session_controls', 'act_in_browser_session', 'read_browser_session_activity']) {
      expect(isOwnWorkspaceChatTool(t)).toBe(false);
    }
  });

  it('exempts notifications_send, which reaches the same people', () => {
    // It can be delivered as email, which reads as leaving and is not. Every
    // recipient form it accepts is a workspace identity — `user:<account_id>`,
    // `role:admin`, `agent:<id>` resolving to that agent's owner — with no way
    // to address a raw mailbox. What decides this gate is who receives it, not
    // which pipe it travels down.
    expect(isOwnWorkspaceChatTool('notifications_send')).toBe(true);
  });

  it('does not exempt the genuinely outbound tools this gate exists for', () => {
    for (const t of ['my_gmail__send_email', 'github__create_review', 'slack_send_message']) {
      expect(isOwnWorkspaceChatTool(t)).toBe(false);
    }
  });

  it('is a separate list from the bookkeeping one, not an extension of it', () => {
    // Those two never leave the process; this one reaches a person. Same
    // treatment at this gate, different reasons, so they stay distinguishable.
    expect(isInProcessBookkeepingTool('open_chat_thread')).toBe(false);
    expect(isOwnWorkspaceChatTool('record_step_output')).toBe(false);
  });
});

// ── the ratchet ──────────────────────────────────────────────────────────────
//
// This list went stale the day after it was written. `notify_team` shipped as
// "the destination that always exists", and the exemption — added two days
// later, for exactly the failure it prevents — did not include it, because it
// was written from a checkout that predated the tool. Nothing failed. The gate
// simply went on asking permission for a team to speak to its own people.
//
// So the classification is no longer optional. Every tool the model can call is
// read out of its registration site and must be classified: exempt because it
// lands on a Liftoff surface only this workspace can read, or listed below as
// not one. A tool that is neither fails here, on the commit that adds it,
// naming itself.
describe('every registered tool is classified against the workspace-audience rule', () => {
  const REGISTRATION_SITES = [
    'src/tools/standard-tools.ts',
    'src/tool-gateway/mcp-server.ts',
  ];

  /** Tools that do NOT land on a Liftoff-owned surface reserved to this
   *  workspace's people. Most reach no person at all; the rest reach one
   *  somewhere this workspace does not own. Neither is a reason to skip the
   *  gate, so neither is exempt. */
  const NOT_A_WORKSPACE_DESTINATION = new Set([
    '__fail_once__', 'act_in_browser_session', 'audit_log', 'cancel_followup', 'cancel_wake',
    'capability_search',
    'check_browser_intervention_pending', 'code_session', 'corpus_search',
    'data_landscape', 'dataset_extract', 'dataset_list', 'dataset_query',
    'delegate_task', 'delegate_to_agent',
    'fetch_browser_download', 'find_teammates', 'get_browser_session_stats',
    'have_i_acted_on', 'list_browser_downloads', 'memory_retrieve',
    'memory_save', 'navigate_browser_session', 'note_delete', 'note_list',
    'bring_in_colleague', 'note_save', 'propose_routine', 'read_active_browser_session',
    'read_agent_messages', 'read_browser_session_activity', 'read_browser_session_controls',
    'check_browser_task',
    'read_conversation_history', 'read_skill', 'recall_conversations',
    'report_task_outcome', 'review_recent_activity', 'run_browser_task', 'run_capability', 'run_routine_now',
    'work_on_this_in_the_background',
    'save_active_browser_page_as_pdf', 'schedule_followup', 'screenshot_browser_session',
    'search', 'send_agent_message', 'sleep_until', 'spawn_child_task',
    'spawn_task_graph', 'start_browser_session', 'tabular_enumerate',
    'tabular_extract', 'task_ledger_write', 'wake_on_all', 'wake_on_any',
    'wake_on_event', 'wake_on_job', 'wake_on_poll', 'web_deep_research',
    'web_diff', 'web_extract', 'web_fetch_advanced', 'web_finance_search',
    'web_identity_connect', 'web_people_search', 'web_research', 'web_search',
    'web_session_close', 'web_session_forget', 'web_session_list',
    'web_session_save', 'web_task', 'web_x_search',
  ]);

  function registeredToolNames(): string[] {
    const names = new Set<string>();
    for (const site of REGISTRATION_SITES) {
      const source = readFileSync(resolve(__dirname, '../../..', site), 'utf8');
      for (const m of source.matchAll(/name: '([a-z_0-9]+)',/g)) names.add(m[1]);
    }
    return [...names].sort();
  }

  it.each(registeredToolNames())('%s is classified', (name) => {
    const exempt = isOwnWorkspaceChatTool(name);
    const declaredElsewhere = NOT_A_WORKSPACE_DESTINATION.has(name);
    // Exactly one, never both and never neither: a tool listed as no
    // destination while the gate exempts it means the two disagree about the
    // same tool, which is how a wrong answer survives a passing test.
    expect(exempt !== declaredElsewhere).toBe(true);
  });
});
