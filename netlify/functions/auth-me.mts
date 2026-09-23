import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ user: null }, 200);

  const rows = await db.sql`
    SELECT id, email, role, full_name, school_or_org, subjects, background_check_status,
           stripe_charges_enabled, created_at
    FROM users WHERE id = ${session.id}
  `;
  const user = rows[0] || null;
  return json({ user }, 200);
};

export const config: Config = {
  path: "/api/auth/me",
};
