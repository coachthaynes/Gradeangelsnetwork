import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { attemptPayout } from "../lib/payouts.mts";
import { recordEvent } from "../lib/assignments.mts";

// The teacher reviews the graded work and marks the assignment complete.
// This is also the moment the Grade Angel actually gets paid: their 80%
// share transfers to their connected Stripe account right here, which is
// the timing the user chose (payout happens once the teacher verifies the
// work is done, not on a schedule). It requires the teacher to have
// already paid for the assignment through assignments-pay.mts. If the
// payout cannot go out right now it is held or retried by payouts-retry.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") {
    return json({ error: "Only the posting teacher can close out an assignment" }, 403);
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

  const [assignment] = await db.sql`
    SELECT id, teacher_id, grade_angel_id, status FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.teacher_id !== session.id) {
    return json({ error: "This is not your assignment" }, 403);
  }
  if (assignment.status !== "submitted") {
    return json({ error: "This assignment has not been submitted yet" }, 409);
  }

  const [payment] = await db.sql`
    SELECT id, status
    FROM payments WHERE assignment_id = ${assignmentId} ORDER BY id DESC LIMIT 1
  `;
  if (!payment || payment.status !== "paid") {
    return json({ error: "Pay for this assignment before marking it complete" }, 402);
  }

  const [updated] = await db.sql`
    UPDATE assignments
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${assignmentId} AND status = 'submitted'
    RETURNING id, teacher_id, grade_angel_id, title, status, created_at, completed_at
  `;
  if (!updated) return json({ error: "This assignment was already marked complete" }, 409);

  await recordEvent(assignmentId, session.id, "completed");
  const payout = await attemptPayout(assignmentId);
  const payoutNote = payout.note;

  return json({ assignment: updated, payout_note: payoutNote }, 200);
};

export const config: Config = {
  path: "/api/assignments/complete",
};
