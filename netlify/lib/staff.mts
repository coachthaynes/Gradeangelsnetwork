import { db } from "./db.mts";
import { getSession, type SessionPayload } from "./auth.mts";
import { json } from "./http.mts";

export type StaffLevel = "support" | "manager" | "owner";
const RANK: Record<StaffLevel, number> = { support: 1, manager: 2, owner: 3 };

export interface StaffContext {
  session: SessionPayload;
  level: StaffLevel;
  name: string;
  isMaster: boolean;
}

// The master admin controls who may use the admin dashboard and at what
// level. haynes.tenise@gmail.com is built in so it can never be locked out;
// more can be added with the MASTER_EMAILS setting (comma separated).
// OWNER_EMAILS, the earlier name for this setting, still works.
const BUILT_IN_MASTERS = ["haynes.tenise@gmail.com"];

export function masterEmails(): string[] {
  const fromSettings = [Netlify.env.get("MASTER_EMAILS"), Netlify.env.get("OWNER_EMAILS")]
    .join(",")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set([...BUILT_IN_MASTERS, ...fromSettings])];
}

export function isMasterEmail(email: string): boolean {
  return masterEmails().includes(String(email).trim().toLowerCase());
}

// Checks the request comes from an approved staff member at `minimum`
// level or above. Everything is read fresh from the database, so approving,
// changing, or revoking someone takes effect on their very next click.
// Returns the staff context, or a Response to send back.
export async function requireStaff(req: Request, minimum: StaffLevel = "support"): Promise<StaffContext | Response> {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  const [user] = await db.sql`
    SELECT email, role, staff_level, full_name, suspended_at, staff_approved_at FROM users WHERE id = ${session.id}
  `;
  if (!user || user.role !== "admin" || user.suspended_at) return json({ error: "Staff only" }, 403);

  const isMaster = isMasterEmail(user.email);
  if (!isMaster && !user.staff_approved_at) {
    return json({ error: "Your staff access is waiting for the master admin's approval" }, 403);
  }
  const level = (isMaster ? "owner" : user.staff_level || "support") as StaffLevel;
  if (RANK[level] < RANK[minimum]) {
    return json({ error: `This needs ${minimum} access. Ask the master admin.` }, 403);
  }
  return { session, level, name: user.full_name, isMaster };
}

// True for a staff account that may act as staff right now: approved (or
// a master admin) and not suspended. Endpoints that give staff extra
// access check this, so a pending staff request gets nothing.
export async function isActiveStaff(userId: number): Promise<boolean> {
  const [u] = await db.sql`SELECT email, role, suspended_at, staff_approved_at FROM users WHERE id = ${userId}`;
  if (!u || u.role !== "admin" || u.suspended_at) return false;
  return Boolean(u.staff_approved_at) || isMasterEmail(u.email);
}

// Only master admins: approving staff and changing anyone's access.
export async function requireMaster(req: Request): Promise<StaffContext | Response> {
  const staff = await requireStaff(req);
  if (staff instanceof Response) return staff;
  if (!staff.isMaster) return json({ error: "Only the master admin can do this" }, 403);
  return staff;
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

// True when an account has been suspended by staff. Checked on sign in and
// by the endpoints that change things, so a suspension takes effect even
// while someone's old sign in is still valid.
export async function isSuspended(userId: number): Promise<boolean> {
  const [user] = await db.sql`SELECT suspended_at FROM users WHERE id = ${userId}`;
  return Boolean(user?.suspended_at);
}
