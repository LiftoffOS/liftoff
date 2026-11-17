// A chat stream cannot be ended without its terminal frame.
//
// EOF is byte-identical to a socket that died mid-turn, so every chat stream ends
// with one explicit `event: done` frame and the client
// (Liftoff-React/src/services/chatSse.ts) reports its ABSENCE at EOF as
// STREAM_TRUNCATED. That contract was written down in both routers that broke
// it: the guarantee lived in a `finally` attached to one `try`, and the exits
// ABOVE the try bypassed it. `interrupt_delivered` is such an exit on Liftoff and
// Insights, so steering a running turn raised "The connection dropped before the
// reply finished arriving." every single time, on a message that had been
// delivered.
//
// The reason a comment could not hold the line is structural: the socket was a
// raw `res` that any code path could end, and the path carrying the guarantee was
// simply the one that happened to run last on the happy route. So the routers
// hold a ChatStream instead (src/common/chat-stream.ts) and this is what keeps
// them holding it.
//
// It walks the TypeScript AST rather than grepping, because `res.end` inside a
// string or a comment is not an exit and a ratchet that cannot tell the
// difference gets switched off.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as ts from 'typescript';

/**
 * The chat stream routers, named ONE BY ONE.
 *
 * Deliberately not a glob over every file named `stream-router.ts`:
 * `src/browser-sessions/stream-router.ts` is a different protocol with a
 * different client and no `done` frame in its vocabulary, and a pattern that
 * swept it in would have to be relaxed until it caught nothing. A new chat
 * surface is added here by hand, which is the point — somebody has to decide
 * that its stream is a chat stream.
 */
const CHAT_STREAM_ROUTERS = [
  'src/liftoff/stream-router.ts',
  'src/insights/stream-router.ts',
  'src/agent-chat/stream-router.ts',
];

/** `res.end(...)` / `res.write(...)` and the same on any response alias. */
const FORBIDDEN_METHODS = new Set(['end', 'write']);

/** Identifiers that name an HTTP response in these files. */
const RESPONSE_NAMES = new Set(['res', 'response']);

interface Finding {
  file: string;
  line: number;
  text: string;
}

function findRawResponseWrites(repoRoot: string, file: string): Finding[] {
  const abs = path.join(repoRoot, file);
  const source = fs.readFileSync(abs, 'utf8');
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Finding[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      const receiver = node.expression.expression;
      if (
        FORBIDDEN_METHODS.has(method)
        && ts.isIdentifier(receiver)
        && RESPONSE_NAMES.has(receiver.text)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        found.push({
          file,
          line: line + 1,
          text: node.getText(sf).split('\n')[0].trim(),
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return found;
}

describe('every chat stream ends through the wrapper', () => {
  const repoRoot = process.cwd();

  it('names routers that exist, so a rename cannot silently empty the list', () => {
    // A ratchet over a list of paths is only as good as the paths. A file moved
    // or renamed would otherwise take its own enforcement with it and report
    // zero findings, forever.
    for (const file of CHAT_STREAM_ROUTERS) {
      expect(fs.existsSync(path.join(repoRoot, file))).toBe(true);
    }
  });

  it('writes no frame and ends no socket on the raw response', () => {
    const findings = CHAT_STREAM_ROUTERS.flatMap((f) => findRawResponseWrites(repoRoot, f));
    if (findings.length > 0) {
      throw new Error(
        `${findings.length} raw response write(s) in a chat stream router:\n\n`
        + findings.map((f) => `  ${f.file}:${f.line}  ${f.text}`).join('\n')
        + '\n\nA stream ended on the raw response can be ended WITHOUT its terminal\n'
        + '`done` frame, and the client cannot tell that from a socket that died\n'
        + 'mid-turn: it reports STREAM_TRUNCATED and the person is told the\n'
        + 'connection dropped. That is exactly what `interrupt_delivered` did on\n'
        + 'Liftoff and Insights — on a message that HAD been delivered — for as\n'
        + 'long as the guarantee lived in a `finally` that early exits skipped.\n\n'
        + 'Use the ChatStream from src/common/chat-stream.ts instead:\n'
        + '  openChatStream(res)  — sets the SSE headers and flushes them\n'
        + '  stream.send(event, data)\n'
        + '  stream.comment(text) — an SSE comment line, for the heartbeat\n'
        + '  stream.end()         — writes `done` exactly once, then closes\n'
        + '  stream.ended         — we finished, OR the client left\n',
      );
    }
  });

  it('sees a violation when there is one', () => {
    // The checker's own test. A ratchet that cannot fail is a ratchet nobody
    // knows is broken — and this one's whole job is to be silent until the day
    // somebody adds a write back.
    // Written OUTSIDE the repo, deliberately. `reachability.test.ts` walks src/
    // for exported symbols with no caller, and jest runs suites in parallel
    // workers — a probe file living under src/ for the length of one assertion
    // is a flake in a sibling suite, arriving as a phantom orphan export.
    const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-ratchet-'));
    const tmp = path.join(probeDir, 'probe.ts');
    fs.writeFileSync(
      tmp,
      [
        '// A comment mentioning res.end() must not count.',
        'const notCode = "res.write(\'event: done\')";',
        'export function handler(res: { end: () => void; write: (s: string) => void }): void {',
        '  res.write(\': heartbeat\\n\\n\');',
        '  res.end();',
        '  void notCode;',
        '}',
      ].join('\n'),
      'utf8',
    );
    try {
      const findings = findRawResponseWrites(probeDir, 'probe.ts');
      expect(findings.map((f) => f.text.slice(0, 9))).toEqual(['res.write', 'res.end()']);
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  });
});
