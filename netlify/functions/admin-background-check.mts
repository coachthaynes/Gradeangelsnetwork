import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

const STATUSES = new Set(["not_started", "invited", "pending", "clear", "consider"]);

// Lets an admin record a background check result by hand, for checks run
// outside Checkr (for example through GoodHire) or while Checkr is not
// connected yet. Only admins can call this; there is no public signup for
// the admin role, it is set directly in the database.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "admin") return json({ error: "Admins only" }, 403);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const userId = Number(body.user_id);
  const status = String(body.status || "");
  if (!Number.isInteger(userId)) return json({ error: "user_id is required" }, 400);
  if (!STATUSES.has(status)) return json({ error: "Unknown background check status" }, 400);

  const rows = await db.sql`
    UPDATE users SET background_check_status = ${status}
    WHERE id = ${userId} AND role = 'grade_angel'
    RETURNING id, full_name, background_check_status
  `;
  if (rows.length === 0) return json({ error: "Grade Angel not found" }, 404);

  return json({ user: rows[0] }, 200);
};

export const config: Config = {
  path: "/api/admin/background-check",
};
