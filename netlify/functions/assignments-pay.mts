import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isSuspended } from "../lib/staff.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";
import { PLATFORM_FEE_RATE } from "../lib/grade-angel.mts";
import { applyGiftToPayment } from "../lib/gifts.mts";
import { recordEvent } from "../lib/assignments.mts";

// A teacher pays for an assignment once a Grade Angel has accepted it.
// Gift money from Gift Angels is spent first; whatever is left is paid on
// a Stripe hosted Checkout page. When gifts cover it all, no card is needed. The Grade Angel's own payout does
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

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
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
  if (assignment.status === "cancelled") {
    return json({ error: "This assignment was cancelled" }, 409);
  }
  if (assignment.status === "open" || assignment.status === "draft") {
    return json({ error: "Wait until a Grade Angel accepts this before paying for it" }, 409);
  }

  const [existingPayment] = await db.sql`
    SELECT id, status, stripe_checkout_session_id FROM payments WHERE assignment_id = ${assignmentId} ORDER BY id DESC LIMIT 1
  `;
  if (existingPayment?.status === "paid") {
    return json({ error: "This assignment has already been paid for" }, 409);
  }

  const amountCents = assignment.page_count * assignment.rate_per_page_cents;
  const platformFeeCents = Math.round(amountCents * PLATFORM_FEE_RATE);

  // If gift money cannot cover it all, a card payment is needed. Check
  // Stripe is connected before setting anything aside.
  const useGift = body.use_gift !== false;
  const [{ gift_balance_cents: balanceCents }] = await db.sql`SELECT gift_balance_cents FROM users WHERE id = ${session.id}`;
  const [{ gift_cents: alreadySetAside = 0 } = {}] = existingPayment
    ? await db.sql`SELECT gift_cents FROM payments WHERE id = ${existingPayment.id}`
    : [];
  if (alreadySetAside + (useGift ? balanceCents : 0) < amountCents) {
    try {
      getStripe();
    } catch (err) {
      if (err instanceof StripeNotConfiguredError) return json({ error: err.message }, 501);
      throw err;
    }
  }

  // One payment row per assignment, reused if an earlier checkout was
  // abandoned, so gift money already set aside for it stays with it.
  let paymentId: number;
  if (existingPayment && existingPayment.status !== "refunded") {
    paymentId = existingPayment.id;
    await db.sql`UPDATE payments SET status = 'pending' WHERE id = ${paymentId} AND status = 'failed'`;
  } else {
    const [created] = await db.sql`
      INSERT INTO payments (assignment_id, amount_cents, platform_fee_cents, status)
      VALUES (${assignmentId}, ${amountCents}, ${platformFeeCents}, 'pending')
      RETURNING id
    `;
    paymentId = created.id;
  }

  // Gift money from Gift Angels is used first, unless the teacher says not to.
  const giftCents =
    !useGift
      ? ((await db.sql`SELECT gift_cents FROM payments WHERE id = ${paymentId}`)[0]?.gift_cents ?? 0)
      : await applyGiftToPayment(paymentId, session.id, amountCents);

  if (giftCents >= amountCents) {
    await db.sql`UPDATE payments SET status = 'paid', paid_at = NOW() WHERE id = ${paymentId} AND status = 'pending'`;
    await recordEvent(assignmentId, session.id, "paid_with_gift");
    return json({ paid: true, gift_cents: giftCents }, 200);
  }

  try {
    const stripe = getStripe();

    // An older checkout page for this assignment may still be open, and it
    // was for a different amount. Close it so it cannot be paid as well.
    if (existingPayment?.stripe_checkout_session_id) {
      await stripe.checkout.sessions.expire(existingPayment.stripe_checkout_session_id).catch(() => {});
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents - giftCents,
            product_data: {
              name: `Grading: ${assignment.title}`,
              ...(giftCents > 0
                ? { description: `Total ${(amountCents / 100).toFixed(2)} dollars, with ${(giftCents / 100).toFixed(2)} covered by Gift Angels` }
                : {}),
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: { assignment_id: String(assignmentId), payment_id: String(paymentId) },
    });

    await db.sql`
      UPDATE payments SET stripe_checkout_session_id = ${checkoutSession.id} WHERE id = ${paymentId}
    `;

    return json({ url: checkoutSession.url, gift_cents: giftCents }, 200);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: err.message, gift_cents: giftCents }, 501);
    }
    return json({ error: "Could not start checkout for this assignment", gift_cents: giftCents }, 502);
  }
};

export const config: Config = {
  path: "/api/assignments/pay",
};
