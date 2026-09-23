-- Grade Angels Network, initial schema
-- Three roles share one users table: teacher, grade_angel, admin.
-- Gift Angels are not accounts in this first pass, they are a payment flow
-- attached to a teacher, added once payments are wired up for real.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('teacher', 'grade_angel', 'admin')),
  full_name TEXT NOT NULL,
  school_or_org TEXT,
  subjects TEXT,
  background_check_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (background_check_status IN ('not_started', 'invited', 'pending', 'clear', 'consider')),
  stripe_account_id TEXT,
  stripe_charges_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  checkr_candidate_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  grade_angel_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  subject TEXT NOT NULL,
  grade_level TEXT NOT NULL,
  assignment_type TEXT NOT NULL CHECK (assignment_type IN ('multiple_choice', 'combo', 'essay')),
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  rate_per_page_cents INTEGER NOT NULL,
  instructions TEXT,
  source_blob_key TEXT,
  source_filename TEXT,
  graded_blob_key TEXT,
  graded_filename TEXT,
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'accepted', 'submitted', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_assignments_status ON assignments(status);
CREATE INDEX IF NOT EXISTS idx_assignments_teacher ON assignments(teacher_id);
CREATE INDEX IF NOT EXISTS idx_assignments_grade_angel ON assignments(grade_angel_id);

CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Payments is a stub table today. It fills in once Stripe Connect is
-- actually configured with a real account; see the payments function.
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
