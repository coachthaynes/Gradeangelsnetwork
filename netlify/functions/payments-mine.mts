import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe } from "../lib/stripe.mts";

// A teacher's payments: GET lists them; GET ?receipt=<payment id> sends
// them to Stripe's receipt for that card payment.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Payments are for teachers" }, 403);

  const receiptFor = new URL(req.url).searchParams.get("receipt");
  if (receiptFor) {
    const [p] = await db.sql`
      SELECT p.stripe_charge_id, p.stripe_payment_intent_id FROM payments p JOIN assignments a ON a.id = p.assignment_id
      WHERE p.id = ${Number(receiptFor)} AND a.teacher_id = ${session.id} AND p.status IN ('paid', 'refunded')
    `;
    if (!p || (!p.stripe_charge_id && !p.stripe_payment_intent_id)) return json({ error: "No card receipt for this payment" }, 404);
    try {
      const stripe = getStripe();
      let chargeId = p.stripe_charge_id;
      if (!chargeId) {
        const intent = await stripe.paymentIntents.retrieve(p.stripe_payment_intent_id);
        chargeId = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
      }
      const charge = await stripe.charges.retrieve(chargeId);
      if (!charge.receipt_url) return json({ error: "Stripe has no receipt for this payment" }, 404);
      return new Response(null, { status: 302, headers: { location: charge.receipt_url } });
    } catch {
      return json({ error: "Could not load the receipt right now" }, 502);
    }
  }

  const payments = await db.sql`
    SELECT p.id, a.id AS assignment_id, a.title, p.amount_cents, p.service_fee_cents, p.gift_cents, p.status, p.paid_at, p.test_mode,
           (p.stripe_charge_id IS NOT NULL OR p.stripe_payment_intent_id IS NOT NULL) AS has_receipt
    FROM payments p JOIN assignments a ON a.id = p.assignment_id
    WHERE a.teacher_id = ${session.id} AND p.status IN ('paid', 'refunded')
    ORDER BY p.paid_at DESC NULLS LAST
    LIMIT 200
  `;
  const year = new Date().getFullYear();
  const thisYear = payments.filter((p: any) => p.status === "paid" && p.paid_at && new Date(p.paid_at).getFullYear() === year);
  return json({
    payments,
    year,
    paid_this_year_cents: thisYear.reduce((t: number, p: any) => t + p.amount_cents + p.service_fee_cents - p.gift_cents, 0),
    gifts_this_year_cents: thisYear.reduce((t: number, p: any) => t + p.gift_cents, 0),
  }, 200);
};

export const config: Config = {
  path: "/api/payments/mine",
};
