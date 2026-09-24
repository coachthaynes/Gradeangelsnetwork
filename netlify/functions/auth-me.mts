import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { clearCookieHeader, getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ user: null }, 200);

  const rows = await db.sql`
    SELECT id, email, role, full_name, school_or_org, subjects, background_check_status,
           stripe_payouts_ready, profile_completed_at, display_name, photo_updated_at, staff_level,
           suspended_at, created_at
    FROM users WHERE id = ${session.id}
  `;
  const user = rows[0] || null;
  // A suspended account is signed out on its next page load.
  if (user?.suspended_at) return json({ user: null, suspended: true }, 200, { "set-cookie": clearCookieHeader() });
  if (user) delete user.suspended_at;
  return json({ user }, 200);
};

export const config: Config = {
  path: "/api/auth/me",
};
