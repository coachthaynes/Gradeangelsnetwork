import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { verifyPassword, signSession, sessionCookieHeader } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) return json({ error: "Email and password are required" }, 400);

  const rows = await db.sql`
    SELECT id, email, password_hash, role, full_name, school_or_org, subjects, background_check_status
    FROM users WHERE email = ${email}
  `;
  const user = rows[0];

  // Same message whether the email is unknown or the password is wrong, so
  // a caller cannot use this endpoint to find out which accounts exist.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: "Incorrect email or password" }, 401);
  }

  const token = signSession({ id: user.id, email: user.email, role: user.role, full_name: user.full_name });
  delete user.password_hash;

  return json({ user }, 200, { "set-cookie": sessionCookieHeader(token) });
};

export const config: Config = {
  path: "/api/auth/login",
};
