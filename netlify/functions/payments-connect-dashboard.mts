import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// Signs a Grade Angel into their own Stripe Express page, where they see
// deposits to their bank, change their bank account, and get tax forms.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") return json({ error: "This is for Grade Angels" }, 403);

  const [me] = await db.sql`SELECT stripe_account_id FROM users WHERE id = ${session.id}`;
  if (!me?.stripe_account_id) return json({ error: "Finish payout setup first" }, 409);
  if (me.stripe_account_id === "acct_test_mode") return json({ error: "Test accounts do not have a Stripe account to open" }, 409);
  try {
    const link = await getStripe().accounts.createLoginLink(me.stripe_account_id);
    return json({ url: link.url }, 200);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) return json({ error: "Payouts open as soon as Stripe is connected" }, 501);
    return json({ error: "Could not open Stripe right now. Please try again." }, 502);
  }
};

export const config: Config = {
  path: "/api/payments/connect/dashboard",
};
