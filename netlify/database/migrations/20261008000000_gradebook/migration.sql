-- A gradebook for teachers: their classes and student lists, and which
-- student each group of graded pages belongs to. Student names never
-- leave the teacher's account; Grade Angels only ever see "Student 1".

CREATE TABLE IF NOT EXISTS classes (
  id SERIAL PRIMARY KEY,
  teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_classes_teacher ON classes(teacher_id);

CREATE TABLE IF NOT EXISTS class_students (
  id SERIAL PRIMARY KEY,
  class_id INTEGER NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  student_code TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  archived_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_class_students_class ON class_students(class_id);

-- Which class an assignment was for.
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS class_id INTEGER REFERENCES classes(id) ON DELETE SET NULL;

-- The teacher's matches of page groups ("Student 1") to their students.
-- Missing rows fall back to matching by order.
CREATE TABLE IF NOT EXISTS assignment_student_links (
  assignment_id INTEGER NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL,
  student_id INTEGER REFERENCES class_students(id) ON DELETE CASCADE,
  PRIMARY KEY (assignment_id, group_id)
);
