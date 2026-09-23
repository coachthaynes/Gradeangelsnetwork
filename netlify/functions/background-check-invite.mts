import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { createCandidateAndInvitation, CheckrNotConfiguredError } from "../lib/checkr.mts";

// A Grade Angel can invite themselves; an admin can invite anyone by
// passing user_id. Either way this stores the Checkr candidate id so the
// webhook below can match a later result back to the right person.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is fine for a self-invite.
  }

  let targetId = session.id;
  if (body.user_id !== undefined) {
    if (session.role !== "admin") {
      return json({ error: "Only an admin can invite someone else" }, 403);
    }
    targetId = Number(body.user_id);
  } else if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels go through a background check" }, 403);
  }

  const [target] = await db.sql`SELECT id, email, full_name FROM users WHERE id = ${targetId}`;
  if (!target) return json({ error: "User not found" }, 404);

  try {
    const { candidate } = await createCandidateAndInvitation(target.email, target.full_name);
    await db.sql`
      UPDATE users SET checkr_candidate_id = ${candidate.id}, background_check_status = 'invited'
      WHERE id = ${targetId}
    `;
    return json({ background_check_status: "invited" }, 200);
  } catch (err) {
    if (err instanceof CheckrNotConfiguredError) {
      return json({ error: err.message }, 501);
    }
    return json({ error: "Could not send the background check invitation" }, 502);
  }
};

export const config: Config = {
  path: "/api/background-check/invite",
};
