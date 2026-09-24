import { db } from "./db.mts";
import { scoreList } from "./grading.mts";

// The teacher's gradebook. Each assignment's score list (one line per
// student group) is matched to the students in the class it was for: by
// the teacher's own match when they made one, otherwise by order, so
// "Student 1" is the first student on the class list.

export function parseRoster(text: unknown): { name: string; code: string | null }[] {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 300)
    .map((line) => {
      const [name, code] = line.split(/\t|,/).map((x) => x.trim());
      return { name: name.slice(0, 80), code: code ? code.slice(0, 40) : null };
    })
    .filter((s) => s.name);
}

export async function classStudents(classId: number) {
  return db.sql`
    SELECT id, name, student_code, position FROM class_students
    WHERE class_id = ${classId} AND archived_at IS NULL ORDER BY position, id
  `;
}

// Replaces a class list, keeping the same student (and their scores) when
// a name stays on the list, and archiving anyone removed.
export async function saveRoster(classId: number, roster: { name: string; code: string | null }[]) {
  const existing = await db.sql`SELECT id, name FROM class_students WHERE class_id = ${classId} AND archived_at IS NULL`;
  const byName = new Map(existing.map((s: any) => [s.name.toLowerCase(), s.id]));
  const kept = new Set<number>();
  for (let i = 0; i < roster.length; i++) {
    const r = roster[i];
    const id = byName.get(r.name.toLowerCase());
    if (id && !kept.has(id)) {
      kept.add(id);
      await db.sql`UPDATE class_students SET position = ${i}, student_code = ${r.code} WHERE id = ${id}`;
    } else {
      await db.sql`INSERT INTO class_students (class_id, name, student_code, position) VALUES (${classId}, ${r.name}, ${r.code}, ${i})`;
    }
  }
  for (const s of existing) {
    if (!kept.has(s.id)) await db.sql`UPDATE class_students SET archived_at = NOW() WHERE id = ${s.id}`;
  }
}

// An assignment's score lines with the student each one belongs to.
export async function matchedScores(a: { id: number; class_id: number | null; grading_groups: any[]; page_count: number }) {
  const lines = await scoreList(a.id, a.grading_groups || [], a.page_count);
  if (!a.class_id) return lines.map((l) => ({ ...l, student_id: null as number | null, matched: "none" }));
  const students = await classStudents(a.class_id);
  const links = await db.sql`SELECT group_id, student_id FROM assignment_student_links WHERE assignment_id = ${a.id}`;
  const linkMap = new Map(links.map((l: any) => [l.group_id, l.student_id]));
  return lines.map((l, i) => {
    if (linkMap.has(l.group_id)) return { ...l, student_id: linkMap.get(l.group_id) as number | null, matched: "teacher" };
    return { ...l, student_id: students[i]?.id ?? null, matched: "order" };
  });
}

// Assignments whose scores a teacher may see: graded work sent back and paid for.
export async function gradedAssignments(teacherId: number, classId: number | null) {
  return db.sql`
    SELECT a.id, a.title, a.subject, a.class_id, a.grading_groups, a.page_count, a.submitted_at, a.completed_at, a.status
    FROM assignments a
    WHERE a.teacher_id = ${teacherId} AND a.status IN ('submitted', 'completed')
      AND EXISTS (SELECT 1 FROM payments p WHERE p.assignment_id = a.id AND p.status = 'paid')
      AND (${classId}::int IS NULL AND a.class_id IS NULL OR a.class_id = ${classId}::int)
    ORDER BY COALESCE(a.completed_at, a.submitted_at), a.id
  `;
}
