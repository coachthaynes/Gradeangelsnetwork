import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";

// A Grade Angel who accepted an assignment but cannot finish it hands it
// back, with a reason for the teacher. It goes back on the open board so
// another Grade Angel can pick it up. Any payment the teacher already made
// stays attached to the assignment and goes to whoever completes it.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") return json({ error: "Only Grade Angels can hand work back" }, 403);

  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const assignmentId = Number(body.assignment_id);
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (reason.length < 3) return json({ error: "Please give the teacher a reason" }, 400);

  const rows = await db.sql`
    UPDATE assignments
    SET status = 'open', grade_angel_id = NULL, accepted_at = NULL, due_at = NULL
    WHERE id = ${assignmentId} AND status = 'accepted' AND grade_angel_id = ${session.id}
    RETURNING id
  `;
  if (rows.length === 0) return json({ error: "You can only hand back work you accepted and have not submitted" }, 409);

  await recordEvent(assignmentId, session.id, "handed_back", reason);
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/assignments/release",
};
