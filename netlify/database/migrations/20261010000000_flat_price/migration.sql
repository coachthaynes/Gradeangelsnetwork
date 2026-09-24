-- Teachers can price a stack per page or at one flat price, and every
-- assignment has a minimum total (raised automatically when lower).
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS pricing_mode TEXT NOT NULL DEFAULT 'per_page'
  CHECK (pricing_mode IN ('per_page', 'flat'));
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS flat_price_cents INTEGER;
-- The price the teacher pays for grading (before the service fee), set
-- when the assignment is posted. Older assignments without it use pages
-- times the rate per page.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS total_cents INTEGER;
-- True when the minimum raised the price.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS minimum_applied BOOLEAN NOT NULL DEFAULT false;

INSERT INTO site_settings (key, value) VALUES ('min_total_cents', '1000') ON CONFLICT (key) DO NOTHING;
