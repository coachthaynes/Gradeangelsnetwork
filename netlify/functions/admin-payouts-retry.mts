import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { attemptPayout, refreshPayoutsReady } from "../lib/payouts.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

// Lets an admin retry one Grade Angel payout by hand, for example after it
// used up its automatic retries or once a Stripe problem has been fixed.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const staff = await requireStaff(req, "manager");
  if (staff instanceof Response) return staff;

  const body = await readJson(req);
  const assignmentId = Number(body?.assignment_id);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);

  const [row] = await db.sql`
    SELECT u.id, u.stripe_account_id FROM assignments a JOIN users u ON u.id = a.grade_angel_id
    WHERE a.id = ${assignmentId}
  `;
  if (row?.stripe_account_id) await refreshPayoutsReady(row.id, row.stripe_account_id);

  const result = await attemptPayout(assignmentId);
  await logAction(staff.session.id, "retried payout", "assignment", assignmentId, `${result.status}: ${result.note}`);
  return json(result, 200);
};

export const config: Config = {
  path: "/api/admin/payouts/retry",
};
