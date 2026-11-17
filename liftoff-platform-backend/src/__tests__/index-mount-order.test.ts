// Every router must be imported before the line that mounts it.
//
// index.ts uses inline imports throughout — `import { x } from './y'` sitting
// beside the `app.use` that needs it — which reads well and is fine until a
// mount is added ABOVE its import. TypeScript compiles that happily, and the
// binding lands in its temporal dead zone at mount time, so the container dies
// at boot:
//
//   ReferenceError: Cannot access 'router_29' before initialization
//       at Object.<anonymous> (/app/dist/index.js:243:40)
//
// That is exactly what happened when the /api/internal mounts were first added:
// lint passed, tsc passed, all 5,808 tests passed, and the Cloud Run deploy
// failed its startup probe. Nothing in the suite executes index.ts, so nothing
// noticed the app could not start.
//
// This is a cheap static stand-in for a boot test: it reads index.ts, finds
// every identifier handed to app.use(), and fails if the import that binds it
// appears later in the file.
import { readFileSync } from 'fs';
import { join } from 'path';

const INDEX = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
const LINES = INDEX.split('\n');

/** Line number where an identifier is first bound by an import, or -1. */
function importLineOf(identifier: string): number {
  return LINES.findIndex(
    (l) =>
      /^\s*import\s/.test(l) &&
      new RegExp(`[{,]\\s*${identifier}\\s*[},]`).test(l),
  );
}

/** Identifiers passed as middleware/router arguments to app.use(). */
function mountedIdentifiers(): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  LINES.forEach((line, i) => {
    const call = line.match(/^app\.use\((.*)\)\s*;?\s*$/);
    if (!call) return;
    for (const arg of call[1].split(',').map((a) => a.trim())) {
      // Skip path strings, inline functions and call expressions.
      if (!/^[A-Za-z_$][\w$]*$/.test(arg)) continue;
      out.push({ name: arg, line: i });
    }
  });
  return out;
}

describe('index.ts mount order', () => {
  const mounts = mountedIdentifiers();

  it('finds mounts to check, so this cannot pass vacuously', () => {
    expect(mounts.length).toBeGreaterThan(20);
  });

  // Body-parser order is the same class of defect: static, invisible to lint and
  // tsc, and only observable as a runtime failure on a request nobody makes in
  // the test suite. body-parser is a no-op once req.body is set, so a
  // route-specific limit only applies if it is mounted BEFORE the general
  // express.json(). Mounted after, it is dead code that reads like a raised
  // limit — and a Switch bundle of a few imported team members exceeds the
  // general 5 MB default and dies with a bare 413.
  it('mounts the Switch bundle parser before the general json parser', () => {
    const bundleParser = LINES.findIndex(
      (l) => l.includes("'/api/source-migrations/:id/bundle'") && l.includes('express.json'),
    );
    const generalParser = LINES.findIndex((l) => /^app\.use\(express\.json\(/.test(l.trim()));

    expect(bundleParser).toBeGreaterThan(-1);
    expect(generalParser).toBeGreaterThan(-1);
    expect(bundleParser).toBeLessThan(generalParser);
  });

  it('gives the Switch bundle route a larger limit than the general one', () => {
    // A limit equal to or below the general one would make the whole mount
    // pointless while looking deliberate.
    const limitOf = (line: string) => {
      const m = line.match(/limit:\s*'(\d+)mb'/);
      return m ? Number(m[1]) : -1;
    };
    const bundle = LINES.find(
      (l) => l.includes("'/api/source-migrations/:id/bundle'") && l.includes('express.json'),
    );
    const general = LINES.find((l) => /^app\.use\(express\.json\(/.test(l.trim()));

    expect(limitOf(bundle ?? '')).toBeGreaterThan(limitOf(general ?? ''));
  });

  it('imports every mounted router before the line that mounts it', () => {
    const tooLate = mounts
      .map(({ name, line }) => ({ name, line, importedAt: importLineOf(name) }))
      // Locally declared (not imported) values are out of scope for this check.
      .filter((m) => m.importedAt !== -1 && m.importedAt > m.line)
      .map((m) => `${m.name}: mounted at line ${m.line + 1}, imported at ${m.importedAt + 1}`);

    expect(tooLate).toEqual([]);
  });
});
