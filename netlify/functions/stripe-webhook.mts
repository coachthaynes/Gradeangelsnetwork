import type { Config, Context } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";
import { creditPaidGift, sendGiftEmails } from "../lib/gifts.mts";

// Stripe calls this when a Checkout session finishes. Like the Checkr
// webhook, there is no signed in person here, Stripe proves itself with a
// signature instead, checked against STRIPE_WEBHOOK_SECRET (from the
// webhook's settings in the Stripe dashboard, not the same secret as the
// API key). Marking a payment paid is what later releases money to a
// Grade Angel, so on a real deploy an unsigned request is always refused.
// Only local `netlify dev` may skip the check, so testing is not blocked on
// having the secret yet.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const rawBody = await req.text();
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const signature = req.headers.get("stripe-signature") || "";

  if (!secret && context.deploy?.context !== "dev") {
    return json({ error: "STRIPE_WEBHOOK_SECRET is not set, so this webhook cannot verify requests" }, 503);
  }

  let event: any;
  try {
    const stripe = getStripe();
    if (secret) {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } else {
      event = JSON.parse(rawBody);
    }
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: err.message }, 501);
    }
    return json({ error: "Invalid webhook payload or signature" }, 400);
  }

  if (event.type !== "checkout.session.completed") {
    // Acknowledge everything else so Stripe does not keep retrying it.
    return json({ ok: true }, 200);
  }

  const checkoutSession = event.data?.object;

  // A Gift Angel's gift rather than a teacher paying for an assignment.
  if (checkoutSession?.metadata?.kind === "gift") {
    const giftId = Number(checkoutSession.metadata.gift_id);
    if (!Number.isInteger(giftId) || checkoutSession.payment_status !== "paid") return json({ ok: true }, 200);
    const gift = await creditPaidGift(giftId, (checkoutSession.payment_intent as string) || null);
    if (gift) await sendGiftEmails(gift);
    return json({ ok: true }, 200);
  }

  const paymentId = Number(checkoutSession?.metadata?.payment_id);
  const paymentIntentId = checkoutSession?.payment_intent as string | undefined;
  if (!Number.isInteger(paymentId)) return json({ ok: true }, 200);

  // Card payments arrive as "paid" here. Slower methods (bank debits) can
  // complete checkout while still "unpaid"; those are not marked paid.
  if (checkoutSession?.payment_status !== "paid") return json({ ok: true }, 200);

  // Remember the charge so the Grade Angel's transfer can name it as its
  // source (see lib/payouts.mts). If this lookup fails, the payout code
  // looks it up again later.
  let chargeId: string | null = null;
  if (paymentIntentId) {
    try {
      const intent = await getStripe().paymentIntents.retrieve(paymentIntentId);
      const latest = intent.latest_charge;
      chargeId = typeof latest === "string" ? latest : latest?.id ?? null;
    } catch {
      chargeId = null;
    }
  }

  await db.sql`
    UPDATE payments
    SET status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${paymentIntentId || null},
        stripe_charge_id = COALESCE(${chargeId}, stripe_charge_id)
    WHERE id = ${paymentId}
  `;

  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/stripe/webhook",
};
