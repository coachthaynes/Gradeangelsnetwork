import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { hashPassword } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isMasterEmail, logAction } from "../lib/staff.mts";

// Someone asks for staff access from the Staff sign in page. The account is
// created but cannot use the admin dashboard until the master admin
// approves it, unless the master admin pre-approved this email, in which
// case it works right away at the pre-approved level.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const email = String(body.email || "").trim().toLowerCase();
  const fullName = String(body.full_name || "").trim().slice(0, 120);
  const password = String(body.password || "");
  if (!email.includes("@")) return json({ error: "A valid email is required" }, 400);
  if (!fullName) return json({ error: "Full name is required" }, 400);
  if (password.length < 10) return json({ error: "Staff passwords need at least 10 characters" }, 400);

  const [existing] = await db.sql`SELECT id FROM users WHERE email = ${email}`;
  if (existing) {
    return json({ error: "That email already has an account. Staff need their own email, separate from any teacher or Grade Angel account." }, 409);
  }

  const master = isMasterEmail(email);
  const [invite] = await db.sql`SELECT staff_level, invited_by FROM staff_invites WHERE email = ${email}`;
  const approved = master || Boolean(invite);
  const level = master ? "owner" : invite?.staff_level || "support";

  const [user] = await db.sql`
    INSERT INTO users (email, password_hash, role, full_name, staff_level, staff_requested_at, staff_approved_at, staff_approved_by)
    VALUES (${email}, ${await hashPassword(password)}, 'admin', ${fullName}, ${level}, NOW(),
            ${approved ? new Date().toISOString() : null}, ${invite?.invited_by ?? null})
    RETURNING id
  `;
  if (invite) {
    await db.sql`DELETE FROM staff_invites WHERE email = ${email}`;
    await logAction(user.id, "joined staff from pre-approval", "user", user.id, `${fullName} (${email}) as ${level}`);
  } else {
    await logAction(user.id, "requested staff access", "user", user.id, `${fullName} (${email})`);
  }

  return json(
    {
      approved,
      message: approved
        ? "Your staff account is ready. Sign in below."
        : "Request sent. You can sign in once the master admin approves it.",
    },
    201
  );
};

export const config: Config = {
  path: "/api/staff/request",
};
