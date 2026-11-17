// Model-facing text uses the product's own words (INV-PB-016).
//
// The product calls the software that does the work an "agent", the word the
// rest of the ecosystem uses, and one from outside the workspace an "external
// agent". This test bans the earlier coined nouns, "AI team" and "external
// collaborator", and bare "team", which really is ambiguous between people and
// software.
//
// The three platform assistants and every agent are handed one vocabulary rule
// (AGENT_VOICE_BLOCK): the software is an "agent", one from outside the
// workspace is an "external agent", the people are "people", and "team" on its
// own is a mix of the two. The rule alone does not hold. An assistant will say
// "I bind it to the team" and "I give the team a private sandbox" when the
// prompt around the rule says "the team" as often as the product noun and its
// tool descriptions say it dozens of times more, because a model follows the
// demonstration over the instruction. Nothing read the vocabulary of what the
// model was actually shown.
//
// This does. It renders what each assistant reads, the same way the chat services
// render it (the system prompt with every tool the caller could be offered listed
// in it, plus each workspace action's parameter descriptions, which the prompt
// does not carry but the tools array does), and asserts that none of it says
// "team" on its own, "AI team" or "external collaborator". Identifiers are not
// prose: tool names, argument keys and anything in backticks or a fenced block
// are skipped. Quoted mentions of the banned words in a rule ("never \"AI
// team\"") are allowed, and so is the one sentence that defines the bare word.
//
// Zero tolerance rather than a ratchet with a baseline: the change that added this
// cleared every surface, and a baseline would only record where the next "the team"
// is allowed to live.

import { readFileSync } from 'fs';
import { join } from 'path';
import { AGENT_VOICE_BLOCK } from '../shared/agent-voice';
import { buildLiftoffSystemPrompt } from '../liftoff/system-prompt';
import { listColleaguesTool, bringInColleagueTool } from '../liftoff/delegation-targets';
import { capabilitySearchTool, runCapabilityTool } from '../liftoff/capability-tools';
import { datasetTools } from '../datasets/tools';
import { chatRecallTools } from '../chat-recall/tools';
import { BROWSER_ASSISTANT_TOOLS } from '../browser-sessions/assistant-tools';
import { WORKSPACE_ACTION_TOOLS } from '../workspace-actions/tools';
import { buildInsightsSystemPrompt, registerInsightsTools } from '../insights/tools';
import { getToolDefinitionsForRole } from '../insights/tools/dispatcher';
import type { TenantMemberRole } from '../tenant-members/types';

/** "team", "teams" or "Team" not preceded by "AI " and not inside an identifier. */
const BARE_TEAM = /(?<!\bAI )(?<![A-Za-z_])(?:team|teams|Team)(?![A-Za-z_])/g;
/** The retired noun. Both casings, singular and plural. */
const AI_TEAM = /\bAI teams?\b/gi;
/** The retired name for an agent from outside the workspace. */
const EXTERNAL_COLLABORATOR = /\bexternal collaborators?\b/gi;

/** Text that legitimately carries the bare word. Kept short on purpose. */
const ALLOWED: RegExp[] = [
  /Microsoft Teams/g,
  /Teams page/g,
  /Teams tab/g,
  /team plan/g, // the Chief AI Officer's thread kind, as the product names it
  /"(?:team|teams|agent|agents|team members|AI team|AI teams|external collaborator)"/g, // the word itself, quoted, inside a rule
  /[Aa] team is people and agents together/g, // the definition of the bare word
];

function prose(text: string): string {
  let t = text.replace(/```[\s\S]*?```/g, '');
  t = t.replace(/`[^`\n]*`/g, '');
  for (const a of ALLOWED) t = t.replace(a, '');
  return t;
}

function vocabularyFindings(text: string): string[] {
  const t = prose(text);
  const out: string[] = [];
  for (const re of [BARE_TEAM, AI_TEAM, EXTERNAL_COLLABORATOR]) {
    for (const m of t.matchAll(re)) {
      const at = m.index ?? 0;
      out.push(t.slice(Math.max(0, at - 60), at + m[0].length + 40).replace(/\n/g, ' '));
    }
  }
  return out;
}

/** Every description a tool definition carries: the tool's own and each parameter's. */
function descriptionsOf(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'description' && typeof v === 'string') out.push(v);
    else out.push(...descriptionsOf(v));
  }
  return out;
}

const ROLES: TenantMemberRole[] = ['owner', 'admin', 'member', 'viewer'];

describe('model-facing text uses the product\'s own words', () => {
  it('the scanner sees what it is meant to see', () => {
    // Bare "team" and the retired "AI team" are both violations; "agent" is now
    // the word the product uses and must NOT be flagged.
    expect(vocabularyFindings('Tell the team to start the AI team.')).toHaveLength(2);
    expect(vocabularyFindings('Hand it to an external collaborator.')).toHaveLength(1);
    expect(vocabularyFindings('Tell the agent to start the agents.')).toHaveLength(0);
    // Identifiers are not prose, so `team_get`, teamId and team_status survive a
    // vocabulary change. That is deliberate: this fixture is what proves the
    // scanner still skips identifiers, and it keeps working whether or not those
    // particular symbols are ever renamed.
    expect(vocabularyFindings('Say "agent", never "team". Use `team_get`, teamId and team_status.')).toHaveLength(0);
    expect(vocabularyFindings('A team is people and agents together, on the Teams page and in Microsoft Teams.')).toHaveLength(0);
    expect(vocabularyFindings('```\n{"type": "AI team"}\n```')).toHaveLength(0);
  });

  it('the canonical voice block', () => {
    expect(vocabularyFindings(AGENT_VOICE_BLOCK)).toEqual([]);
  });

  /** What Liftoff's own `AVAILABLE_TOOLS` is built from, by the name each
   *  entry is spread or listed under. The list below has to stay equal to it,
   *  and the assertion after this one is what makes that true rather than
   *  hoped for: `datasetTools` was added to the service and not to this test,
   *  so three tool descriptions went onto Liftoff's surface unchecked by an
   *  invariant that describes itself as zero tolerance. */
  const LIFTOFF_TOOL_SOURCES = [
    'listColleaguesTool',
    'bringInColleagueTool',
    'capabilitySearchTool',
    'runCapabilityTool',
    'datasetTools',
    'generatedFileTools',
    'trackedGoalTools',
    'backgroundWorkTools',
    'chatRecallTools',
    'BROWSER_ASSISTANT_TOOLS',
  ];

  it('Liftoff: the system prompt with every tool it can be offered', () => {
    const availableTools = [
      listColleaguesTool,
      bringInColleagueTool,
      capabilitySearchTool,
      runCapabilityTool,
      ...datasetTools,
      ...chatRecallTools,
      ...BROWSER_ASSISTANT_TOOLS,
      // Not in AVAILABLE_TOOLS: they reach the turn through toolsForActor.
      ...WORKSPACE_ACTION_TOOLS.map((t) => t.definition),
    ];
    const prompt = buildLiftoffSystemPrompt({ today: '2026-09-21', availableTools });
    expect(vocabularyFindings(prompt)).toEqual([]);
    expect(vocabularyFindings(descriptionsOf(availableTools).join('\n'))).toEqual([]);
  });

  it('Liftoff: and that list is every tool the service actually offers', () => {
    // Source-pinned because `AVAILABLE_TOOLS` is private to the chat service
    // and exporting it for a test would put a symbol in the graph that no
    // production caller reads. What this catches is the only way the test
    // above can be wrong: a tool added to the service and not to it.
    const source = readFileSync(join(__dirname, '..', 'liftoff', 'chat-service.ts'), 'utf8');
    const literal = source.slice(
      source.indexOf('const AVAILABLE_TOOLS: LLMToolDefinition[] = ['),
      source.indexOf('\n];', source.indexOf('const AVAILABLE_TOOLS: LLMToolDefinition[] = [')),
    );
    expect(literal).not.toBe('');
    const named = literal
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').trim())
      .filter((line) => /^\.{0,3}[A-Za-z_][A-Za-z0-9_]*,$/.test(line))
      .map((line) => line.replace(/^\.{3}/, '').replace(/,$/, ''));
    expect(named).toEqual(LIFTOFF_TOOL_SOURCES);
  });

  it('the Insights Manager: the system prompt with every tool, for every role', () => {
    registerInsightsTools();
    for (const role of ROLES) {
      for (const opts of [{}, { answerOnly: true }, { asColleague: true }]) {
        const availableTools = getToolDefinitionsForRole(role, opts);
        const prompt = buildInsightsSystemPrompt({ today: '2026-09-21', availableTools });
        expect(vocabularyFindings(prompt)).toEqual([]);
        expect(vocabularyFindings(descriptionsOf(availableTools).join('\n'))).toEqual([]);
      }
    }
  });

  it('every workspace action: the description and each parameter\'s', () => {
    const text = WORKSPACE_ACTION_TOOLS
      .map((t) => `${t.definition.name}\n${descriptionsOf(t.definition).join('\n')}`)
      .join('\n');
    expect(vocabularyFindings(text)).toEqual([]);
  });

  // THE CHIEF AI OFFICER'S PROMPT IS A DATABASE ROW, and the four migrations that
  // built it are applied and therefore frozen. 509 seeded it; 512, 515 and 545
  // patched it; all four were written in the retired vocabulary and always will
  // be, because this repo never edits an applied migration. Scanning their text
  // for the new vocabulary would be asking history to have been different.
  //
  // So what is asserted here is the migration that CHANGES the row, 564, and the
  // property asserted is that its substitution is complete in both directions:
  // every retired term is mapped, and the two collective nouns that must survive
  // are named. That is the whole of what a reader of this file can check without
  // a database. The row itself is verified where it can be — inside 564's own
  // DO $verify$ block, which runs against the real prompt at migrate time and
  // counts what is left rather than matching with LIKE.
  it('the Chief AI Officer: migration 564 maps every retired term', () => {
    const sql = readFileSync(join(__dirname, '..', '..', 'migrations', '564_caio_agent_vocabulary.sql'), 'utf8');

    // Each pair the substitution must carry, longest first. The possessive and
    // the plural have to precede the singular or they are swallowed by it.
    for (const [from, to] of [
      ["AI team's", "agent's"],
      ['AI teams', 'agents'],
      ['AI team', 'agent'],
      ['external collaborators', 'external agents'],
      ['external collaborator', 'external agent'],
    ]) {
      expect(sql).toContain(`$a$${from}$a$`);
      expect(sql).toContain(`$b$${to}$b$`);
    }

    // And the two it must NOT touch, asserted by their presence in the migration's
    // own verification block.
    expect(sql).toContain('the AI workforce');
    expect(sql).toContain('the human workforce');
  });

  it('the preamble the distiller writes into every agent\'s own prompt', () => {
    // IC_AGENT_PREAMBLE is module-private in distill-service.ts and stored into
    // internal_agents.system_prompt on every distill; read from the source the way
    // the runtime's voice tests read theirs, rather than exporting it for a test.
    const src = readFileSync(join(__dirname, '..', 'internal-agents', 'distill-service.ts'), 'utf8');
    const m = src.match(/const IC_AGENT_PREAMBLE =\n([\s\S]*?);\n/);
    expect(m).not.toBeNull();
    const literal = m![1].replace(/'\s*\+\s*\n\s*'/g, '').replace(/^\s*'/, '').replace(/'\s*$/, '');
    expect(literal).toContain('operates in two modes');
    expect(vocabularyFindings(literal)).toEqual([]);
  });
});
