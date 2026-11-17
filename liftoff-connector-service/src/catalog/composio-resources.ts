import fs from 'fs';
import path from 'path';

/**
 * Where a Composio toolkit's auth-config and MCP-server ids come from.
 *
 * THE PROBLEM THIS SOLVES. Those ids belong to one Composio ORGANISATION. They
 * are baked into 106 catalogue entries in connectors.ts as `{ dev, prod }`
 * pairs, which is correct for the organisation that provisioned them and
 * useless to anyone else: a different deployment's Composio key cannot see
 * them, so every managed connector refuses to start its OAuth flow and the
 * catalogue degrades to the ~53 api_key connectors and the 35 that self-register.
 *
 * That matters more than the number suggests, because Composio's managed auth
 * is what lets a deployment offer ~105 connectors WITHOUT registering 55 OAuth
 * applications of its own. It is the difference between a usable catalogue and
 * a token one.
 *
 * HOW IT RESOLVES. `scripts/composio-bootstrap-toolkit.ts` is already
 * idempotent find-or-create against whatever organisation the API key belongs
 * to, and already writes what it resolved to config/composio-resources.json.
 * This reads that file and prefers it over the baked constant. So a deployment
 * sets COMPOSIO_API_KEY, runs the bootstrap once and restarts — no source
 * editing, no rebuild.
 *
 * TWO SHAPES, ON PURPOSE. A record may carry `{ dev, prod }` (what the
 * bootstrap writes when run against two environments) or a bare string. A
 * deployment has ONE Composio organisation, not two, so a bare string is the
 * normal case now; the keyed shape is read so an existing file still works.
 *
 * READ ONCE. The file does not change while the process runs — the bootstrap
 * is a separate command and the instruction is to restart after it. Reading
 * per call would mean a filesystem hit on every catalogue projection, and
 * `isConnectorFunctional` runs over the whole catalogue.
 */

interface ResourceRecord {
  toolkitSlug: string;
  authConfigIds?: Record<string, string> | string;
  mcpServerIds?: Record<string, string> | string;
}

interface ResourceFile {
  toolkits?: Record<string, ResourceRecord>;
}

const RESOURCE_FILE = path.join(__dirname, '../../config/composio-resources.json');

let cache: ResourceFile | null = null;

function load(): ResourceFile {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(RESOURCE_FILE, 'utf8')) as ResourceFile;
  } catch {
    // Absent is the normal state for a deployment that has not run the
    // bootstrap yet, and unparseable is not worth crashing a request path
    // over: either way the baked ids are the answer, and a managed connector
    // whose id is a placeholder is already reported as not functional.
    cache = {};
  }
  return cache;
}

/** Test seam. The file is read once per process, so a test that writes one
 *  needs a way to forget what an earlier test read. */
export function _resetComposioResourceCache(): void {
  cache = null;
}

function pick(value: Record<string, string> | string | undefined, env: string): string | undefined {
  if (typeof value === 'string') return value || undefined;
  if (!value) return undefined;
  return value[env] || undefined;
}

function resolve(
  field: 'authConfigIds' | 'mcpServerIds',
  toolkitSlug: string,
  baked: Record<string, string> | undefined,
  env: string,
): string | undefined {
  const runtime = pick(load().toolkits?.[toolkitSlug]?.[field], env);
  if (runtime && !runtime.startsWith('<')) return runtime;
  return pick(baked, env);
}

export function composioAuthConfigId(
  toolkitSlug: string,
  baked: Record<string, string> | undefined,
  env: string,
): string | undefined {
  return resolve('authConfigIds', toolkitSlug, baked, env);
}

export function composioMcpServerId(
  toolkitSlug: string,
  baked: Record<string, string> | undefined,
  env: string,
): string | undefined {
  return resolve('mcpServerIds', toolkitSlug, baked, env);
}
