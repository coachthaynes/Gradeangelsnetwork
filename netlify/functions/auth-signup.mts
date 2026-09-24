import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { hashPassword, signSession, sessionCookieHeader } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { TERMS_VERSION } from "../lib/terms.mts";
import { isMasterEmail } from "../lib/staff.mts";
import { sendNow } from "../lib/drips.mts";

// Where the person came from (utm tags or the linking site), kept short.
const clip = (v: unknown, n: number) => (v ? String(v).trim().slice(0, n) : null);

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

  const owner = isMasterEmail(email);
  if (!owner && body.accept_terms !== true) {
    return json({ error: "Please agree to the Terms of Use to create an account" }, 400);
  }

  const existing = await db.sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing.length > 0) {
    return json({ error: "An account with that email already exists" }, 409);
  }

  const passwordHash = await hashPassword(password);

  // A master admin email always becomes a master admin account, whatever
  // role was picked on the form. Other staff use the staff request form.
  const finalRole = owner ? "admin" : role;
  const staffLevel = owner ? "owner" : null;

  const [user] = await db.sql`
    INSERT INTO users (email, password_hash, role, full_name, school_or_org, subjects, staff_level, staff_approved_at,
                       signup_source, signup_medium, signup_campaign, signup_referrer, terms_accepted_at, terms_version)
    VALUES (${email}, ${passwordHash}, ${finalRole}, ${fullName}, ${schoolOrOrg}, ${subjects}, ${staffLevel},
            ${owner ? new Date().toISOString() : null},
            ${clip(body.source, 80)}, ${clip(body.medium, 80)}, ${clip(body.campaign, 120)}, ${clip(body.referrer, 300)},
            ${body.accept_terms === true ? new Date().toISOString() : null}, ${body.accept_terms === true ? TERMS_VERSION : null})
    RETURNING id, email, role, full_name, school_or_org, subjects, background_check_status, staff_level, created_at
  `;

  // Welcome email right away; the rest of the campaign follows on its own.
  if (finalRole === "teacher" || finalRole === "grade_angel") {
    await sendNow(finalRole === "teacher" ? "teacher_welcome" : "angel_welcome",
      { kind: "user", id: user.id, email: user.email, name: user.full_name });
  }

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
