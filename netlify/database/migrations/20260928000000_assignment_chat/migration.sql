-- Chat between a teacher and the Grade Angel working on their assignment.
--
-- Each message records the Grade Angel it was exchanged with. If a Grade
-- Angel hands the work back, the next one starts a fresh conversation and
-- never sees the earlier one; the teacher only sees the current thread.
--
-- The chat is open from acceptance until the Grade Angel is paid out, then
-- read only (see lib/chat.mts).

CREATE TABLE IF NOT EXISTS assignment_messages (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  grade_angel_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  -- True when contact details were stripped from the message.
  redacted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_thread ON assignment_messages(assignment_id, grade_angel_id, id);

-- The newest message each person has seen in a thread, for unread counts.
CREATE TABLE IF NOT EXISTS assignment_chat_reads (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (assignment_id, user_id)
);
