import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession, hashPassword, verifyPassword } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";

// Change your own password. Staff use this to replace the temporary
// password the owner gave them.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  const body = await readJson(req);
  const current = String(body?.current_password || "");
  const next = String(body?.new_password || "");
  if (next.length < 8) return json({ error: "Your new password needs at least 8 characters" }, 400);

  const [user] = await db.sql`SELECT password_hash FROM users WHERE id = ${session.id}`;
  if (!user || !(await verifyPassword(current, user.password_hash))) {
    return json({ error: "Your current password is not right" }, 400);
  }
  await db.sql`UPDATE users SET password_hash = ${await hashPassword(next)} WHERE id = ${session.id}`;
  return json({ ok: true }, 200);
};

export const config: Config = {
  path: "/api/account/password",
};
