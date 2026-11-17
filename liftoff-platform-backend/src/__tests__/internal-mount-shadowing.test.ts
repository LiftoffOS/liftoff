// A router mounted on a prefix that an EARLIER mount already guards is dead code.
//
// `app.use(prefix, middleware, router)` runs `middleware` for every request under
// `prefix` — whether or not `router` has a route that matches. So a later
// `app.use('/api/internal', someRouter)` never sees a request whose path falls
// under an earlier `app.use('/api/internal/x', auth, ...)`: the earlier guard
// answers first, with ITS token, and a caller holding the right token for the
// later router gets 401.
//
// The failure is silent. Mount the workforce connectors proxy at
// '/api/internal/connectors' behind workforceServiceAuth ahead of harvest's
// '/api/internal' mount, and harvest-service — which calls
// GET /api/internal/connectors/:connectorId/tenant with HARVEST_SERVICE_TOKEN to
// answer "does this connector belong to this tenant?" — gets 401 on every call.
// The check fails CLOSED, so every polled connector event is dropped as an
// ownership mismatch and the harvest memory pipeline records nothing. Both
// sides log success at their own layer: connector-service logs `published: 1`,
// PB logs a 401 nobody is reading.
//
// index.ts already carried the lesson in prose, at the account-profiles mount —
// "two routers on one prefix means the auth a request meets depends on mount
// order" — which is exactly the property this test now holds mechanically,
// because a comment cannot fail a build.
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import * as ts from 'typescript';

const INDEX = join(__dirname, '..', 'index.ts');

interface Mount {
  order: number;
  path: string;
  hasMountMiddleware: boolean;
  routerIdent: string | null;
}

/** `app.use(...)` calls, in source order, with a string-literal mount path. */
function collectMounts(source: ts.SourceFile): Mount[] {
  const mounts: Mount[] = [];
  let order = 0;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      node.expression.name.text === 'use' &&
      node.arguments.length >= 2 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      const last = node.arguments[node.arguments.length - 1];
      mounts.push({
        order: order++,
        path: node.arguments[0].text,
        // Everything between the path and the router runs for the whole prefix.
        hasMountMiddleware: node.arguments.length >= 3,
        routerIdent: ts.isIdentifier(last) ? last.text : null,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return mounts;
}

/** identifier -> absolute file path, for local imports only. */
function collectLocalImports(source: ts.SourceFile, fromDir: string): Map<string, string> {
  const map = new Map<string, string>();

  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    if (!ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    if (!spec.startsWith('.')) continue;

    const base = resolve(fromDir, spec);
    const file = [`${base}.ts`, join(base, 'index.ts')].find((p) => existsSync(p));
    if (!file) continue;

    const bindings = stmt.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const el of bindings.elements) map.set(el.name.text, file);
    }
  }
  return map;
}

/** Route paths declared on `ident` in `file` (`ident.get('/x', ...)`). */
function routePathsFor(file: string, ident: string): string[] {
  const text = readFileSync(file, 'utf8');
  const re = new RegExp(
    `\\b${ident}\\.(?:get|post|put|patch|delete|all)\\(\\s*['"\`]([^'"\`]+)['"\`]`,
    'g',
  );
  const out: string[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(m[1]);
  return out;
}

function joinPath(mount: string, route: string): string {
  if (route === '/') return mount;
  return `${mount.replace(/\/$/, '')}${route}`;
}

/** Does `guardedPrefix` swallow `fullPath`? */
function covers(guardedPrefix: string, fullPath: string): boolean {
  return fullPath === guardedPrefix || fullPath.startsWith(`${guardedPrefix}/`);
}

describe('express mount order in index.ts', () => {
  const text = readFileSync(INDEX, 'utf8');
  const source = ts.createSourceFile(INDEX, text, ts.ScriptTarget.Latest, true);
  const mounts = collectMounts(source);
  const imports = collectLocalImports(source, dirname(INDEX));

  it('parses the mounts, so this cannot pass vacuously', () => {
    expect(mounts.length).toBeGreaterThan(20);
    expect(mounts.some((m) => m.hasMountMiddleware)).toBe(true);
    expect(imports.size).toBeGreaterThan(20);
  });

  it('no route is unreachable behind an earlier guarded mount', () => {
    const shadowed: string[] = [];

    for (const mount of mounts) {
      if (!mount.routerIdent) continue;
      const file = imports.get(mount.routerIdent);
      if (!file) continue;

      const guardsAhead = mounts.filter((m) => m.order < mount.order && m.hasMountMiddleware);
      if (guardsAhead.length === 0) continue;

      for (const route of routePathsFor(file, mount.routerIdent)) {
        const full = joinPath(mount.path, route);
        const blocker = guardsAhead.find((g) => covers(g.path, full));
        if (blocker) {
          shadowed.push(
            `${full} (${mount.routerIdent}) is unreachable — '${blocker.path}' is mounted ` +
              `earlier with mount-level middleware`,
          );
        }
      }
    }

    expect(shadowed.sort()).toEqual([]);
  });

  // The exact pair that broke, named so a refactor of the walk above cannot
  // quietly stop covering it.
  it('harvest is mounted before the guarded connectors proxy', () => {
    const harvest = mounts.find((m) => m.routerIdent === 'harvestInternalRouter');
    const connectors = mounts.find(
      (m) => m.path === '/api/internal/connectors' && m.hasMountMiddleware,
    );

    expect(harvest).toBeDefined();
    expect(connectors).toBeDefined();
    expect(harvest!.order).toBeLessThan(connectors!.order);
  });
});
