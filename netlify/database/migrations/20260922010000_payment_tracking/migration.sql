-- Adds what is needed to actually move money: a record of the Stripe
-- Checkout session a teacher pays through, and a separate payout_status so
-- "the teacher paid" and "the Grade Angel has been sent their share" are
-- tracked independently. status stays what it was (pending/paid/failed/
-- refunded, for money coming IN from the teacher); payout_status is new
-- and tracks money going OUT to the Grade Angel.

ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_checkout_session_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS stripe_transfer_id TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS transferred_at TIMESTAMPTZ;

ALTER TABLE payments ADD COLUMN IF NOT EXISTS payout_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_payout_status_check;
ALTER TABLE payments ADD CONSTRAINT payments_payout_status_check
  CHECK (payout_status IN ('not_started', 'transferred', 'failed'));

CREATE INDEX IF NOT EXISTS idx_payments_assignment ON payments(assignment_id);
