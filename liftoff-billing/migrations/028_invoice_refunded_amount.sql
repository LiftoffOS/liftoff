-- Record what came back out of an invoice, beside what went in.
--
-- Until now a refund left no trace on the local mirror. `amount_paid_cents`
-- kept saying the invoice was paid in full, forever, however much of it had
-- been returned — and every refund to date has been a human in the Stripe
-- dashboard, so the mirror and Stripe have been quietly diverging for the life
-- of the table.
--
-- `amount_paid_cents` IS NOT MUTATED, deliberately. What the customer paid is a
-- historical fact and a refund is a second fact; the net is the subtraction.
-- Collapsing them loses the ability to reconstruct either, which is the whole
-- point of keeping a ledger rather than a balance.
--
-- Written from `charge.refunded` rather than from the refund endpoint, so a
-- refund issued in the Stripe dashboard lands here too. The endpoint is the new
-- path; the dashboard is the one that has always been used.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS amount_refunded_cents BIGINT NOT NULL DEFAULT 0
    CHECK (amount_refunded_cents >= 0),
  -- Every credit note raised against this invoice. An array rather than a
  -- single id because Stripe permits several, and because the trail is the only
  -- way to tie a refunded amount back to the documents that produced it.
  ADD COLUMN IF NOT EXISTS credit_note_ids TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN invoices.amount_refunded_cents IS
  'Cumulative cents refunded against this invoice. Written from charge.refunded so dashboard refunds are captured too; amount_paid_cents is never reduced.';
COMMENT ON COLUMN invoices.credit_note_ids IS
  'Stripe credit note ids raised against this invoice, in the order they were issued.';
