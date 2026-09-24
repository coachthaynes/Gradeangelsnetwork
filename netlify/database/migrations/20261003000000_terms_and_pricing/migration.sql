-- Terms of Use acceptance, the version of the Grade Angel contract each
-- person signed, and the lowest price per page teachers may set.

ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS contractor_agreement_version TEXT;

-- In cents. Staff can change it in the admin dashboard (Payouts).
INSERT INTO site_settings (key, value) VALUES ('min_rate_per_page_cents', '10')
ON CONFLICT (key) DO NOTHING;
