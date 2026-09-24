-- Staff accounts, suspensions, and an audit log for the admin dashboard.
--
-- Staff are users with role 'admin' and a staff_level:
--   support  view everything, hide reviews, suspend users, record checks
--   manager  support, plus retry payouts, cancel assignments, export data
--   owner    manager, plus add and remove staff

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_level TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_staff_level_check;
ALTER TABLE users ADD CONSTRAINT users_staff_level_check
  CHECK (staff_level IS NULL OR staff_level IN ('support', 'manager', 'owner'));

ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_reason TEXT;

-- Every action a staff member takes, so the owner can see who did what.
CREATE TABLE IF NOT EXISTS admin_actions (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions(created_at DESC);
