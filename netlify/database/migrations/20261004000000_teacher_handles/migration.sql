-- A teacher's @username, so Gift Angels can find them without the teacher
-- sharing their real name, and whether their school shows beside it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_handle ON users (LOWER(handle));
ALTER TABLE users ADD COLUMN IF NOT EXISTS gift_show_school BOOLEAN NOT NULL DEFAULT false;
