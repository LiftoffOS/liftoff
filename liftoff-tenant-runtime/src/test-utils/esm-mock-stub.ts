// Resolvable stub for ESM-only packages (@openai/codex-sdk, @opencode-ai/sdk)
// that have no `main`/`require` entry, so Jest's classic resolver cannot load
// them. Adapter unit tests fully replace these via `jest.mock(..., () => ({...}))`,
// so this stub's contents are never used — it only needs to resolve.
export {};
