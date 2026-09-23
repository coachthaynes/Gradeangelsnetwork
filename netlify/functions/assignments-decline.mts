import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";

// A Grade Angel turns down an assignment a teacher sent to them. The 2019
// plan requires a reason, which the teacher sees. The assignment then opens
// up to every Grade Angel instead of sitting idle.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") return json({ error: "Only Grade Angels can decline invites" }, 403);

  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const assignmentId = Number(body.assignment_id);
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (reason.length < 3) return json({ error: "Please give the teacher a reason" }, 400);

  const rows = await db.sql`
    UPDATE assignments SET invited_grade_angel_id = NULL
    WHERE id = ${assignmentId} AND status = 'open' AND invited_grade_angel_id = ${session.id}
    RETURNING id
  `;
  if (rows.length === 0) return json({ error: "There is no open invite for you on this assignment" }, 409);

  await recordEvent(assignmentId, session.id, "declined", reason);
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/assignments/decline",
};
