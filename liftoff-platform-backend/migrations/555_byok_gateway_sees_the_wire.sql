-- Migration 555: the gateway records the distinction its own pricing needs.
--
-- `byok_gateway_requests` already carried `cached_tokens`, and that one column
-- was two different charges added together. Anthropic bills a cache READ at
-- 0.1x the input rate and a cache WRITE at 1.25x — twelve and a half times —
-- and `input_tokens` arrives exclusive of both. A row holding their sum cannot
-- be priced at either rate, so the one table in this estate that sees the raw
-- vendor response could not answer the question the response was answering.
--
-- What it is FOR is two engines that report nothing usable. `opencode` splits
-- reasoning out of the completion count it publishes, and `gemini-cli` exposes
-- `total`, `input` and `output` and never `thoughts` or `tool` — so its residual
-- cannot be split between the input and output rates at all. Both numbers ARE on
-- the vendor's response (`completion_tokens_details.reasoning_tokens`,
-- `usageMetadata.thoughtsTokenCount`), and this table is where the vendor's
-- response is read.
--
-- The cache write is a column of its own here for the same reason it is billed
-- separately: Anthropic charges 1.25x input for a write and reports
-- `input_tokens` exclusive of it, so a cold turn owes almost all of its charge to
-- that one count and a turn that loses it under-bills by orders of magnitude. The
-- runtime already carries the count from its adapter; this is a second, INDEPENDENT
-- witness to it, read off the wire rather than through a chain of enumerations.
--
-- `cached_tokens` KEEPS ITS MEANING for a reader that already has one, and
-- `cache_read_tokens` is the same number said plainly. A reader must not add
-- the read to the write: they are separate charges at separate rates.
--
-- All three are nullable with no backfill. A call already served cannot be
-- re-asked what it spent, and a zero would assert a free call where the truth
-- is that nobody looked. NULL means "this row predates the capture".
--
-- No RLS change. `byok_gateway_requests` carries FORCE ROW LEVEL SECURITY and
-- keeps it: this migration adds columns and writes no rows, so there is nothing
-- for a policy to be evaluated against.

ALTER TABLE byok_gateway_requests
  ADD COLUMN IF NOT EXISTS cache_read_tokens  INTEGER,
  ADD COLUMN IF NOT EXISTS cache_write_tokens INTEGER,
  ADD COLUMN IF NOT EXISTS reasoning_tokens   INTEGER;

COMMENT ON COLUMN byok_gateway_requests.cache_read_tokens IS
  'Tokens served from the vendor prompt cache, as the vendor reported them. The same number as cached_tokens, said plainly. NULL for a row written before the capture existed.';
COMMENT ON COLUMN byok_gateway_requests.cache_write_tokens IS
  'Tokens spent populating the vendor prompt cache. SEPARATE MONEY from cache_read_tokens — Anthropic bills a write at 1.25x input against a read 0.1x — and never to be added to it. NULL for a row written before the capture existed.';
COMMENT ON COLUMN byok_gateway_requests.reasoning_tokens IS
  'The vendor thinking count, where the vendor reports one. A BREAKDOWN of output_tokens, not an addition to it: every vendor bills reasoning at the completion rate and output_tokens is already the billable total. NULL for a row written before the capture existed.';

-- ── A managed session is a first-class session ────────────────────────────────
--
-- The gateway was built for the one case where the credential is the
-- customer's, and `served_by` has always accepted 'managed' — for the FALLBACK,
-- when a customer's key is declined mid-run. Nothing could open a session that
-- was managed from the start.
--
-- It is mechanically the same request. Nothing about minting, verifying or
-- forwarding requires a customer key to exist; the only difference is which
-- credential is attached on the far side. And it is the only way the counting
-- above reaches the runs Liftoff funds, which is nearly all of them.
--
-- Carried on the TOKEN rather than inferred per request, because the answer is
-- decided once when the session opens and a per-request re-derivation is a
-- second place for it to be decided differently. A row written before this
-- column was a BYOK session by construction, which is what the default says.
ALTER TABLE byok_gateway_tokens
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'byok';

ALTER TABLE byok_gateway_tokens
  DROP CONSTRAINT IF EXISTS byok_gateway_tokens_mode_check;
ALTER TABLE byok_gateway_tokens
  ADD CONSTRAINT byok_gateway_tokens_mode_check CHECK (mode IN ('byok', 'managed'));

COMMENT ON COLUMN byok_gateway_tokens.mode IS
  'Whose key this session was opened to spend. byok: the customer own, with the managed key as the mid-run fallback. managed: Liftoff own from the start, opened so the gateway can count the tokens on the wire. Decided once at mint time and never re-derived per request.';

-- ── A managed-PRIMARY row is not a fallback, and the ledger must not read it as
--    one ──────────────────────────────────────────────────────────────────────
--
-- `served_by` says which key paid, and it stays exactly that. What it cannot say
-- on its own is WHY Liftoff's key paid, and until managed sessions existed it did
-- not have to: every 'managed' row was a BYOK session that fell back, so
-- `wasRunByokFunded` could read "any managed row means this turn fell back".
--
-- That inference breaks the moment a managed session writes a row. A run opens
-- more than one session under one invocation id — the turn itself, a coding
-- session sent to a different vendor, a browser agent loop — so a
-- customer-funded turn can sit beside a managed row from the coding session it
-- spawned. Read the old way that run is "not customer-funded" and bills in full:
-- A DOUBLE CHARGE ON A TURN THE CUSTOMER ALREADY PAID THEIR PROVIDER FOR, which
-- is the one outcome the whole BYOK design exists to prevent.
--
-- So the row records the SESSION's mode as well as the key that served it, and
-- the funding question is asked only of the sessions that were trying to spend a
-- customer's key. A managed-primary row is invisible to it — exactly as invisible
-- as it was before it existed.
--
-- DEFAULT 'byok' for the same reason as the token column: every row written
-- before this was a BYOK session by construction.
ALTER TABLE byok_gateway_requests
  ADD COLUMN IF NOT EXISTS session_mode TEXT NOT NULL DEFAULT 'byok';

ALTER TABLE byok_gateway_requests
  DROP CONSTRAINT IF EXISTS byok_gateway_requests_session_mode_check;
ALTER TABLE byok_gateway_requests
  ADD CONSTRAINT byok_gateway_requests_session_mode_check
  CHECK (session_mode IN ('byok', 'managed'));

COMMENT ON COLUMN byok_gateway_requests.session_mode IS
  'Whose key the SESSION was opened to spend, as distinct from served_by, which is whose key served this request. byok + managed means a fallback: the customer key was declined or absent and the turn bills as ordinary consumption. managed + managed is a run Liftoff was always paying for, opened only so its tokens could be counted, and the funding question is never asked of it.';

-- ── The gateway serves one more door than a customer can hold a key for ──────
--
-- `openrouter` is a vendor the gateway can serve and NOT a vendor a customer
-- can supply a key for: an OpenRouter invoice is Liftoff's, and
-- `keyVendorForProvider` answers null for every family it serves. It exists
-- here only for a managed session, so that the families reached through it —
-- GLM, Qwen, DeepSeek, Kimi, MiniMax, Xiaomi — have somewhere for their
-- reasoning tokens to be read off the wire.
--
-- The two vocabularies were already separate (`AiProviderKeyVendor` is the four
-- accounts a customer can hold; this is the doors the gateway serves) and this
-- is the first value that is in one and not the other.
ALTER TABLE byok_gateway_tokens
  DROP CONSTRAINT IF EXISTS byok_gateway_tokens_vendor_check;
ALTER TABLE byok_gateway_tokens
  ADD CONSTRAINT byok_gateway_tokens_vendor_check
  CHECK (vendor IN ('anthropic', 'google', 'openai', 'xai', 'openrouter'));
