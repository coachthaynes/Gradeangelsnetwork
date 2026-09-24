-- On site grading: marks drawn on each page, page groups (a student's
-- packet, or one worksheet with an answer key), and the review process
-- around it (a note with the graded work, one round of changes, disputes,
-- a reminder, and automatic approval).

-- Marks on one page. Each page has a Grade Angel layer and a teacher layer,
-- so the original page image is never changed. data is the list of marks
-- and the page score, with positions stored as fractions of the page.
CREATE TABLE IF NOT EXISTS assignment_annotations (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  layer TEXT NOT NULL CHECK (layer IN ('grade_angel', 'teacher')),
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (assignment_id, page_index, layer)
);

-- Page groups, set up by the Grade Angel:
--   [{ "id": "g1", "label": "Student 14", "kind": "student", "pages": [0,1,2] },
--    { "id": "g2", "label": "Quiz", "kind": "worksheet", "pages": [3,4,5], "key_page": 3 }]
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS grading_groups JSONB NOT NULL DEFAULT '[]'::jsonb;
-- The Grade Angel's note that goes with the graded work.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS grade_angel_note TEXT;
-- Whether the graded work was marked on the site (rather than uploaded).
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS graded_on_site BOOLEAN NOT NULL DEFAULT false;
-- One round of changes; asking again sends it to staff as a dispute.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS revision_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS revision_note TEXT;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS revision_requested_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS dispute_note TEXT;
-- Approval reminders (day 3) and automatic approval (day 5).
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS approval_reminder_at TIMESTAMPTZ;
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS auto_approved_at TIMESTAMPTZ;

-- Each person's saved comments for the grading screen.
ALTER TABLE users ADD COLUMN IF NOT EXISTS comment_bank JSONB;
