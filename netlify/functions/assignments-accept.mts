import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

// A Grade Angel claims an open assignment. The WHERE clause checks
// status = 'open' as part of the same update, so two Grade Angels racing
// for the same assignment cannot both win it.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels can accept assignments" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const assignmentId = Number(body.assignment_id);
  if (!Number.isInteger(assignmentId)) {
    return json({ error: "assignment_id is required" }, 400);
  }

  const rows = await db.sql`
    UPDATE assignments
    SET grade_angel_id = ${session.id}, status = 'accepted', accepted_at = NOW()
    WHERE id = ${assignmentId} AND status = 'open'
    RETURNING id, teacher_id, grade_angel_id, title, subject, grade_level, assignment_type,
              page_count, rate_per_page_cents, status, created_at, accepted_at
  `;

  if (rows.length === 0) {
    const [existing] = await db.sql`SELECT id, status FROM assignments WHERE id = ${assignmentId}`;
    if (!existing) return json({ error: "Assignment not found" }, 404);
    return json({ error: "That assignment is no longer open" }, 409);
  }

  return json({ assignment: rows[0] }, 200);
};

export const config: Config = {
  path: "/api/assignments/accept",
};
