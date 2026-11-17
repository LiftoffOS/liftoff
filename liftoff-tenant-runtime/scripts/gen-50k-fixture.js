const fs = require('fs');
const { get_encoding } = require('tiktoken');

// Build a synthetic conversation with ~50k tokens by repeating dense
// technical paragraphs and alternating user/assistant turns.
const paragraphs = [
  "Distributed transactions across microservices rely on the saga pattern. Each step of the saga executes a local transaction and emits an event indicating success or failure. A central orchestrator subscribes to these events and decides whether to issue a forward step or trigger a compensating action. Forward steps move the system toward the goal state; compensating actions roll back previously-committed local transactions. The orchestrator is itself transactional: each state transition is persisted before the next event is emitted, so a crash leaves a recoverable journal. Idempotency is non-negotiable — every step must be safe to retry, which usually means accepting a request-id and short-circuiting on duplicate delivery.",
  "Spanner's external consistency rests on TrueTime, a global clock service exposed by GPS receivers and atomic clocks in every datacenter. Each TrueTime read returns an interval [earliest, latest] bracketing the true wall-clock time. To preserve external consistency, a commit waits out the uncertainty window: it picks a timestamp greater than the latest commit it observed, then sleeps until TrueTime.now().earliest exceeds that timestamp before declaring the commit visible. The result is that any read started after a commit completes observes that commit. The technique generalizes — any system with a bounded-error clock can recover external consistency the same way; the open question is how often that uncertainty window is small enough to matter.",
  "Kafka's log-structured storage gives it three properties most queues sacrifice: O(1) writes that scale linearly with disk throughput, replayability via offset seeking, and zero-copy replication using sendfile. Each topic partition is a single append-only log file; producers send batches that the broker appends without rewriting; consumers track their position via offsets they manage themselves (or via the Kafka consumer-group coordinator). Compaction tombstones old keys without rewriting the whole log, by sweeping in the background and producing a new segment with only the latest value per key. The biggest operational surprise is rebalance storms — when a consumer in a group dies, all consumers stop and re-partition until a new assignment converges; large groups should use sticky-assignment to bound the blast radius.",
  "WASM-on-Edge platforms like Cloudflare Workers and Fastly Compute@Edge replace per-request container cold-starts with millisecond V8 isolate creation. Each request gets a fresh isolate sandbox that shares the underlying V8 engine with thousands of other tenants; isolation is enforced by the V8 runtime itself, not by the OS. The result is much lower latency and cost than Lambda for short bursty workloads. The tradeoff is restricted runtime: no native FS, no `child_process`, no long-running threads, no arbitrary syscalls. WASM compiled from Rust or Go works with caveats — Go's GC pauses are a poor fit for the per-request execution model; most workloads choose Rust or AssemblyScript.",
  "Postgres's MVCC stores multiple row versions inline in heap pages. An UPDATE writes a new row with the new column values and rewrites the old row's xmax pointer to flag it as superseded; the old row stays in place until vacuum reclaims it. Long-running transactions hold open snapshots that prevent vacuum from cleaning dead rows, leading to bloat. The standard mitigation is to bound transaction lifetime (statement_timeout, idle_in_transaction_session_timeout), monitor pg_stat_activity.xact_start, and run pg_stat_progress_vacuum to see if a vacuum is in progress. HOT updates avoid the index rewrite by keeping the new row on the same page when no indexed columns changed; that's the single biggest UPDATE perf win Postgres has.",
  "OpenTelemetry's collector implements the pipeline pattern: receivers ingest spans/metrics/logs from instrumented apps; processors transform (batch, drop, redact, sample); exporters fan out to backends like Honeycomb, Datadog, or Prometheus. A single collector can run dozens of receivers and exporters in parallel, each with its own queue and backoff. The deployment model is layered — agents run as sidecars or DaemonSets close to the app, batching and processing locally; gateways receive from many agents and handle tail-sampling, cardinality control, and authentication to the backend. Tail-sampling decides AFTER the trace completes whether to keep or drop, based on attributes like has-error or duration percentile — drastically reducing volume while keeping the interesting traces.",
  "TLS 1.3 dropped renegotiation, ciphers without forward secrecy, and the entire static RSA key exchange. The handshake is one RTT shorter than 1.2 because the client sends its key share in the first message and the server can compute the master secret without waiting for a second client roundtrip. 0-RTT mode adds replay risk: the client can ship application data in the first packet at the cost of the server having no way to detect duplicates, so 0-RTT is only safe for idempotent requests. ECH (Encrypted Client Hello) wraps the SNI in an encrypted envelope so middleboxes can't see which hostname is being requested — a meaningful privacy bump but only with cooperative DNS and CDN deployment.",
];

const messages = [{ role: 'system', content: 'You are a senior platform engineer. Answer precisely and cite tradeoffs. Avoid speculation.' }];

let role = 'user';
let target = 50_000;
const enc = get_encoding('o200k_base');
function tokens(s) { return enc.encode(s).length; }

let used = tokens(messages[0].content);
let i = 0;
while (used < target) {
  // Compose a multi-paragraph turn so each user/assistant message is ~1500-2500 tokens
  const turn = [
    role === 'user' ? `Question ${i + 1}: ${paragraphs[i % paragraphs.length].split('.')[0]}?` : `Answer ${i + 1}:`,
    paragraphs[(i * 3) % paragraphs.length],
    paragraphs[(i * 7 + 1) % paragraphs.length],
    paragraphs[(i * 11 + 2) % paragraphs.length],
    role === 'user' ? 'Also note edge cases.' : 'Tradeoff: see notes above.',
  ].join('\n\n');
  messages.push({ role, content: turn });
  used += tokens(turn);
  role = role === 'user' ? 'assistant' : 'user';
  i++;
}
enc.free();

const out = { _note: `Hand-shaped synthetic conversation — ~${Math.round(used / 1000)}k tokens via o200k_base. Used by count-tokens.test.ts (Part 2) for cross-provider parity. Regenerate via scripts/gen-50k-fixture.js if vendor tokenizers shift.`, messages };
fs.writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${process.argv[2]} with ${messages.length} messages, ~${used} tokens`);
