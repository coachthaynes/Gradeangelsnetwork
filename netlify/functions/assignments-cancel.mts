import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { deleteAssignmentFiles, readJson, recordEvent } from "../lib/assignments.mts";

// A teacher withdraws an assignment nobody has accepted yet (or a draft
// whose upload never finished). Its pages are deleted right away since
// nobody needs that student work any more. Once a Grade Angel has accepted,
// cancelling becomes a dispute for an admin rather than a button.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Only the posting teacher can cancel" }, 403);

  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const assignmentId = Number(body.assignment_id);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);

  const rows = await db.sql`
    UPDATE assignments
    SET status = 'cancelled', cancelled_at = NOW(), invited_grade_angel_id = NULL
    WHERE id = ${assignmentId} AND teacher_id = ${session.id} AND status IN ('draft', 'open')
    RETURNING id
  `;
  if (rows.length === 0) {
    return json({ error: "Only drafts and assignments nobody has accepted yet can be cancelled" }, 409);
  }

  await deleteAssignmentFiles(assignmentId);
  await recordEvent(assignmentId, session.id, "cancelled");
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/assignments/cancel",
};
