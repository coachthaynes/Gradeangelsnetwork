-- Grade Angel setup becomes five steps, in order:
--   1 personal info       (personal_completed_at)
--   2 teaching background (profile_completed_at)
--   3 agreements          (confidentiality_agreed_at, contractor_agreement_signed_at)
--   4 background check    (background_check_status = 'clear')
--   5 payouts             (stripe_payouts_ready)
-- The paid outside services (Checkr, Stripe) come last, so we gather
-- everyone's information before they have to deal with either.

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS zip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_completed_at TIMESTAMPTZ;

ALTER TABLE users ADD COLUMN IF NOT EXISTS highest_degree TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS degree_field TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS teaching_certificate TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS certification_state TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS years_experience INTEGER;

ALTER TABLE users ADD COLUMN IF NOT EXISTS contractor_agreement_signed_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contractor_signature_name TEXT;

-- Step 2 now asks for degree and experience, which earlier profiles never
-- collected. Reopen that step so those Grade Angels fill in the gaps; their
-- earlier answers stay filled in.
UPDATE users SET profile_completed_at = NULL
WHERE role = 'grade_angel' AND years_experience IS NULL;
