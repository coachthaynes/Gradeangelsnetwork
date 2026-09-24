import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getSetupStatus } from "../lib/grade-angel.mts";
import { getStripe, StripeNotConfiguredError } from "../lib/stripe.mts";

// Sends a Grade Angel to Stripe's hosted onboarding so they can add their
// bank details and identity info. Creates their Express account on first
// call, reuses it on every call after that.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels set up payouts" }, 403);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // No body is fine, the URLs below have defaults.
  }
  const returnUrl = String(body.return_url || "");
  const refreshUrl = String(body.refresh_url || returnUrl);
  if (!returnUrl) {
    return json({ error: "return_url is required so Stripe knows where to send them back" }, 400);
  }

  // Steps 1 to 3 come first so we have someone's details before sending
  // them to an outside service.
  const setup = await getSetupStatus(session.id);
  if (session.role === "grade_angel" && !setup?.info_complete) {
    return json({ error: "Finish steps 1 to 3 of your setup first" }, 409);
  }

  try {
    const stripe = getStripe();

    const [user] = await db.sql`SELECT stripe_account_id, email FROM users WHERE id = ${session.id}`;
    let accountId = user?.stripe_account_id as string | null;

    if (!accountId) {
      const account = await stripe.accounts.create({
        type: "express",
        email: user?.email,
        capabilities: { transfers: { requested: true } },
      });
      accountId = account.id;
      await db.sql`UPDATE users SET stripe_account_id = ${accountId} WHERE id = ${session.id}`;
    }

    const link = await stripe.accountLinks.create({
      account: accountId,
      type: "account_onboarding",
      refresh_url: refreshUrl,
      return_url: returnUrl,
    });

    return json({ url: link.url }, 200);
  } catch (err) {
    if (err instanceof StripeNotConfiguredError) {
      return json({ error: err.message }, 501);
    }
    return json({ error: "Stripe could not start onboarding for that account" }, 502);
  }
};

export const config: Config = {
  path: "/api/payments/connect/start",
};
