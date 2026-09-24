import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isSuspended } from "../lib/staff.mts";
import { PRO_FIRST_LOOK_MINUTES, PRO_PRICE_CENTS, PRO_TRIAL_DAYS, monthKey, proState } from "../lib/pro.mts";

// Grade Angel Pro: GET shows the plan and this person's status; POST
// { action: "start", agree: true } joins (with a free trial the first
// time), and { action: "cancel" } leaves right away.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") return json({ error: "Grade Angel Pro is for Grade Angels" }, 403);

  if (req.method === "POST") {
    if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
    const body = await readJson(req);
    if (body?.action === "start") {
      if (body.agree !== true) return json({ error: "Please agree to the Grade Angel Pro terms" }, 400);
      await db.sql`
        UPDATE users
        SET pro_started_at = NOW(), pro_ended_at = NULL, pro_terms_accepted_at = NOW(),
            -- The free trial is for a Grade Angel's first time only.
            pro_trial_ends_at = CASE WHEN pro_trial_ends_at IS NULL THEN NOW() + make_interval(days => ${PRO_TRIAL_DAYS}) ELSE pro_trial_ends_at END
        WHERE id = ${session.id} AND (pro_started_at IS NULL OR pro_ended_at IS NOT NULL)
      `;
    } else if (body?.action === "cancel") {
      await db.sql`UPDATE users SET pro_ended_at = NOW() WHERE id = ${session.id} AND pro_started_at IS NOT NULL AND pro_ended_at IS NULL`;
    } else {
      return json({ error: "Unknown action" }, 400);
    }
  } else if (req.method !== "GET") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const [u] = await db.sql`SELECT pro_started_at, pro_ended_at, pro_trial_ends_at FROM users WHERE id = ${session.id}`;
  const [month] = await db.sql`
    SELECT COALESCE(SUM(amount_cents), 0)::int AS cents FROM pro_charges WHERE user_id = ${session.id} AND month = ${monthKey()}
  `;
  return json({
    ...proState(u),
    trial_available: !u.pro_trial_ends_at,
    price_cents: PRO_PRICE_CENTS,
    trial_days: PRO_TRIAL_DAYS,
    first_look_minutes: PRO_FIRST_LOOK_MINUTES,
    charged_this_month_cents: month.cents,
  }, 200);
};

export const config: Config = {
  path: "/api/pro",
};
