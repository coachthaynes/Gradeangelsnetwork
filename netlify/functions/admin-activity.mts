import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { requireStaff } from "../lib/staff.mts";

// The most recent actions taken by staff, newest first.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;
  const actions = await db.sql`
    SELECT x.id, x.action, x.target_type, x.target_id, x.details, x.created_at, u.full_name AS actor
    FROM admin_actions x LEFT JOIN users u ON u.id = x.actor_id
    ORDER BY x.created_at DESC LIMIT 300
  `;
  return json({ actions }, 200);
};

export const config: Config = {
  path: "/api/admin/activity",
};
