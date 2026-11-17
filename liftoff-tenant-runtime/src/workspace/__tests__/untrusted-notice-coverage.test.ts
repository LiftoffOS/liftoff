// Every model-facing prompt that can receive a framed payload must carry the
// rule that explains the frame.
//
// The frame is a pair of delimiters and a source line. It proves where untrusted
// content starts and stops; it does not say what to do about it. That sentence
// used to be repeated inside every payload, which is why no prompt needed it —
// moving it into the prompts is what makes the per-payload copy removable, and
// a prompt that did not get it would show the model delimiters nothing accounts
// for. There are four such prompts in this service and they are assembled in
// three files, so "add it in the obvious place" reaches one of them.
//
// The enumeration rides AGENT_VOICE_BLOCK rather than a hand-kept list. That
// block is in exactly the set we care about — every prompt whose output or input
// faces a person or a tool result — and it is already maintained, because it had
// this same defect first: autonomous runs carried no voice rules for months
// while chat did. Anything that earns the voice block earns this too, so a fifth
// prompt fails here on the day it is written rather than on the day somebody
// reads a transcript and wonders what <UNTRUSTED_…_BEGIN> was.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

import { buildAgentChatSystemPrompt } from '../../interactive-chat/system-prompt';
import { buildRecoveryPrompt } from '../../agent-execution/engine/recovery-prompts';
import { UNTRUSTED_CONTENT_NOTICE } from '../untrusted-content-wrapper';

const SRC = join(__dirname, '..', '..');

/** The module that DEFINES the voice block, and the one that re-exports it, are
 *  not prompts. Tests are not prompts either. */
const NOT_A_PROMPT = new Set(['agent-voice.ts']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    if (NOT_A_PROMPT.has(entry)) continue;
    out.push(full);
  }
  return out;
}

/** Uses of a symbol in real code: the import line does not assemble a prompt,
 *  and neither does a sentence about one.
 *
 *  Block comments are stripped for the same reason `//` always was, and the
 *  direction that matters is the second: an inflated `voice` count is a false
 *  alarm somebody investigates, but a JSDoc line naming UNTRUSTED_CONTENT_NOTICE
 *  inflates `notice` and HIDES a real gap. Counting prose as assembly was wrong
 *  both ways round. */
function useCount(src: string, symbol: string): number {
  return src
    .split('\n')
    .map((line) => line.trimStart())
    .filter((line) => !line.startsWith('import'))
    .filter((line) => !line.startsWith('//'))
    // A JSDoc or block-comment body line. No statement begins with `*`.
    .filter((line) => !line.startsWith('*') && !line.startsWith('/*'))
    .filter((line) => line.includes(symbol))
    .length;
}

describe('the counter counts assembly, not prose', () => {
  // `useCount` is the whole enumeration, so what it decides to count IS the
  // check. It stripped `//` comments and not block comments, which was wrong in
  // both directions: a JSDoc line naming AGENT_VOICE_BLOCK invented a prompt
  // that does not exist, and one naming UNTRUSTED_CONTENT_NOTICE would have
  // hidden a prompt that does.
  const countIn = (src: string, symbol: string): number =>
    src
      .split('\n')
      .map((line) => line.trimStart())
      .filter((line) => !line.startsWith('import'))
      .filter((line) => !line.startsWith('//'))
      .filter((line) => !line.startsWith('*') && !line.startsWith('/*'))
      .filter((line) => line.includes(symbol))
      .length;

  it('ignores a symbol named in a JSDoc block', () => {
    expect(countIn('/**\n * governed by AGENT_VOICE_BLOCK on the same prompt.\n */', 'AGENT_VOICE_BLOCK'))
      .toBe(0);
  });

  it('ignores a symbol named in a line comment or an import', () => {
    expect(countIn("// beside AGENT_VOICE_BLOCK\nimport { AGENT_VOICE_BLOCK } from './x';", 'AGENT_VOICE_BLOCK'))
      .toBe(0);
  });

  it('still counts the assembly line itself', () => {
    expect(countIn('    const prompt = [\n      AGENT_VOICE_BLOCK,\n    ];', 'AGENT_VOICE_BLOCK')).toBe(1);
  });
});

describe('the untrusted-content rule reaches every prompt that needs it', () => {
  it('is assembled wherever the voice block is', () => {
    const gaps: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      const voice = useCount(src, 'AGENT_VOICE_BLOCK');
      if (voice === 0) continue;

      const notice = useCount(src, 'UNTRUSTED_CONTENT_NOTICE');
      if (notice < voice) {
        gaps.push(
          `  - ${file.slice(SRC.length + 1)}: ${voice} prompt(s) carry the voice block, `
          + `${notice} carry the untrusted-content rule`,
        );
      }
    }

    if (gaps.length > 0) {
      throw new Error(
        `Prompts that can receive a framed tool result but do not explain the frame:\n${gaps.join('\n')}\n\n`
        + 'Every prompt on a path that reaches the tool gateway sees <UNTRUSTED_…_BEGIN> '
        + 'delimiters. The rule about them lives in UNTRUSTED_CONTENT_NOTICE '
        + '(workspace/untrusted-content-wrapper.ts) and is added once per prompt, beside '
        + 'AGENT_VOICE_BLOCK.',
      );
    }
  });

  it('the interactive chat prompt renders it', () => {
    // Rendered rather than grepped: the grep above proves the symbol is present,
    // this proves it survives into the string the model actually reads.
    const prompt = buildAgentChatSystemPrompt({
      agent: { role: 'Support', messagingNickname: null, systemPrompt: null, userInstructions: null },
      user: { displayName: 'Ada', role: 'admin' },
      channel: 'web',
      hitlLevel: 3,
      connectorList: '(none)',
      memoryBlock: '',
      priorInvocationSummary: null,
    });

    expect(prompt).toContain(UNTRUSTED_CONTENT_NOTICE);
  });

  it('the recovery advisor prompt renders it', () => {
    const prompt = buildRecoveryPrompt(
      {
        kind: 'tool_error',
        step: { stepId: 's1', type: 'tool_call', description: 'read the ticket', toolName: 'slack__list_messages' },
        error: 'boom',
      } as unknown as Parameters<typeof buildRecoveryPrompt>[0],
      [],
      { rows: [] },
      's1',
      [],
      0,
      0,
    );

    expect(prompt).toContain(UNTRUSTED_CONTENT_NOTICE);
  });
});
