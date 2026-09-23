import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// A teacher pays for an assignment once a Grade Angel has accepted it,
// through a Stripe hosted Checkout page. The Grade Angel's own payout does
// not happen here, it happens later, when the teacher marks the finished
// work complete (see assignments-complete.mts). This step only collects
// the money and records it against the assignment.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") {
    return json({ error: "Only the posting teacher can pay for an assignment" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const assignmentId = Number(body.assignment_id);
  const successUrl = String(body.success_url || "");
  const cancelUrl = String(body.cancel_url || successUrl);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (!successUrl) return json({ error: "success_url is required" }, 400);

  const [assignment] = await db.sql`
    SELECT id, teacher_id, title, page_count, rate_per_page_cents, status
    FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.teacher_id !== session.id) return json({ error: "This is not your assignment" }, 403);
  if (assignment.status === "open") {
    return json({ error: "Wait until a Grade Angel accepts this before paying for it" }, 409);
  }

  const [existingPayment] = await db.sql`
    SELECT id, status FROM payments WHERE assignment_id = ${assignmentId} ORDER BY id DESC LIMIT 1
  `;
  if (existingPayment?.status === "paid") {
    return json({ error: "This assignment has already been paid for" }, 409);
  }

  const amountCents = assignment.page_count * assignment.rate_per_page_cents;
  const platformFeeCents = Math.round(amountCents * 0.2);

  try {
    const stripe = getStripe();

    const [payment] = existingPayment
      ? await db.sql`
          SELECT id FROM payments WHERE id = ${existingPayment.id}
        `
      : await db.sql`
          INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status)
          VALUES (${assignmentId}, ${amountCents}, ${platformFeeCents}, 'pending')
          RETURNING id
        `;

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: { name: `Grading: ${assignment.title}` },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { assignment_id: String(assignmentId), payment_id: String(payment.id) },
    });

    await db.sql`
      UPDATE payments SET stripe_checkout_session_id = ${checkoutSession.id} WHERE id = ${payment.id}
    `;

    return json({ url: checkoutSession.url }, 200);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: err.message }, 501);
    }
    return json({ error: "Could not start checkout for this assignment" }, 502);
  }
};

export const config: Config = {
  path: "/api/assignments/pay",
};
