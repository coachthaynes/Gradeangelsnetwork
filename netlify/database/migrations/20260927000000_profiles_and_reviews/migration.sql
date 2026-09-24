-- Profiles and two way reviews.
--
-- Everyone gets a photo and an About me bio (bio already exists). Teachers
-- also get a display_name: the 2019 plan keeps teachers anonymous to Grade
-- Angels, so Grade Angels see this instead of the teacher's real name.
--
-- reviews existed from the first schema but was never used. It gains the
-- person being reviewed (subject_id), one review per person per
-- assignment, and a hidden flag for admin moderation later. A review stays
-- private until both sides have reviewed the assignment or 14 days pass,
-- so nobody writes theirs after reading the other's.

ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_blob_key TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;

ALTER TABLE reviews ADD COLUMN IF NOT EXISTS subject_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_one_per_author ON reviews(assignment_id, author_id);
CREATE INDEX IF NOT EXISTS idx_reviews_subject ON reviews(subject_id);
