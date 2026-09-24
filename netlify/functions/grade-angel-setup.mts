import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getSetupStatus } from "../lib/grade-angel.mts";

// Everything the setup page and the dashboard need in one call: the Grade
// Angel's saved profile plus where they stand on each setup step.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels have a setup checklist" }, 403);
  }

  const [profile] = await db.sql`
    SELECT full_name, email, phone, city, state, zip, personal_completed_at,
           subjects, grade_levels, assignment_types, qualifications, highest_degree, degree_field,
           teaching_certificate, certification_state, years_experience, bio, profile_completed_at,
           confidentiality_agreed_at, contractor_agreement_signed_at, contractor_signature_name
    FROM users WHERE id = ${session.id}
  `;
  const status = await getSetupStatus(session.id);
  if (!profile || !status) return json({ error: "Account not found" }, 404);

  return json({ profile, status }, 200);
};

export const config: Config = {
  path: "/api/grade-angel/setup",
};
