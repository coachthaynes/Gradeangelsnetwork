import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isSuspended } from "../lib/staff.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";

// Leave a review once an assignment is complete. The teacher reviews the
// Grade Angel and the Grade Angel reviews the teacher; each person gets one
// review per assignment. It stays private until the other person reviews
// too, or 14 days pass (see lib/profiles.mts).
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const assignmentId = Number(body.assignment_id);
  const rating = Number(body.rating);
  const comment = String(body.comment ?? "").trim().slice(0, 1000) || null;
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return json({ error: "Choose 1 to 5 stars" }, 400);

  const [a] = await db.sql`SELECT teacher_id, grade_angel_id, status FROM assignments WHERE id = ${assignmentId}`;
  if (!a) return json({ error: "Assignment not found" }, 404);
  if (a.status !== "completed") return json({ error: "You can leave a review once the assignment is complete" }, 409);

  let subjectId: number | null = null;
  if (session.id === a.teacher_id) subjectId = a.grade_angel_id;
  else if (session.id === a.grade_angel_id) subjectId = a.teacher_id;
  if (!subjectId) return json({ error: "Only the teacher and Grade Angel on this assignment can review it" }, 403);

  const rows = await db.sql`
    INSERT INTO reviews (assignment_id, author_id, subject_id, rating, comment)
    VALUES (${assignmentId}, ${session.id}, ${subjectId}, ${rating}, ${comment})
    ON CONFLICT (assignment_id, author_id) DO NOTHING
    RETURNING id
  `;
  if (rows.length === 0) return json({ error: "You already reviewed this assignment" }, 409);

  await recordEvent(assignmentId, session.id, "reviewed");
  return json({ ok: true }, 201);
};

export const config: Config = {
  path: "/api/reviews",
};
