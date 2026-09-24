import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isSuspended } from "../lib/staff.mts";
import { getSetupStatus } from "../lib/grade-angel.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";

// A Grade Angel claims an open assignment, but only once their setup is
// finished (profile, background check, payouts). The WHERE clause checks
// status = 'open' and the invite as part of the same update, so two Grade
// Angels racing for the same assignment cannot both win it, and nobody can
// take one that was sent to someone else. Accepting starts the clock: the
// due time is the teacher's turnaround from now.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels can accept assignments" }, 403);
  }

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const assignmentId = Number(body.assignment_id);
  if (!Number.isInteger(assignmentId)) {
    return json({ error: "assignment_id is required" }, 400);
  }

  const setup = await getSetupStatus(session.id);
  if (!setup?.ready) {
    return json({ error: "Finish your Grade Angel setup before accepting assignments", setup }, 403);
  }

  const rows = await db.sql`
    UPDATE assignments
    SET grade_angel_id = ${session.id}, status = 'accepted', accepted_at = NOW(),
        due_at = NOW() + make_interval(hours => turnaround_hours),
        invited_grade_angel_id = NULL
    WHERE id = ${assignmentId} AND status = 'open'
      AND (invited_grade_angel_id IS NULL OR invited_grade_angel_id = ${session.id})
    RETURNING id, teacher_id, grade_angel_id, title, subject, grade_level, assignment_type,
              page_count, rate_per_page_cents, status, created_at, accepted_at, due_at
  `;

  if (rows.length === 0) {
    const [existing] = await db.sql`SELECT id, status FROM assignments WHERE id = ${assignmentId}`;
    if (!existing) return json({ error: "Assignment not found" }, 404);
    return json({ error: "That assignment is no longer open" }, 409);
  }

  await recordEvent(assignmentId, session.id, "accepted");
  return json({ assignment: rows[0] }, 200);
};

export const config: Config = {
  path: "/api/assignments/accept",
};
