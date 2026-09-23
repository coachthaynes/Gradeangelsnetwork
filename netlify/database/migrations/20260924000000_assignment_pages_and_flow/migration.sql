-- Assignment flow from the 2019 plan: a turnaround time with a due date,
-- invites to a specific Grade Angel (who can accept or decline with a
-- reason), Grade Angels handing work back, and teachers cancelling.
--
-- Also moves assignments from one uploaded file to one image per page.
-- Netlify functions cap a request at about 6 MB, far smaller than a class
-- set of photos, so pages upload one at a time. An assignment stays in
-- 'draft' until every page is in and the teacher publishes it.

ALTER TABLE assignments ADD COLUMN IF NOT EXISTS turnaround_hours INTEGER NOT NULL DEFAULT 48;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS invited_grade_angel_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_status_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_status_check
  CHECK (status IN ('draft', 'open', 'accepted', 'submitted', 'completed', 'cancelled'));

ALTER TABLE assignments DROP CONSTRAINT IF EXISTS assignments_turnaround_hours_check;
ALTER TABLE assignments ADD CONSTRAINT assignments_turnaround_hours_check
  CHECK (turnaround_hours BETWEEN 12 AND 168);

CREATE INDEX IF NOT EXISTS idx_assignments_invited ON assignments(invited_grade_angel_id);

CREATE TABLE IF NOT EXISTS assignment_pages (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  blob_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (assignment_id, page_index)
);

-- A running log of what happened to an assignment and why: invites,
-- declines and hand backs with their reasons, cancellations. Teachers see
-- it on the assignment page; admins will use it for disputes.
CREATE TABLE IF NOT EXISTS assignment_events (
  id SERIAL PRIMARY KEY,
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignment_events_assignment ON assignment_events(assignment_id);
