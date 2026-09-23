import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { hashPassword, signSession, sessionCookieHeader } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

const ALLOWED_ROLES = new Set(["teacher", "grade_angel"]);

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
  const fullName = String(body.full_name || "").trim();
  const role = String(body.role || "");
  const schoolOrOrg = body.school_or_org ? String(body.school_or_org).trim() : null;
  const subjects = body.subjects ? String(body.subjects).trim() : null;

  if (!email || !email.includes("@")) return json({ error: "A valid email is required" }, 400);
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
  if (!fullName) return json({ error: "Full name is required" }, 400);
  if (!ALLOWED_ROLES.has(role)) return json({ error: "Role must be teacher or grade_angel" }, 400);

  const existing = await db.sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    return json({ error: "An account with that email already exists" }, 409);
  }

  const passwordHash = await hashPassword(password);

  const [user] = await db.sql`
    INSERT INTO users (email, password_hash, role, full_name, school_or_org, subjects)
    VALUES (${email}, ${passwordHash}, ${role}, ${fullName}, ${schoolOrOrg}, ${subjects})
    RETURNING id, email, role, full_name, school_or_org, subjects, background_check_status, created_at
  `;

  const token = signSession({ id: user.id, email: user.email, role: user.role, full_name: user.full_name });

  return json(
    { user },
    201,
    { "set-cookie": sessionCookieHeader(token) }
  );
};

export const config: Config = {
  path: "/api/auth/signup",
};
