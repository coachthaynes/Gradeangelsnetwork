import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

// A Grade Angel's payouts: every graded assignment with what they earned,
// whether it has been sent, and when.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") return json({ error: "Payouts are for Grade Angels" }, 403);

  const payouts = await db.sql`
    SELECT a.id AS assignment_id, a.title, a.status, a.completed_at,
           p.amount_cents - p.platform_fee_cents AS earned_cents, p.payout_status, p.transferred_at, p.test_mode
    FROM assignments a
    JOIN LATERAL (SELECT * FROM payments WHERE assignment_id = a.id AND status = 'paid' ORDER BY id DESC LIMIT 1) p ON true
    WHERE a.grade_angel_id = ${session.id} AND a.status IN ('submitted', 'completed')
    ORDER BY COALESCE(p.transferred_at, a.completed_at, a.submitted_at) DESC
    LIMIT 200
  `;
  const year = new Date().getFullYear();
  const paidThisYear = payouts
    .filter((p: any) => p.payout_status === "transferred" && p.transferred_at && new Date(p.transferred_at).getFullYear() === year)
    .reduce((t: number, p: any) => t + p.earned_cents, 0);
  const [me] = await db.sql`SELECT stripe_account_id, stripe_payouts_ready FROM users WHERE id = ${session.id}`;
  return json({
    payouts,
    paid_this_year_cents: paidThisYear,
    year,
    has_stripe: Boolean(me?.stripe_account_id && me.stripe_account_id !== "acct_test_mode"),
  }, 200);
};

export const config: Config = {
  path: "/api/payouts/mine",
};
