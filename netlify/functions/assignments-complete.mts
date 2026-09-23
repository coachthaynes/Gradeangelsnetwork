import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// The teacher reviews the graded work and marks the assignment complete.
// This is also the moment the Grade Angel actually gets paid: their 80%
// share transfers to their connected Stripe account right here, which is
// the timing the user chose (payout happens once the teacher verifies the
// work is done, not on a schedule). It requires the teacher to have
// already paid for the assignment through assignments-pay.mts.
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
    SELECT id, amount_cents, platform_fee_cents, status, payout_status
    FROM payments WHERE assignment_id = ${assignmentId} ORDER BY id DESC LIMIT 1
  `;
  if (!payment || payment.status !== "paid") {
    return json({ error: "Pay for this assignment before marking it complete" }, 402);
  }

  const [updated] = await db.sql`
    UPDATE assignments
    SET status = 'completed', completed_at = NOW()
    WHERE id = ${assignmentId}
    RETURNING id, teacher_id, grade_angel_id, title, status, created_at, completed_at
  `;

  let payoutNote = "Payout already sent earlier.";
  if (payment.payout_status !== "transferred" && assignment.grade_angel_id) {
    const [gradeAngel] = await db.sql`
      SELECT stripe_account_id, stripe_charges_enabled FROM users WHERE id = ${assignment.grade_angel_id}
    `;

    if (!gradeAngel?.stripe_account_id || !gradeAngel.stripe_charges_enabled) {
      payoutNote = "The Grade Angel has not finished setting up payouts yet, their share is on hold until they do.";
    } else {
      try {
        const stripe = getStripe();
        const payoutAmount = payment.amount_cents - payment.platform_fee_cents;
        const transfer = await stripe.transfers.create({
          amount: payoutAmount,
          currency: "usd",
          destination: gradeAngel.stripe_account_id,
          transfer_group: `assignment_${assignmentId}`,
        });
        await db.sql`
          UPDATE payments
          SET payout_status = 'transferred', stripe_transfer_id = ${transfer.id}, transferred_at = NOW()
          WHERE id = ${payment.id}
        `;
        payoutNote = "Payout sent to the Grade Angel.";
      } catch (err) {
        await db.sql`UPDATE payments SET payout_status = 'failed' WHERE id = ${payment.id}`;
        payoutNote =
          err instanceof StripeNotConfiguredError
            ? err.message
            : "The assignment is marked complete, but the payout could not be sent. Check Stripe and try again.";
      }
    }
  }

  return json({ assignment: updated, payout_note: payoutNote }, 200);
};

export const config: Config = {
  path: "/api/assignments/complete",
};
