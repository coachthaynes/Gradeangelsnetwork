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
    SELECT stripe_account_id, stripe_charges_enabled FROM users WHERE id = ${session.id}
  `;
  if (!user?.stripe_account_id) {
    return json({ connected: false, charges_enabled: false }, 200);
  }

  try {
    const stripe = getStripe();
    const account = await stripe.accounts.retrieve(user.stripe_account_id);
    const chargesEnabled = Boolean(account.charges_enabled);

    if (chargesEnabled !== user.stripe_charges_enabled) {
      await db.sql`UPDATE users SET stripe_charges_enabled = ${chargesEnabled} WHERE id = ${session.id}`;
    }

    return json({ connected: true, charges_enabled: chargesEnabled }, 200);
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
