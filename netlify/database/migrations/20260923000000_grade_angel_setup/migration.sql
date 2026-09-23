-- Grade Angel setup: the profile they fill in before they can take work,
-- the confidentiality agreement for handling student work, and a clearer
-- payouts flag.
--
-- stripe_payouts_ready replaces reading stripe_charges_enabled for payouts.
-- A Grade Angel's Express account only asks for the transfers capability,
-- and Stripe can leave charges_enabled false on those accounts even once
-- they can receive money, so it was the wrong flag to gate payouts on.

ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS qualifications TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS grade_levels TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS assignment_types TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS confidentiality_agreed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_completed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS stripe_payouts_ready BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE users SET stripe_payouts_ready = stripe_charges_enabled WHERE stripe_charges_enabled;
