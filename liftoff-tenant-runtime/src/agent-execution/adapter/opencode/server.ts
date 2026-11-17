// Starts an opencode server for one invocation, with an environment of our
// choosing.
//
// @opencode-ai/sdk's createOpencode() spawns `opencode serve` with
// `process.env` and offers no way to add to it, and the environment is not
// cosmetic: opencode decides HOW it reaches a provider from what the provider
// record looks like when its loaders run. A provider whose key arrives only in
// the config (`provider.<id>.options.apiKey`) does not exist yet at that point,
// so the provider-specific loader is skipped and the model is built with the
// SDK package's default constructor. For xAI that default is the chat
// completions model of the bundled @ai-sdk/xai, whose stream handling cannot
// represent a chunk carrying reasoning and content together and fails the turn
// with `reasoning part <id> not found`; the loader opencode has for xai selects
// the Responses API model, which can. The provider exists in time only when
// its key is in the environment under the name the catalog lists (`XAI_API_KEY`).
// The config's `options.apiKey` still wins for the actual credential, so a
// customer-funded run's gateway token is unaffected by the env copy.
//
// Owning the spawn also ends this engine's standing exception to the child
// environment rule: the server gets the allow-list (`child-process-env.ts`),
// its config and the provider variable, never this process's environment.
//
// The readiness protocol and the close are the SDK's (`dist/server.js`): the
// server prints `opencode server listening on <url>` once it is up, exits
// non-zero when it cannot start, and is stopped with a kill. The client is the
// SDK's own.

import { spawn, type ChildProcess } from 'node:child_process';
import { Agent } from 'undici';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { childProcessEnv } from '../child-process-env';
import { scrubLogger } from '../../../observability/scrub-logger';
import { esmImport } from '../esm-import';

export interface StartOpencodeOptions {
  /** How long ONE request to this server may take, in ms.
   *
   *  The prompt call blocks for the whole turn, so this has to cover a turn —
   *  see `requestTimeoutMs` on the adapter. */
  requestTimeoutMs?: number;
  hostname: string;
  port: number;
  /** How long the server may take to report its URL. */
  timeout: number;
  /** The inline config (`OPENCODE_CONFIG_CONTENT`). */
  config: Record<string, unknown>;
  /** Added to the server's environment on top of the allow-list. */
  env?: Record<string, string>;
}

export interface OpencodeServerHandle {
  url: string;
  close(): void;
  /** What the server process said and whether it is still alive.
   *
   *  Read when a request to it fails: `fetch failed` says a socket broke and
   *  nothing about why, and the process's own last words are the only thing
   *  that separates "it crashed" from "the network hiccuped". */
  diagnostics(): { alive: boolean; exitCode: number | null; signal: string | null; recentOutput: string };
}

/** How much of the server's recent output to keep for a post-mortem.
 *
 *  A ring, not a log: the process is chatty and its ordinary chatter is not
 *  worth a line each. What matters is the tail at the moment it stops. */
const OUTPUT_TAIL_CHARS = 4_000;

const READY_LINE = /^opencode server listening\b.*?\bon\s+(https?:\/\/\S+)/m;

function stop(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill();
}

async function launch(options: StartOpencodeOptions): Promise<OpencodeServerHandle> {
  const args = ['serve', `--hostname=${options.hostname}`, `--port=${options.port}`];
  const logLevel = options.config.logLevel;
  if (typeof logLevel === 'string' && logLevel) args.push(`--log-level=${logLevel}`);
  const proc = spawn('opencode', args, {
    env: childProcessEnv({
      ...(options.env ?? {}),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(options.config),
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Kept across the whole life of the process, not just its startup.
  let ring = '';
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  let stopping = false;
  const tail = (text: string) => {
    ring = (ring + text).slice(-OUTPUT_TAIL_CHARS);
  };
  const recent = () => ring.trim();

  const url = await new Promise<string>((resolve, reject) => {
    let output = '';
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        stop(proc);
        reject(new Error(`Timeout waiting for server to start after ${options.timeout}ms`));
      });
    }, options.timeout);
    // The listeners stay attached after readiness so the pipes keep draining —
    // AND so the tail is kept. Every one of these used to discard its input the
    // moment the server was up: `if (settled) return`, and an exit handler whose
    // `settle` was already a no-op. So when the process died mid-run its exit
    // code and its last words both went nowhere, and the only signal left was a
    // request failing with `fetch failed` some time later. That is why a whole
    // class of engine failure could not be told apart from a network one.
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tail(text);
      if (settled) return;
      output += text;
      const match = READY_LINE.exec(output);
      if (match) settle(() => resolve(match[1]));
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      tail(chunk.toString());
      if (!settled) output += chunk.toString();
    });
    proc.on('exit', (code, sig) => {
      exited = { code, signal: sig };
      // Before readiness this rejects the start, as it always did. AFTER
      // readiness `settle` is a no-op, which is exactly the case that was
      // silent: the server is gone, every later request to it will fail, and
      // nothing said so. `stop()` kills it deliberately at the end of a run, so
      // a signalled exit while shutting down is expected and not worth a warn.
      if (settled && !stopping) {
        scrubLogger.warn({
          event: 'opencode_server_exited',
          exitCode: code,
          signal: sig,
          recentOutput: recent(),
          msg: 'the opencode server exited while a run was using it',
        });
      }
      settle(() => reject(new Error(`Server exited with code ${code}${output.trim() ? `\nServer output: ${output}` : ''}`)));
    });
    proc.on('error', (error) => {
      if (settled) {
        scrubLogger.warn({
          event: 'opencode_server_error',
          err: (error as Error).message,
          recentOutput: recent(),
          msg: 'the opencode server process errored while a run was using it',
        });
      }
      settle(() => reject(error));
    });
  });

  return {
    url,
    close: () => { stopping = true; stop(proc); },
    diagnostics: () => ({
      alive: exited === null && proc.exitCode === null && proc.signalCode === null,
      exitCode: exited?.code ?? proc.exitCode,
      signal: exited?.signal ?? proc.signalCode,
      recentOutput: recent(),
    }),
  };
}

/** The SDK's createOpencode(), taking an environment: the server, and a client bound to it. */
export async function startOpencode(
  options: StartOpencodeOptions,
): Promise<{ client: OpencodeClient; server: OpencodeServerHandle }> {
  const server = await launch(options);
  try {
    const { createOpencodeClient } = await esmImport<typeof import('@opencode-ai/sdk')>('@opencode-ai/sdk');
    // THE REQUEST HAS TO OUTLIVE THE TURN IT CARRIES.
    //
    // `POST /session/{id}/message` blocks until the turn finishes — its
    // resolution IS the terminal signal (see the prompt call in the adapter) —
    // so the HTTP request is open for as long as the model works. The client
    // was built with `{ baseUrl }` and nothing else, which left Node's fetch on
    // its own defaults: undici gives up on a request after 300 seconds
    // (`headersTimeout` and `bodyTimeout`, both `300e3` in
    // undici/lib/dispatcher/client.js).
    //
    // That was invisible while the turn died first at a flat 180 s. Raising the
    // turn bound made this the binding one, and a run failed at 302.4 s with
    // `TypeError: fetch failed` — the engine healthy, 27 tool calls served, a
    // document written, and the transport underneath giving up on its own
    // schedule. A FOURTH bound nobody had written down.
    //
    // Derived from the caller's turn ceiling rather than set beside it, so the
    // number cannot drift away from the thing it has to cover.
    const dispatcher = options.requestTimeoutMs
      ? new Agent({
        headersTimeout: options.requestTimeoutMs,
        bodyTimeout: options.requestTimeoutMs,
      })
      : undefined;
    const client = createOpencodeClient({
      baseUrl: server.url,
      ...(dispatcher
        // `globalThis.fetch`, NOT undici's own export. The SDK hands this hook a
        // `Request`, and undici's `fetch` does not take one — it parses its
        // first argument as a URL and throws
        // `Failed to parse URL from [object Request]` before a single call is
        // made. Node's global fetch takes the Request and honours undici's
        // `dispatcher` option, which is how the timeouts get applied.
        //
        // The first version of this shipped with `request as never` to satisfy
        // the compiler. The cast is what hid the mismatch: it typechecked, it
        // built, and it failed on the first live run in five seconds with zero
        // tool calls. No cast here — if the shapes stop matching, it should
        // fail to compile.
        ? { fetch: (request: Request) => globalThis.fetch(request, { dispatcher } as RequestInit) }
        : {}),
    });
    return { client, server };
  } catch (err) {
    server.close();
    throw err;
  }
}
