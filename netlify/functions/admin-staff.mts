import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isMasterEmail, requireStaff } from "../lib/staff.mts";

// The staff list, visible to all approved staff. Only the master admin can
// change staff access, from the Master admin tab (admin-master.mts).
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;
  const members = await db.sql`
    SELECT id, email, full_name, staff_level, suspended_at, staff_approved_at, created_at,
           (SELECT MAX(created_at) FROM admin_actions WHERE actor_id = users.id) AS last_action_at
    FROM users WHERE role = 'admin' AND (staff_approved_at IS NOT NULL OR suspended_at IS NOT NULL)
    ORDER BY suspended_at NULLS FIRST, created_at
  `;
  const masters = await db.sql`SELECT id, email, full_name, staff_level, suspended_at, created_at FROM users WHERE role = 'admin'`;
  const byId = new Map(members.map((m: any) => [m.id, m]));
  for (const m of masters) if (isMasterEmail(m.email) && !byId.has(m.id)) byId.set(m.id, { ...m, last_action_at: null });
  return json(
    {
      staff: [...byId.values()].map((m: any) => ({ ...m, is_master: isMasterEmail(m.email), staff_level: isMasterEmail(m.email) ? "owner" : m.staff_level })),
      me: { id: staff.session.id, level: staff.level, is_master: staff.isMaster },
    },
    200
  );
};

export const config: Config = {
  path: "/api/admin/staff",
};
