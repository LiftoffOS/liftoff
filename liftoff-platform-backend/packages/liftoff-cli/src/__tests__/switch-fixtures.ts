// Synthetic fixture builders for the adapter tests.
//
// IMPORTANT — these are NOT the primary fixtures the plan calls for. Primary
// fixtures are HARVESTED from real installations of OpenClaw and Hermes at
// their pinned revisions (see scripts/switch-harvest/), because a fixture
// authored from the same reading as the adapter shares the adapter's
// misunderstandings and proves nothing about the real layout.
//
// What these builders are for is the mechanical properties that do not depend
// on the real layout being right: containment, bounds, redaction, packing,
// determinism, and the do-not-import rules. They run in CI with no network and
// no installed product.

import fs from 'fs';
import os from 'os';
import path from 'path';

/** Credential-shaped strings follow the house style from
 *  src/common/__tests__/redact.test.ts: the real prefix as a plain literal, the
 *  high-entropy body generated. The importer must meet realistic shapes, but a
 *  complete literal in source trips push protection and buries a future real
 *  leak among our decoys.
 *
 *  Each body is a distinct repeated character so a failing assertion names
 *  which fixture leaked. */
export const FAKE_ANTHROPIC_KEY = 'sk-ant-api03-' + 'm'.repeat(64);
export const FAKE_GITHUB_TOKEN = 'ghp_' + 'n'.repeat(36);
export const FAKE_ENV_ANTHROPIC = 'sk-ant-api03-' + 'p'.repeat(64);
export const FAKE_SLACK_TOKEN = 'xoxb-111111111-222222222-' + 'q'.repeat(30);
export const FAKE_HERMES_SLACK = 'xoxb-999999999-888888888-' + 'r'.repeat(30);

export interface FixtureHandle {
  root: string;
  cleanup: () => void;
}

export function makeTempRoot(prefix: string): FixtureHandle {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  return {
    root,
    cleanup: () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

export function write(root: string, rel: string, content: string): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

/** A default OpenClaw installation with two persistent agents, skills,
 *  memories, cron jobs, an HTTP MCP server, a stdio MCP server, and files
 *  containing fake credentials. */
export function buildOpenClawFixture(): FixtureHandle {
  const handle = makeTempRoot('openclaw-fixture');
  const { root } = handle;

  write(
    root,
    'openclaw.json',
    JSON.stringify(
      {
        version: '2026.8.1',
        workspace: 'workspace',
        agents: {
          research: {
            name: 'Research',
            model: 'claude-sonnet-5',
            provider: 'anthropic',
            channels: ['slack', 'github'],
            mcpServers: ['mcp:reporting', 'mcp:localtools'],
            canDelegateTo: ['triage'],
          },
          triage: {
            name: 'Triage',
            model: 'claude-haiku-4-5',
            channels: ['slack'],
            canDelegateTo: ['ghost-worker'],
          },
        },
        mcpServers: {
          reporting: {
            url: 'https://mcp.example.com/reporting',
            headers: { Authorization: `Bearer ${FAKE_ANTHROPIC_KEY}` },
          },
          localtools: { command: 'npx', args: ['-y', '@acme/local-mcp'] },
        },
        // An unrecognised field: reported by NAME only, never by value.
        experimentalTelemetry: { endpoint: 'https://telemetry.example.com', apiKey: 'sk-live-nope' },
      },
      null,
      2,
    ),
  );

  write(root, 'workspace/AGENTS.md', '# Workspace rules\nAlways cite sources.\n');

  write(
    root,
    'agents/research/agent/AGENTS.md',
    '# Research\nYou research competitors and write briefs.\n' +
      `Credential for the old system: ${FAKE_GITHUB_TOKEN}\n`,
  );
  write(root, 'agents/research/agent/SOUL.md', 'Be precise. Prefer primary sources.\n');
  write(root, 'agents/research/agent/MEMORY.md', '- The Q3 board deck is in Drive.\n');
  write(root, 'agents/research/agent/memory/2026-08-01.md', '- Competitor X raised a round.\n');
  // Current upstream layout (2026.9.3): a directory per skill holding SKILL.md,
  // with support directories beside it. The support files belong to the skill;
  // they are not skills, which is what naming a file for its parent directory
  // used to make them.
  write(
    root,
    'agents/research/agent/skills/brief-writing/SKILL.md',
    '# Brief writing\nOne page maximum.\n',
  );
  write(
    root,
    'agents/research/agent/skills/brief-writing/references/style-guide.md',
    '# Style guide\nActive voice. No hedging.\n',
  );
  write(
    root,
    'agents/research/agent/skills/brief-writing/examples/q3-brief.md',
    '# Example brief\nQ3 in one page.\n',
  );

  write(root, 'agents/triage/agent/AGENTS.md', '# Triage\nYou triage inbound support.\n');
  // The legacy flat layout, still read by upstream and still imported here.
  write(root, 'agents/triage/agent/skills/severity.md', '# Severity\nP1 means revenue is stopped.\n');

  write(
    root,
    'cron/jobs.json',
    JSON.stringify(
      [
        { id: 'weekly-brief', name: 'Weekly brief', schedule: '0 9 * * 1', prompt: 'Write the weekly brief.', agentId: 'research', enabled: true },
        { id: 'hourly-triage', name: 'Hourly triage', schedule: '@hourly', prompt: 'Triage new tickets.', agentId: 'triage' },
        { id: 'broken', name: 'Broken', prompt: 'No schedule here.' },
      ],
      null,
      2,
    ),
  );

  // Credential material that must never be read.
  write(root, '.env', `ANTHROPIC_API_KEY=${FAKE_ENV_ANTHROPIC}\n`);
  write(root, 'auth/profiles.json', JSON.stringify({ slack: { token: FAKE_SLACK_TOKEN } }));

  return handle;
}

/** A Hermes profile with SOUL, memories, skills, cron jobs, channels and one
 *  registered multi-agent definition plus one transient worker. */
export function buildHermesFixture(): FixtureHandle {
  const handle = makeTempRoot('hermes-fixture');
  const { root } = handle;

  write(
    root,
    'config.yaml',
    [
      'version: "0.9.4"',
      'name: "Ada"',
      'model: "claude-sonnet-5"',
      'provider: "anthropic"',
      'channels:',
      '  slack: {}',
      '  telegram: {}',
      'mcp_servers:',
      '  reporting:',
      '    url: "https://mcp.example.com/reporting"',
      '  localtools:',
      '    command: "uvx"',
      '    args: ["acme-mcp"]',
      'agents:',
      '  analyst:',
      '    name: "Analyst"',
      '    persona: "You analyse revenue data."',
      '    registered: true',
      '  scratch:',
      '    name: "Scratch worker"',
      '    registered: false',
      'unknown_future_field: "value that must not be reported"',
      '',
    ].join('\n'),
  );

  write(root, 'SOUL.md', '# Ada\nYou are careful and concise.\n');
  write(root, 'memories/MEMORY.md', '- The team standup is at 09:30.\n');
  write(root, 'memories/USER.md', '- Prefers bullet points.\n');
  // Current upstream layout (f03ed94): `skills/<category>/<name>/SKILL.md`.
  // Three skills across two categories, one of them carrying support
  // directories. Naming these for the file called all three `SKILL` and the
  // name-keyed dedupe kept one.
  write(root, 'skills/productivity/reporting/SKILL.md', '# Reporting\nAlways include the period.\n');
  write(root, 'skills/productivity/docx/SKILL.md', '# Docx\nEdit documents in place.\n');
  write(
    root,
    'skills/productivity/docx/references/formatting.md',
    '# Formatting\nStyles beat direct formatting.\n',
  );
  write(root, 'skills/media/gif-search/SKILL.md', '# Gif search\nSearch, then attach.\n');
  // The legacy flat layout, still read by upstream and still imported here.
  write(root, 'skills/standup-notes.md', '# Standup notes\nThree bullets, no more.\n');
  write(
    root,
    'cron/jobs.json',
    JSON.stringify([
      { id: 'daily-digest', name: 'Daily digest', schedule: '0 8 * * *', prompt: 'Send the digest.', enabled: true },
    ]),
  );

  write(root, '.env', `HERMES_TOKEN=${FAKE_HERMES_SLACK}\n`);

  return handle;
}

/** An installation whose instruction file is far larger than one attachment,
 *  used to prove overflow moves material rather than dropping it. */
export function buildOversizedOpenClawFixture(chars: number): FixtureHandle {
  const handle = makeTempRoot('openclaw-oversized');
  const { root } = handle;

  write(
    root,
    'openclaw.json',
    JSON.stringify({ version: '2026.8.1', agents: { big: { name: 'Big' } } }),
  );
  write(root, 'agents/big/agent/AGENTS.md', 'A'.repeat(chars));

  return handle;
}


/** A Claude Code installation, modelled on a live one.
 *
 *  Carries the two hazards the adapter is written around: a `settings.json`
 *  whose `env` block holds a credential, and Liftoff's own entries — the
 *  `liftoff` MCP server and `collab.md`, which our own CLI writes and
 *  which must not be imported back. */
export function buildClaudeCodeFixture(): FixtureHandle {
  const handle = makeTempRoot('claude-code-fixture');
  // `~/.claude.json` lives BESIDE the state root, so the fixture root holds
  // both — exactly as a home directory does.
  const root = path.join(handle.root, '.claude');
  fs.mkdirSync(root, { recursive: true });

  write(root, 'CLAUDE.md', '# Global rules\nPlan before non-trivial work.\n');
  write(root, 'rules/gcloud.md', '# gcloud\nUse the liftoff config directory.\n');
  // Written by `liftoff connect`. Importing it hands a workspace its own
  // plumbing back.
  write(root, 'rules/collab.md', '## Liftoff Collaboration\nCall liftoff_read_messages.\n');

  write(
    root,
    'skills/deploy/SKILL.md',
    '---\nname: deploy\ndescription: Ship it\n---\n# Deploy\nRun the checks first.\n',
  );
  write(root, 'skills/deploy/scripts/check.sh', '#!/bin/sh\necho ok\n');
  write(root, 'skills/deploy/references/runbook.md', '# Runbook\nRoll back with the previous tag.\n');
  // Not text: nothing can scan it, so it cannot travel.
  write(root, 'skills/deploy/assets/logo.png', 'PNG binary bytes');

  write(root, 'commands/review.md', '# Review\nRead the diff, not the message.\n');

  write(root, 'agents/code-reviewer.md', '---\nname: code-reviewer\n---\nYou review diffs.\n');
  write(root, 'agents/release-manager.md', '---\nname: release-manager\n---\nYou run releases.\n');

  write(root, 'projects/-Users-someone-repo/memory/MEMORY.md', '- [Index line](a.md)\n');
  write(
    root,
    'projects/-Users-someone-repo/memory/prefers-bullets.md',
    '---\nname: prefers-bullets\ntype: feedback\n---\nThey prefer bullet points.\n',
  );
  write(
    root,
    'projects/-Users-someone-repo/memory/deploy-cadence.md',
    '---\nname: deploy-cadence\ntype: project\n---\nDev deploys on push to main.\n',
  );

  write(
    root,
    'settings.json',
    JSON.stringify(
      {
        model: 'claude-fable-5',
        effortLevel: 'high',
        // The known secret surface: Liftoff's own CLI writes a key here.
        env: {
          ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
          ANTHROPIC_BASE_URL: 'https://api.example.com/proxy',
        },
        hooks: { PreToolUse: [{ command: '~/scripts/guard.sh' }] },
        permissions: {
          allow: ['Bash(npm test)', 'Bash(git status)'],
          deny: ['Bash(rm -rf /)'],
          ask: ['Bash(git push)'],
        },
      },
      null,
      2,
    ),
  );

  write(
    handle.root,
    '.claude.json',
    JSON.stringify(
      {
        lastReleaseNotesSeen: '2.0.31',
        mcpServers: {
          context7: { type: 'http', url: 'https://mcp.context7.com/mcp' },
          // Ours. Never imported back.
          liftoff: {
            type: 'http',
            url: 'https://api.example.com/mcp',
            headers: { Authorization: `Bearer ${FAKE_GITHUB_TOKEN}` },
          },
          localtools: { command: 'npx', args: ['-y', '@acme/local-mcp'] },
          github: { type: 'http', url: 'https://api.githubcopilot.com/mcp/' },
        },
        projects: { '/Users/someone/repo': { hasTrustDialogAccepted: true } },
      },
      null,
      2,
    ),
  );

  return { root, cleanup: handle.cleanup };
}

/** A Codex installation, modelled on a live one — including the ChatGPT
 *  desktop app's own plumbing, which shares `~/.codex` and has to be filtered
 *  out rather than reported. */
export function buildCodexFixture(): FixtureHandle {
  const handle = makeTempRoot('codex-fixture');
  const { root } = handle;

  write(root, 'version.json', JSON.stringify({ version: '0.52.0' }));

  write(
    root,
    'config.toml',
    [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "medium"',
      'personality = "pragmatic"',
      'approval_policy = "on-request"',
      'sandbox_mode = "workspace-write"',
      'notify = ["/Users/someone/.codex/computer-use/Client", "turn-ended"]',
      '',
      '[marketplaces.openai-bundled]',
      'source_type = "local"',
      'source = "/Users/someone/.codex/.tmp/bundled-marketplaces/openai-bundled"',
      '',
      '[plugins."browser@openai-bundled"]',
      'enabled = true',
      '',
      '[projects."/Users/someone/repo"]',
      'trust_level = "trusted"',
      '',
      '[desktop]',
      'conversationDetailMode = "STEPS_PROSE"',
      '',
      '[mcp_servers.node_repl]',
      'command = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node_repl"',
      'args = []',
      '',
      '[mcp_servers.computer-use]',
      'command = "./Codex Computer Use.app/Contents/SharedSupport/Client"',
      'args = ["mcp"]',
      'enabled = false',
      '',
      '[mcp_servers.openaiDeveloperDocs]',
      'url = "https://developers.openai.com/mcp"',
      '',
      '[mcp_servers.localtools]',
      'command = "uvx"',
      'args = ["acme-mcp"]',
      '',
    ].join('\n'),
  );

  write(root, 'AGENTS.md', '# Codex rules\nSmall diffs. Explain the why.\n');
  write(
    root,
    'skills/pdf/SKILL.md',
    '---\nname: pdf\ndescription: Read PDFs\n---\n# PDF\nExtract text first.\n',
  );
  write(root, 'skills/pdf/scripts/extract.py', 'print("extract")\n');
  write(root, 'prompts/triage.md', '# Triage\nSeverity first.\n');

  write(
    root,
    'rules/default.rules',
    [
      'prefix_rule(pattern=["npm", "test"], decision="allow")',
      'prefix_rule(pattern=["rm", "-rf"], decision="deny")',
      '',
    ].join('\n'),
  );

  // Never read.
  write(root, 'auth.json', JSON.stringify({ token: FAKE_ANTHROPIC_KEY }));
  write(root, 'history.jsonl', '{"session":"x"}\n');

  return handle;
}
