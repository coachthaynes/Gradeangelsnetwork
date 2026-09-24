import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { attemptPayout, refreshPayoutsReady } from "../lib/payouts.mts";

// Lets an admin retry one Grade Angel payout by hand, for example after it
// used up its automatic retries or once a Stripe problem has been fixed.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "admin") return json({ error: "Admins only" }, 403);

  const body = await readJson(req);
  const assignmentId = Number(body?.assignment_id);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);

  const [row] = await db.sql`
    SELECT u.id, u.stripe_account_id FROM assignments a JOIN users u ON u.id = a.grade_angel_id
    WHERE a.id = ${assignmentId}
  `;
  if (row?.stripe_account_id) await refreshPayoutsReady(row.id, row.stripe_account_id);

  const result = await attemptPayout(assignmentId);
  return json(result, 200);
};

export const config: Config = {
  path: "/api/admin/payouts/retry",
};
