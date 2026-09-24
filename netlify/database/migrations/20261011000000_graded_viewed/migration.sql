-- When the teacher first looked over the graded pages, for the
-- "Reviewed" step on the assignment's progress tracker.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS graded_viewed_at TIMESTAMPTZ;
