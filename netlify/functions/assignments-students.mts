import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";

// The teacher puts an assignment in a class, or matches a group of graded
// pages ("Student 3") to a student on their list.
//   { assignment_id, class_id }                     class, or null for none
//   { assignment_id, group_id, student_id }         a match, null for nobody
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Only the teacher can do this" }, 403);
  const body = await readJson(req);
  const assignmentId = Number(body?.assignment_id);
  const [a] = await db.sql`SELECT id, class_id FROM assignments WHERE id = ${assignmentId} AND teacher_id = ${session.id}`;
  if (!a) return json({ error: "Assignment not found" }, 404);

  if (body!.class_id !== undefined) {
    const classId = body!.class_id === null || body!.class_id === "" ? null : Number(body!.class_id);
    if (classId !== null) {
      const [c] = await db.sql`SELECT id FROM classes WHERE id = ${classId} AND teacher_id = ${session.id}`;
      if (!c) return json({ error: "Class not found" }, 404);
    }
    await db.sql`UPDATE assignments SET class_id = ${classId} WHERE id = ${assignmentId}`;
    // Matches belonged to the old class's students.
    await db.sql`DELETE FROM assignment_student_links WHERE assignment_id = ${assignmentId}`;
    return json({ ok: true }, 200);
  }

  const groupId = String(body!.group_id || "").slice(0, 40);
  if (!groupId) return json({ error: "group_id is required" }, 400);
  const studentId = body!.student_id === null || body!.student_id === "" ? null : Number(body!.student_id);
  if (studentId !== null) {
    const [s] = await db.sql`
      SELECT cs.id FROM class_students cs JOIN classes c ON c.id = cs.class_id
      WHERE cs.id = ${studentId} AND c.id = ${a.class_id} AND c.teacher_id = ${session.id}
    `;
    if (!s) return json({ error: "That student is not in this assignment's class" }, 400);
  }
  await db.sql`
    INSERT INTO assignment_student_links (assignment_id, group_id, student_id) VALUES (${assignmentId}, ${groupId}, ${studentId})
    ON CONFLICT (assignment_id, group_id) DO UPDATE SET student_id = EXCLUDED.student_id
  `;
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/assignments/students",
};
