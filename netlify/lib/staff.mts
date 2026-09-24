import { db } from "./db.mts";
import { getSession, type SessionPayload } from "./auth.mts";
import { json } from "./http.mts";

export type StaffLevel = "support" | "manager" | "owner";
const RANK: Record<StaffLevel, number> = { support: 1, manager: 2, owner: 3 };

export interface StaffContext {
  session: SessionPayload;
  level: StaffLevel;
  name: string;
}

// Checks the request comes from a staff member at `minimum` level or above,
// reading the level fresh from the database so a change (or removal) takes
// effect immediately. Returns the staff context, or a Response to send back.
export async function requireStaff(req: Request, minimum: StaffLevel = "support"): Promise<StaffContext | Response> {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  const [user] = await db.sql`SELECT role, staff_level, full_name, suspended_at FROM users WHERE id = ${session.id}`;
  if (!user || user.role !== "admin" || user.suspended_at) return json({ error: "Staff only" }, 403);
  const level = (user.staff_level || "support") as StaffLevel;
  if (RANK[level] < RANK[minimum]) {
    return json({ error: `This needs ${minimum} access. Ask the site owner.` }, 403);
  }
  return { session, level, name: user.full_name };
}

export function can(level: StaffLevel, minimum: StaffLevel): boolean {
  return RANK[level] >= RANK[minimum];
}

export async function logAction(
  actorId: number,
  action: string,
  targetType: string | null,
  targetId: number | null,
  details: string | null = null
) {
  await db.sql`
    INSERT INTO admin_actions (actor_id, action, target_type, target_id, details)
    VALUES (${actorId}, ${action}, ${targetType}, ${targetId}, ${details})
  `;
}

// Emails listed in the OWNER_EMAILS setting become site owners when they
// sign up. This is how the very first owner account gets created.
export function isOwnerEmail(email: string): boolean {
  const list = (Netlify.env.get("OWNER_EMAILS") || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.toLowerCase());
}

// True when an account has been suspended by staff. Checked on sign in and
// by the endpoints that change things, so a suspension takes effect even
// while someone's old sign in is still valid.
export async function isSuspended(userId: number): Promise<boolean> {
  const [user] = await db.sql`SELECT suspended_at FROM users WHERE id = ${userId}`;
  return Boolean(user?.suspended_at);
}
