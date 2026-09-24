-- Staff access needs the master admin's approval.
--
-- A staff account can only use the admin dashboard once staff_approved_at
-- is set, either by the master admin approving the request or because the
-- email was pre-approved in staff_invites. Master admins (built into the
-- code, plus the MASTER_EMAILS setting) are always allowed.
--
-- Staff accounts that already exist start unapproved and show up in the
-- master admin's approval queue.

ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_approved_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS staff_requested_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS staff_invites (
  email TEXT PRIMARY KEY,
  staff_level TEXT NOT NULL CHECK (staff_level IN ('support', 'manager', 'owner')),
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
