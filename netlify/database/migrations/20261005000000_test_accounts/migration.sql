-- Test accounts (listed in the TEST_ACCOUNT_EMAILS setting) can run the
-- whole workflow without Checkr or Stripe. Their payments, payouts, and
-- gifts are marked so they are never mistaken for real money.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE gifts ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT false;
