import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// Stripe calls this when a Checkout session finishes. Like the Checkr
// webhook, there is no signed in person here, Stripe proves itself with a
// signature instead, checked against STRIPE_WEBHOOK_SECRET (from the
// webhook's settings in the Stripe dashboard, not the same secret as the
// API key). Until that is set, the signature check is skipped with a note,
// so local testing is not blocked on having it yet.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const rawBody = await req.text();
  const secret = Netlify.env.get("STRIPE_WEBHOOK_SECRET");
  const signature = req.headers.get("stripe-signature") || "";

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
  const paymentId = Number(checkoutSession?.metadata?.payment_id);
  const paymentIntentId = checkoutSession?.payment_intent as string | undefined;
  if (!Number.isInteger(paymentId)) return json({ ok: true }, 200);

  await db.sql`
    UPDATE payments
    SET status = 'paid', paid_at = NOW(), stripe_payment_intent_id = ${paymentIntentId || null}
    WHERE id = ${paymentId}
  `;

  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/stripe/webhook",
};
