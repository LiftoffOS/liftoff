# R5 Security Posture

## Threat model

Multi-tenant SaaS: agents are LLMs with tool access (file I/O, git, package
install, HTTP connectors). Threats considered:
1. **Prompt injection via file content** — an attacker-controlled file tricks
   the agent into issuing commands.
2. **Cross-tenant data exfiltration** — an agent of tenant A reads tenant B's
   workspace or DB.
3. **Credential theft** — an agent captures API keys, session tokens, or
   config secrets from its environment.
4. **Sandbox escape** — an agent escalates from its workspace to the host
   filesystem or to another tenant's resources.
5. **SSRF** — an agent reaches internal GCP services (metadata endpoint,
   private VPC IPs) via workspace_git_* or other tools.

## Controls summary

| Threat | Primary control | Defense-in-depth |
|--------|-----------------|-------------------|
| Prompt injection via file content | UntrustedContentFramer HMAC wrapping (Fix 8) | Regex rejection of delimiter variants, NFC normalization, server-secret-derived escape key; multi-ingress injection screening (DETECT+SURFACE, `src/injection-detection/`, ADR-031) |
| Cross-tenant exfiltration | Per-tenant Cloud Run project isolation | Path isolation hook, tombstone-guarded workspace reaper, tenant_id FK in every DB table |
| Credential theft | scrubLogger + stdout/stderr wrapping (Fix 8) | Secret Manager for `framer-secret`, no credentials in env vars that leak to child processes, secret-scrubber on tool output |
| Sandbox escape | readOnlyRootFilesystem + tmpfs /tmp (Infra) | openat-based write-path TOCTOU closure, nosymfollow bind (where supported), VPC egress firewall |
| SSRF | `--no-recurse-submodules` + `assertNoSubmoduleArgs` (Fix 6) | VPC firewall blocks 169.254/16 + 100.64/10 + RFC1918, DNS response policy NXDOMAINs metadata.google.internal |

### Two distinct injection-defense layers (do not conflate)

Untrusted content passes through **two independent controls** that are often
confused:

1. **Framing** (`src/workspace/untrusted-content-wrapper.ts`,
   `UntrustedContentFramer` / `frameUntrusted`) — *structural*. Wraps untrusted
   tool output in a per-turn HMAC-authenticated nonce delimiter so attacker
   content cannot forge the DATA boundary. Kill switch
   `CONNECTOR_OUTPUT_FRAMING_ENABLED`. This does not read or classify the
   content; it only marks it.

2. **Screening** (`src/injection-detection/finding.ts`,
   `screenUntrustedText` / `screenUntrustedStructured` over
   `@liftoffos/injection-detector`) — *detective*. Deterministically classifies
   the same untrusted content for injection and, on a `block` verdict, raises an
   `injection_finding` audit + metrics (and, in `enforce` mode on the trigger
   seam, a `createEscalation` operator record). It is **DETECT + SURFACE only**:
   it never drops or mutates content and never raises `hitlLevel` — agent
   autonomy stays operator-controlled. Screening runs fire-and-forget inside
   `frameUntrusted` (covering all four framed untrusted sources: connector
   results, sandbox file reads, vendor-hosted MCP results, corpus) plus a
   separate seam that screens `untrusted_inbound` webhook/reactive **trigger**
   payloads.

Screening is per-tenant entitlements-gated and shadow-first (modes
`off` / `shadow` / `enforce` from the `injection_detection` +
`injection_detection_enforce` flags; global kill switch
`INJECTION_DETECTION_KILL=1`), and deploys dormant. Canonical design:
platform-backend `docs/adr/031-injection-detection.md`.

## Residual risks (accepted)

### 1. Path-isolation write-path TOCTOU (R5 SE-R5-003)

After `walkParentChainNoSymlinkEscape` validates the parent chain, there is a
sub-microsecond window before the SDK's open() / openat() call. A truly
malicious in-workspace actor could race to swap a symlink.

**Mitigation**:
- The openat native addon provides kernel-atomic `openat(parent_fd, basename, O_CREAT | O_NOFOLLOW)` that eliminates the TOCTOU window on the final path component.
- The agent's own code (`workspace_run`) runs in the same process tree; per-command argv validation rejects shell interpolation that could swap paths.
- No cross-tenant attacker exists in this model — the attack surface is "agent convinces itself to race," which does not enable cross-tenant exfiltration.

**Accepted**: the pre-check + openat combination closes the kernel-level race. Any remaining userspace race is bounded to the agent's own workspace and does not cross tenant boundaries.

### 2. Cloud Run tmpfs shared with other instances (by GCP design)

Cloud Run containers on the same host share the kernel tmpfs. In theory,
side-channel attacks (timing, cache) could leak bits across instances.

**Mitigation**: Cloud Run enforces gVisor isolation between instances. Per-tenant Cloud Run projects are the boundary; no tenant's instance shares an execution environment with another tenant's instance.

**Accepted**: this is a standard Cloud Run guarantee; Google's gVisor is treated as a trust root.

### 3. DNS rebinding against github.com

A malicious DNS server could resolve `github.com` to an internal IP after the
initial TLS handshake. Our `GIT_ALLOW_PROTOCOL=https` accepts this.

**Mitigation**:
- VPC egress firewall blocks 169.254/16, 100.64/10, 10/8, 172.16/12, 192.168/16 for the tenant-runtime SA.
- DNS response policy overrides metadata.google.internal → 127.0.0.1.

**Accepted**: an attacker-controlled DNS server cannot direct traffic to a reachable internal endpoint because the firewall is independent of DNS resolution.

### 4. Prompt injection reaching the model through tool_use blocks

The agent SDK may interpret certain tool_use payloads as structured actions
before the untrusted-content wrapper fires. We rely on the SDK's PostToolUse
semantics to modify the result before the model sees it.

**Mitigation**: `docs/sdk-hook-contract.md` specifies and tests the semantics. Weekly contract runs (scheduler) verify no drift.

**Accepted**: the contract is tested; a behavioral drift triggers the kill switch via `docs/runbooks/sdk-contract-failure.md`.

### 5. The load test is a placeholder that has never run (R5 TE-R4-010 / TE-R5-010 / TE-ADD-008)

Capacity behaviour is unmeasured. What exists is four layers of scaffolding with
no implementation at any layer:

1. `src/workspace/__tests__/load.test.ts.skip` — the test. Named `.ts.skip` so
   Jest cannot collect it, gated again behind `LOAD_TEST=1`, and its body is a
   comment plus `void` statements ending in
   `throw new Error('load test not yet implemented')`.
2. `load-test.yml` — the workflow that was supposed to run it. Never created.
3. `load-test-deadline.yml` — a daily job polling for successful `load-test.yml`
   runs. Since the target never existed it took its "no successful run ever
   recorded" branch every day and exited 1. **Removed**, see below.
4. `docs/runbooks/load-test-procedure.md`, referenced by the test as
   "to be written before GA". Never written.

**The acceptance criteria are real and are the one part worth keeping**, which
is why the test file stays rather than being deleted with the rest: 30
concurrent threads per tenant across 5 test tenants, p99 turn-start under
2000 ms, p99 workspace-create under 500 ms, and a 400 MB per-workspace disk
quota holding tmpfs under 80%. Somebody decided what "passes" means; nobody
built the thing that measures it.

**Why the deadline job was removed rather than fixed.** Its comment claimed it
"Alerts SecOps on failure". It contained no Slack step, no notification and no
issue creation — the alert was a red scheduled run in a list nobody reads, every
day, for a target that could never appear. `TE-R4-010` and `TE-R5-010` appear in
no plan, ADR or document anywhere in these repositories; that comment was the
only place either id was written down. A control that guards nothing, reports to
nobody, and fails daily is worse than no control, because it teaches everyone
that a red badge on this repo is normal.

**To close this** needs the three things the placeholder never had: a target
environment to drive (a dev tenant, or a throwaway per-run tenant), a runner
wired to the criteria above, and an owner who acts on a regression. The criteria
are already written; the measurement is not.

## Non-residual (fully closed)

- Direct file traversal via `Read(/etc/passwd)`: closed by path-isolation hook.
- Embedded credentials in git clone URL: closed by `validateGitCloneTarget` rejecting URL userinfo.
- Yarn PnP lifecycle script execution bypassing `--ignore-scripts`: closed by PnP detection in `handleWorkspacePackageInstall` + post-install scan.
- Secret leakage via structured logs: closed by `scrubLogger` (arrays + circular + process-level + stdout/stderr wrap).
- Approval-ticket replay: N/A — R5 removed admin UI scope; flag flips via direct SQL with Cloud SQL IAM audit.

## References

- [docs/sdk-hook-contract.md](sdk-hook-contract.md)
- docs/runbooks/sdk-contract-failure.md
- docs/runbooks/framer-secret-rotation.md
- docs/phase-a-rollback.md
