// Route-granular detection of "this route takes a tenant id from the client".
//
// Extracted from the test so the same walk can be reused to regenerate the
// baseline (`scripts/list-unguarded-routes.ts`) instead of the two drifting.
//
// WHY THIS IS AST-BASED AND NOT A REGEX. The previous check was file-granular:
// a router file counted as guarded if `getMembership(` — or any other tenancy
// pattern — appeared ANYWHERE in it. Two ways that lies:
//
//   * A file with twenty routes passes because one of them is guarded.
//     `entitlements/router.ts` held a service router using `verifyServiceAuth()`
//     next to a user-facing router with none, and passed on the strength of the
//     first.
//   * A check that is PRESENT but CONDITIONAL satisfies the pattern while
//     failing the property. Both HITL decision routes ran their membership
//     lookup inside `if (approvalToCheck)`, where the value is null on the
//     circuit breaker's fallback — so the guard vanished exactly when the
//     runtime was degraded. That shipped, and this file exists because the
//     file-granular check could not have seen it.
//
// So: per route, and a guard nested inside a conditional does not count.

import * as ts from 'typescript';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

/** Anything that genuinely ties a request to the tenant it names. */
export const TENANCY_PATTERN =
  /tenantAuthMiddleware|verifyTenantMembership|verifyCallerAccess|verifyHitlTenantMembership|verifyTenantOwnership|verifyTenantScopeIfNamed|requireMinRole|getMembership\(|resolveCaller\(|tenantMembersService|validateServiceAuth|verifyServiceAuth|requireServiceAuth|serviceAuthMiddleware|verifyDevProxyWebhookToken|\bserviceAuth\b|validateBillingHmac|svcAuth|adminAuthMiddleware|requirePlatformAdmin|inbound_service_token_hash|validateInboundServiceToken|requireSchedulerOidc|getCallerRole\(|workforceServiceAuth|capabilityServiceAuth|PLATFORM_CALLBACK_TOKEN/;

export interface UnguardedRoute {
  /** `src`-relative file path. */
  file: string;
  /** `POST /tenant/:tenantId` — stable enough to baseline against. */
  route: string;
  /** `conditional` = a guard exists but only on some branch. `none` = no guard. */
  kind: 'conditional' | 'none';
}

export function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkSources(full, out);
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/** Router identifiers this file declares or re-exports under another name. */
function routerNames(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/(?:export )?const (\w*[Rr]outer\w*)\s*[:=]/g)) names.push(m[1]);
  for (const m of source.matchAll(/export\s*\{\s*\w+\s+as\s+(\w+)\s*\}/g)) names.push(m[1]);
  return names;
}

/**
 * Names of file-local functions whose body establishes the caller's right.
 *
 * A guard is often extracted so several routes share it —
 * `chat-media/router.ts`'s `resolveMember` does the account lookup, the
 * membership check and the 403, and every route there calls it first. The
 * per-route scan looks only at the handler, so it sees `resolveMember(...)`,
 * matches nothing, and reports a guarded route as unguarded. Following the call
 * one level is what makes an extracted guard count, and extracting a guard is
 * something to encourage rather than to penalise.
 *
 * One level only, and the body must match on its own: this resolves an alias for
 * a guard, it does not chase a chain.
 */
export function guardHelperNames(source: string, sf: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      if (TENANCY_PATTERN.test(n.body.getText(sf))) names.push(n.name.text);
    } else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (
        (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) &&
        TENANCY_PATTERN.test(n.initializer.getText(sf))
      ) {
        names.push(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Local name -> exported name, for `import { x as y }` in the mounting file.
 *  Without this a router mounted under an alias cannot be matched to the file
 *  that declares it, and a guard on its mount line is not seen. */
export function importAliases(indexSource: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const m of indexSource.matchAll(/(\w+)\s+as\s+(\w+)/g)) aliases.set(m[2], m[1]);
  return aliases;
}

/** Guarded on the `app.use(...)` line that mounts it. */
function mountGuarded(source: string, mountLines: string[], aliases: Map<string, string>): boolean {
  const declared = new Set(routerNames(source));
  return mountLines.some((line) => {
    if (!TENANCY_PATTERN.test(line)) return false;
    for (const ident of line.matchAll(/\b(\w*[Rr]outer\w*)\b/g)) {
      const name = ident[1];
      if (declared.has(name) || declared.has(aliases.get(name) ?? '')) return true;
    }
    return false;
  });
}

/**
 * Guarded by the PARENT that mounts it.
 *
 * A router is not only mounted from index.ts. `adminRouter.use('/agent-status',
 * agentStatusRouter)` nests one router inside another, and the child then
 * inherits every guard the parent installed — admin/router.ts wraps
 * adminAuthMiddleware around all of its routes, so agent-status is
 * admin-only despite naming a tenant id in its path. Reading only index.ts
 * mounts, the checker called it unguarded and it sat in the baseline as debt
 * that did not exist.
 */
function parentMountGuarded(
  file: string,
  srcDir: string,
  allFiles: string[],
): boolean {
  const myNames = routerNames(readFileSync(join(srcDir, file), 'utf8'));
  for (const other of allFiles) {
    if (other.endsWith(file)) continue;
    // index.ts is the APP mount, not a parent router. `app.use('/x', r)` matches
    // any "something.use(path, router)" shape, and index.ts is wall-to-wall
    // `.use(` beside tenancy vocabulary — so counting it as a guarding parent
    // marks every router in the estate guarded and the check silently passes
    // everything. It reported 0 findings when it had 31.
    if (other.endsWith('/index.ts')) continue;
    const otherSrc = readFileSync(other, 'utf8');
    // A PARENT ROUTER mounting one of mine, and guarding its own routes.
    const mountsMine = myNames.some((n) =>
      new RegExp(`\\w*[Rr]outer\\w*\\.use\\(\\s*'[^']*'\\s*,[^)]*\\b${n}\\b`).test(otherSrc),
    );
    if (mountsMine && routerLevelGuard(otherSrc)) return true;
  }
  return false;
}

/** A blanket `someRouter.use(guard)` covering every route in the file. */
function routerLevelGuard(source: string): boolean {
  // Look at the WHOLE `.use(...)` call, not just its first argument. The guard
  // is often wrapped rather than passed directly — `adminRouter.use((req, res,
  // next) => { ...; return adminAuthMiddleware(req, res, next); })` protects
  // every route in admin/router.ts, and a first-argument-only regex reads it as
  // unguarded and flags all of them.
  for (const m of source.matchAll(/\w*[Rr]outer\w*\.use\(/g)) {
    const window = source.slice(m.index ?? 0, (m.index ?? 0) + 400);
    if (TENANCY_PATTERN.test(window)) return true;
  }
  return false;
}

/** Is `node` reached only on some branch, relative to the handler it sits in? */
/** Is `node` somewhere inside the CONDITION of an `if` between it and the
 *  handler? A condition runs whatever its shape, so a guard written into one is
 *  unconditional even when it is joined by `&&` or `||`. */
function insideIfCondition(node: ts.Node, handler: ts.Node): boolean {
  let parent = node.parent;
  let child: ts.Node = node;
  while (parent && parent !== handler) {
    if (ts.isIfStatement(parent)) return parent.expression === child;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

function isConditional(node: ts.Node, handler: ts.Node): boolean {
  // A guard joined into an if's condition is reached on every request: the
  // service-token routes write `if (!process.env.X || req.headers[...] !== X)
  // return 401`, and stopping at the `||` called that conditional — the same
  // mistake the if-CONDITION rule below already exists to avoid, one level
  // deeper. The HITL shape this function is FOR is a guard in the if's BODY
  // (`if (approvalToCheck) { checkMembership }`), which is unaffected: that call
  // is not in the condition, so this returns false and the rules below apply.
  if (insideIfCondition(node, handler)) return false;
  let parent = node.parent;
  let child: ts.Node = node;
  while (parent && parent !== handler) {
    // A guard in an if's CONDITION always runs — `if (!(await
    // verifyTenantMembership(req, res, t))) return res.status(403)` is the
    // idiomatic unconditional guard in this codebase, and treating it as
    // conditional flagged a2a, notifications and corrections as unguarded when
    // they are the opposite: guarded, and refusing on the spot. Only a guard in
    // the THEN/ELSE branch is conditional.
    if (ts.isIfStatement(parent) && parent.expression === child) {
      child = parent;
      parent = parent.parent;
      continue;
    }
    if (
      ts.isIfStatement(parent) ||
      ts.isConditionalExpression(parent) ||
      ts.isCatchClause(parent) ||
      ts.isSwitchStatement(parent) ||
      (ts.isBinaryExpression(parent) &&
        (parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
          parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
          parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken))
    ) {
      return true;
    }
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/**
 * Every route that reads a client-supplied tenant id and does not
 * unconditionally establish the caller's right to it.
 */
export function findUnguardedRoutes(srcDir: string): UnguardedRoute[] {
  const indexSource = readFileSync(join(srcDir, 'index.ts'), 'utf8');
  const mountLines = indexSource.split('\n').filter((l) => l.includes('app.use('));
  const aliases = importAliases(indexSource);

  const found: UnguardedRoute[] = [];
  const allFiles = walkSources(srcDir);

  for (const file of allFiles) {
    const source = readFileSync(file, 'utf8');
    if (!/\.(get|post|put|patch|delete)\(/.test(source)) continue;
    if (mountGuarded(source, mountLines, aliases) || routerLevelGuard(source)) continue;
    if (parentMountGuarded(file.slice(srcDir.length + 1), srcDir, allFiles)) continue;

    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);

    // TENANCY_PATTERN plus this file's own extracted guards.
    const helpers = guardHelperNames(source, sf);
    const guardPattern = helpers.length
      ? new RegExp(`${TENANCY_PATTERN.source}|\\b(?:${helpers.join('|')})\\s*\\(`)
      : TENANCY_PATTERN;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        const target = node.expression.expression.getText(sf);
        if (
          HTTP_METHODS.has(method) &&
          /router/i.test(target) &&
          node.arguments.length >= 2 &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const routePath = node.arguments[0].text;
          const handler = node.arguments[node.arguments.length - 1];
          const middleware = node.arguments.slice(1, -1).map((a) => a.getText(sf)).join(' ');
          const handlerText = handler.getText(sf);

          // Body counts too. `reporting` reads `const { tenantId } = req.body`
          // and scopes a whole report to it, which is every bit as
          // client-supplied as a query string — the first version of this check
          // only looked at query/params/path and could not see it.
          // A VALIDATED copy of the input is still the input. A route that runs
          // req.query or req.body through a schema and destructures tenantId
          // from the RESULT never writes `req.query.tenantId`, so the patterns
          // above cannot see it — and validating input is the pattern we ask for,
          // which made this the blind spot rather than an edge case. Two SSE
          // routes on /api/insights read a client-named tenantId that way and
          // checked nothing, so any signed-in person could stream another
          // workspace's cost and activity summary, while this ratchet reported
          // clean and neither route was in the baseline.
          const schemaParsedTenantId =
            /\bsafeParse\s*\(\s*req\.(query|body|params)\b/.test(handlerText) ||
            /\bparse\s*\(\s*req\.(query|body|params)\b/.test(handlerText);
          const destructuresTenantId = /\{[^}]*\btenantId\b[^}]*\}\s*=/.test(handlerText);

          const readsClientTenantId =
            /req\.query\.tenantId|req\.params\.tenantId/.test(handlerText) ||
            /req\.body(?:\?)?\.tenantId|tenantId\s*[,}][^=]*=\s*req\.body/.test(handlerText) ||
            /\{[^}]*\btenantId\b[^}]*\}\s*=\s*req\.body/.test(handlerText) ||
            (schemaParsedTenantId && destructuresTenantId) ||
            /:tenantId/.test(routePath);

          if (readsClientTenantId && !guardPattern.test(middleware)) {
            let unconditional = false;
            let conditional = false;
            const scan = (n: ts.Node): void => {
              if (ts.isCallExpression(n) || ts.isIdentifier(n)) {
                const text = n.getText(sf);
                // Length-capped: a whole nested function body can match the
                // pattern via a call deep inside it and say nothing about
                // whether THIS position is guarded.
                if (text.length < 200 && guardPattern.test(text)) {
                  if (isConditional(n, handler)) conditional = true;
                  else unconditional = true;
                }
              }
              ts.forEachChild(n, scan);
            };
            scan(handler);

            if (!unconditional) {
              found.push({
                file: file.slice(srcDir.length + 1),
                route: `${method.toUpperCase()} ${routePath}`,
                kind: conditional ? 'conditional' : 'none',
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
  }

  return found;
}

/** The stable key a baseline entry is matched on. */
export function routeKey(r: UnguardedRoute): string {
  return `${r.file}::${r.route}`;
}
