-- How many pages each student turned in, asked when a teacher posts. When
-- it is set, each student's pages are grouped automatically for grading.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS pages_per_student INTEGER
  CHECK (pages_per_student IS NULL OR (pages_per_student BETWEEN 1 AND 50));
