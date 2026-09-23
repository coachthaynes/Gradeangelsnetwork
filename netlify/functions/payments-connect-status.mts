import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// Refreshes whether a Grade Angel's Stripe account can actually receive a
// payout yet, and caches that flag on the user row so the rest of the app
// (like whether they can accept an assignment) does not have to call
// Stripe on every request.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const [user] = await db.sql`
    SELECT stripe_account_id, stripe_payouts_ready FROM users WHERE id = ${session.id}
  `;
  if (!user?.stripe_account_id) {
    return json({ connected: false, payouts_ready: false }, 200);
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    // Grade Angels only receive transfers, so "ready" means the transfers
    // capability is active and Stripe will pay out to their bank.
    // charges_enabled is not used: it can stay false on these accounts.
    const payoutsReady = account.capabilities?.transfers === "active" && Boolean(account.payouts_enabled);
    const detailsSubmitted = Boolean(account.details_submitted);

    if (payoutsReady !== user.stripe_payouts_ready) {
      await db.sql`UPDATE users SET stripe_payouts_ready = ${payoutsReady} WHERE id = ${session.id}`;
    }

    return json({ connected: true, details_submitted: detailsSubmitted, payouts_ready: payoutsReady }, 200);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: err.message }, 501);
    }
    return json({ error: "Could not check Stripe status" }, 502);
  }
};

export const config: Config = {
  path: "/api/payments/connect/status",
};
