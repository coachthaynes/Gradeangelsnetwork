-- The teacher service fee, and Grade Angel Pro.

-- A small fee on top of the assignment price, paid by the teacher (or by
-- gift money). It is Grade Angels Network's and does not change the Grade
-- Angel's share. amount_cents stays the assignment price.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS service_fee_cents INTEGER NOT NULL DEFAULT 0;

-- Grade Angel Pro: an optional $10 a month plan with a 7 day free trial.
-- Pro Grade Angels keep 90% instead of 80%, see new work first, and get a
-- badge. The monthly price comes out of their payouts, only in months
-- they are paid.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_started_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_ended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_trial_ends_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_terms_accepted_at TIMESTAMPTZ;

-- Each monthly Pro charge taken from a payout.
CREATE TABLE IF NOT EXISTS pro_charges (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  test_mode BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pro_charges_user_month ON pro_charges(user_id, month);

-- The rate this payout used, so a Pro Grade Angel's 90% is on record.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pro_rate_applied BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS pro_charge_cents INTEGER NOT NULL DEFAULT 0;
