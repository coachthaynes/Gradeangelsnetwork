-- Gift Angels: supporters who pay for grading so cost is not a barrier for
-- teachers. A gift goes either to one teacher (through that teacher's gift
-- link) or to the community fund, which staff hand out as grants. Teachers
-- spend their gift balance when they pay for an assignment.

-- A teacher's unspent gift money, their private gift link, and the short
-- note supporters see on that link's page. The link only exists once the
-- teacher turns it on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_balance_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_link_token TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_note TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_gift_balance_check;
ALTER TABLE users ADD CONSTRAINT users_gift_balance_check CHECK (gift_balance_cents >= 0);

-- The community fund: one row holding what has been given without a
-- specific teacher and not yet granted out.
CREATE TABLE IF NOT EXISTS gift_fund (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK (balance_cents >= 0)
);
INSERT INTO gift_fund (id, balance_cents) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

-- Every gift a supporter starts. It only counts once Stripe says it is paid.
CREATE TABLE IF NOT EXISTS gifts (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  donor_name TEXT NOT NULL,
  donor_email TEXT NOT NULL,
  message TEXT,
  anonymous BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded')),
  stripe_checkout_session_id TEXT,
  stripe_payment_intent_id TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gifts_teacher ON gifts(teacher_id);
CREATE INDEX IF NOT EXISTS idx_gifts_status ON gifts(status);

-- A record of every move of gift money, so any balance can be explained.
--   gift      a paid gift arrived (to a teacher, or to the fund when teacher_id is empty)
--   grant     staff moved money from the fund to a teacher (two rows: fund out, teacher in)
--   applied   a teacher spent gift money on an assignment
CREATE TABLE IF NOT EXISTS gift_ledger (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('gift', 'grant', 'applied')),
  gift_id INTEGER REFERENCES gifts(id) ON DELETE SET NULL,
  payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gift_ledger_teacher ON gift_ledger(teacher_id);

-- How much of an assignment's price was covered by gift money. The rest is
-- charged to the teacher's card; amount_cents stays the full price.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS gift_cents INTEGER NOT NULL DEFAULT 0;
