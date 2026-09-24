-- Makes Grade Angel payouts reliable.
--
-- stripe_charge_id: the teacher's card charge. Transfers name it as their
-- source_transaction, so Stripe holds the transfer until that charge's
-- funds are available instead of failing when a teacher pays and marks the
-- work complete within the couple of days card funds take to settle.
--
-- New payout states:
--   held       the Grade Angel's Stripe account cannot receive money yet
--   processing a transfer is being sent right now (a lock against paying twice)
-- The hourly payouts-retry job retries held and failed payouts.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_charge_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payout_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payout_error TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payout_attempted_at TIMESTAMPTZ;

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payout_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_payout_status_check
  CHECK (payout_status IN ('not_started', 'held', 'processing', 'transferred', 'failed'));

CREATE INDEX IF NOT EXISTS idx_payments_payout_status ON payments(payout_status);
