import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isMasterEmail, logAction, masterEmails, requireMaster } from "../lib/staff.mts";

const LEVELS = new Set(["support", "manager", "owner"]);

// The master admin's controls over staff access.
// GET: pending requests, staff, pre-approved emails, and recent access changes.
// POST { action, ... }:
//   approve      { user_id, staff_level }  let a pending request in
//   deny         { user_id }               delete a pending request
//   set_level    { user_id, staff_level }
//   revoke       { user_id }               sign them out and block access
//   restore      { user_id }
//   invite       { email, staff_level }    pre-approve an email
//   uninvite     { email }
export default async (req: Request) => {
  const master = await requireMaster(req);
  if (master instanceof Response) return master;

  if (req.method === "GET") {
    const people = await db.sql`
      SELECT u.id, u.email, u.full_name, u.staff_level, u.staff_requested_at, u.staff_approved_at,
             u.suspended_at, u.created_at, ap.full_name AS approved_by,
             (SELECT MAX(created_at) FROM admin_actions WHERE actor_id = u.id) AS last_action_at,
             (SELECT COUNT(*)::int FROM admin_actions WHERE actor_id = u.id) AS action_count
      FROM users u LEFT JOIN users ap ON ap.id = u.staff_approved_by
      WHERE u.role = 'admin'
      ORDER BY u.created_at
    `;
    const withMaster = people.map((p: any) => ({ ...p, is_master: isMasterEmail(p.email) }));
    const invites = await db.sql`
      SELECT i.email, i.staff_level, i.created_at, u.full_name AS invited_by
      FROM staff_invites i LEFT JOIN users u ON u.id = i.invited_by ORDER BY i.created_at DESC
    `;
    const changes = await db.sql`
      SELECT x.action, x.details, x.created_at, u.full_name AS actor
      FROM admin_actions x LEFT JOIN users u ON u.id = x.actor_id
      WHERE x.action IN ('approved staff', 'denied staff', 'changed staff access', 'revoked staff', 'restored staff',
                         'pre-approved staff email', 'removed pre-approval', 'requested staff access',
                         'joined staff from pre-approval')
      ORDER BY x.created_at DESC LIMIT 100
    `;
    return json(
      {
        pending: withMaster.filter((p: any) => !p.is_master && !p.staff_approved_at && !p.suspended_at),
        staff: withMaster.filter((p: any) => p.is_master || p.staff_approved_at || p.suspended_at),
        invites,
        changes,
        masters: masterEmails(),
      },
      200
    );
  }
  if (req.method !== "POST") return methodNotAllowed(["GET", "POST"]);

  const body = await readJson(req);
  const action = String(body?.action || "");
  const actor = master.session.id;

  if (action === "invite" || action === "uninvite") {
    const email = String(body?.email || "").trim().toLowerCase();
    if (!email.includes("@")) return json({ error: "A valid email is required" }, 400);
    if (action === "uninvite") {
      await db.sql`DELETE FROM staff_invites WHERE email = ${email}`;
      await logAction(actor, "removed pre-approval", null, null, email);
      return json({ ok: true }, 200);
    }
    const level = String(body?.staff_level || "support");
    if (!LEVELS.has(level)) return json({ error: "Choose an access level" }, 400);
    const [existing] = await db.sql`SELECT id, role FROM users WHERE email = ${email}`;
    if (existing && existing.role !== "admin") {
      return json({ error: "That email is a teacher or Grade Angel account. Staff need their own email." }, 409);
    }
    if (existing) return json({ error: "That email already requested access. Approve it in the list above." }, 409);
    await db.sql`
      INSERT INTO staff_invites (email, staff_level, invited_by) VALUES (${email}, ${level}, ${actor})
      ON CONFLICT (email) DO UPDATE SET staff_level = EXCLUDED.staff_level, invited_by = EXCLUDED.invited_by
    `;
    await logAction(actor, "pre-approved staff email", null, null, `${email} as ${level}`);
    return json({ ok: true }, 200);
  }

  const userId = Number(body?.user_id);
  if (!Number.isInteger(userId)) return json({ error: "user_id is required" }, 400);
  const [target] = await db.sql`
    SELECT id, email, full_name, staff_approved_at FROM users WHERE id = ${userId} AND role = 'admin'
  `;
  if (!target) return json({ error: "Staff member not found" }, 404);
  if (isMasterEmail(target.email)) return json({ error: "Master admin access cannot be changed here" }, 400);

  if (action === "approve") {
    const level = String(body?.staff_level || "support");
    if (!LEVELS.has(level)) return json({ error: "Choose an access level" }, 400);
    await db.sql`
      UPDATE users SET staff_approved_at = NOW(), staff_approved_by = ${actor}, staff_level = ${level},
                       suspended_at = NULL, suspended_reason = NULL
      WHERE id = ${userId}
    `;
    await logAction(actor, "approved staff", "user", userId, `${target.full_name} (${target.email}) as ${level}`);
  } else if (action === "deny") {
    if (target.staff_approved_at) return json({ error: "Revoke an approved staff member instead" }, 409);
    await db.sql`DELETE FROM users WHERE id = ${userId} AND staff_approved_at IS NULL`;
    await logAction(actor, "denied staff", null, null, `${target.full_name} (${target.email})`);
  } else if (action === "set_level") {
    const level = String(body?.staff_level || "");
    if (!LEVELS.has(level)) return json({ error: "Choose an access level" }, 400);
    await db.sql`UPDATE users SET staff_level = ${level} WHERE id = ${userId}`;
    await logAction(actor, "changed staff access", "user", userId, `${target.full_name}: ${level}`);
  } else if (action === "revoke") {
    await db.sql`UPDATE users SET suspended_at = NOW(), suspended_reason = 'Staff access revoked' WHERE id = ${userId}`;
    await logAction(actor, "revoked staff", "user", userId, target.full_name);
  } else if (action === "restore") {
    await db.sql`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ${userId}`;
    await logAction(actor, "restored staff", "user", userId, target.full_name);
  } else {
    return json({ error: "Unknown action" }, 400);
  }
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/admin/master",
};
