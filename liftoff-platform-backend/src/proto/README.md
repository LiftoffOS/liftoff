# Proto Definitions

These proto files are the canonical source for cross-service contracts. They will be moved to the `liftoff-proto` repository when it is created. The buf toolchain (`buf.yaml`, `buf.gen.yaml`) will be added at that point.

**Current state: scaffolded for review.**

## Files

| File | Package | Description |
|------|---------|-------------|
| `connector-service.proto` | `liftoff.connector.v1` | ConnectorService — executes connector operations on behalf of tenant agents |
| `governance-engine.proto` | `liftoff.governance.v1` | GovernanceEngine — HITL approval flows, policy enforcement, audit recording |

## ConnectorService

Extracted from `tenant-runtime` per the decomposition plan. This service owns all outbound connector I/O: credential resolution, rate limiting, retry logic, and compensation (rollback) bookkeeping.

RPCs:
- `Execute` — single connector operation
- `ExecuteBatch` — fan-out multiple operations in one round-trip
- `Warm` — pre-warm credential cache and connection pool
- `GetCredentials` — retrieve resolved credentials for a connector

## GovernanceEngine

Enforces agent action policies, HITL approval flows, and audit recording for all tool executions. Every write operation executed by an agent MUST pass through `Preflight` before execution and `Record` after.

RPCs:
- `Preflight` — pre-execution policy check (HITL level, rate limits, permissions)
- `Authorize` — request explicit approval (async, returns pending token)
- `Record` — audit record + compensation snapshot after execution
- `ListApprovals` — list pending/decided approval requests

## Migration to liftoff-proto

When the `liftoff-proto` repo is created:

1. Move these `.proto` files there
2. Add `buf.yaml` (module config) and `buf.gen.yaml` (code generation config)
3. Run `buf generate` to produce TypeScript/Go/Python stubs
4. Update this repo to import from the generated npm package
5. Remove this `src/proto/` directory
