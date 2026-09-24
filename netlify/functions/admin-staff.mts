import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { hashPassword } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { logAction, requireStaff } from "../lib/staff.mts";

const LEVELS = new Set(["support", "manager", "owner"]);

// GET lists staff (anyone on staff). POST, owners only:
//   { action: "add", email, full_name, password, staff_level }
//   { action: "set_level", user_id, staff_level }
//   { action: "remove", user_id }   suspends the staff account
export default async (req: Request) => {
  if (req.method === "GET") {
    const staff = await requireStaff(req);
    if (staff instanceof Response) return staff;
    const members = await db.sql`
      SELECT id, email, full_name, staff_level, suspended_at, created_at,
             (SELECT MAX(created_at) FROM admin_actions WHERE actor_id = users.id) AS last_action_at
      FROM users WHERE role = 'admin' ORDER BY suspended_at NULLS FIRST, created_at
    `;
    return json({ staff: members, me: { id: staff.session.id, level: staff.level } }, 200);
  }
  if (req.method !== "POST") return methodNotAllowed(["GET", "POST"]);

  const owner = await requireStaff(req, "owner");
  if (owner instanceof Response) return owner;
  const body = await readJson(req);
  const action = String(body?.action || "");

  if (action === "add") {
    const email = String(body?.email || "").trim().toLowerCase();
    const fullName = String(body?.full_name || "").trim();
    const password = String(body?.password || "");
    const level = String(body?.staff_level || "support");
    if (!email.includes("@")) return json({ error: "A valid email is required" }, 400);
    if (!fullName) return json({ error: "Full name is required" }, 400);
    if (password.length < 10) return json({ error: "Use a temporary password of at least 10 characters" }, 400);
    if (!LEVELS.has(level)) return json({ error: "Choose an access level" }, 400);
    const [existing] = await db.sql`SELECT id FROM users WHERE email = ${email}`;
    if (existing) return json({ error: "That email already has an account. Staff need their own email." }, 409);

    const [user] = await db.sql`
      INSERT INTO users (email, password_hash, role, full_name, staff_level)
      VALUES (${email}, ${await hashPassword(password)}, 'admin', ${fullName}, ${level})
      RETURNING id
    `;
    await logAction(owner.session.id, "added staff", "user", user.id, `${fullName} (${email}) as ${level}`);
    return json({ ok: true }, 201);
  }

  const userId = Number(body?.user_id);
  if (!Number.isInteger(userId)) return json({ error: "user_id is required" }, 400);
  if (userId === owner.session.id) return json({ error: "You cannot change your own access" }, 400);
  const [target] = await db.sql`SELECT id, full_name FROM users WHERE id = ${userId} AND role = 'admin'`;
  if (!target) return json({ error: "Staff member not found" }, 404);

  if (action === "set_level") {
    const level = String(body?.staff_level || "");
    if (!LEVELS.has(level)) return json({ error: "Choose an access level" }, 400);
    await db.sql`UPDATE users SET staff_level = ${level} WHERE id = ${userId}`;
    await logAction(owner.session.id, "changed staff access", "user", userId, `${target.full_name}: ${level}`);
  } else if (action === "remove") {
    await db.sql`UPDATE users SET suspended_at = NOW(), suspended_reason = 'Removed from staff' WHERE id = ${userId}`;
    await logAction(owner.session.id, "removed staff", "user", userId, target.full_name);
  } else if (action === "restore") {
    await db.sql`UPDATE users SET suspended_at = NULL, suspended_reason = NULL WHERE id = ${userId}`;
    await logAction(owner.session.id, "restored staff", "user", userId, target.full_name);
  } else {
    return json({ error: "Unknown action" }, 400);
  }
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/admin/staff",
};
