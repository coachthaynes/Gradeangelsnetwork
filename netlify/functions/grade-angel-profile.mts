import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { ASSIGNMENT_TYPES, GRADE_LEVELS, getSetupStatus } from "../lib/grade-angel.mts";

const QUALIFICATIONS = new Set([
  "certified_teacher",
  "retired_teacher",
  "substitute_teacher",
  "tutor",
  "education_student",
  "other",
]);

// Turns whatever the page sent (an array or a comma separated string) into
// a clean, de-duplicated list, keeping only values from `allowed` when given.
function toList(value: unknown, allowed?: readonly string[]): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const cleaned = raw.map((v) => String(v).trim()).filter(Boolean);
  const filtered = allowed ? cleaned.filter((v) => allowed.includes(v)) : cleaned;
  return [...new Set(filtered)];
}

// A Grade Angel saves their profile here. Saving a complete profile along
// with the confidentiality agreement is step one of setup.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels have this profile" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Body must be JSON" }, 400);
  }

  const fullName = String(body.full_name || "").trim();
  const subjects = toList(body.subjects).map((s) => s.slice(0, 60)).slice(0, 20);
  const gradeLevels = toList(body.grade_levels, GRADE_LEVELS);
  const assignmentTypes = toList(body.assignment_types, ASSIGNMENT_TYPES);
  const qualifications = String(body.qualifications || "");
  const bio = String(body.bio || "").trim().slice(0, 1000);
  const agreed = body.confidentiality_agreed === true;

  if (!fullName) return json({ error: "Full name is required" }, 400);
  if (subjects.length === 0) return json({ error: "Choose at least one subject" }, 400);
  if (gradeLevels.length === 0) return json({ error: "Choose at least one grade level" }, 400);
  if (assignmentTypes.length === 0) return json({ error: "Choose at least one type of assignment" }, 400);
  if (!QUALIFICATIONS.has(qualifications)) return json({ error: "Choose your background" }, 400);
  if (bio.length < 20) return json({ error: "Tell teachers a little about yourself (at least 20 characters)" }, 400);
  if (!agreed) return json({ error: "You need to agree to keep student work confidential" }, 400);

  // COALESCE keeps the first agreement and completion times rather than
  // bumping them every time someone edits their profile later.
  await db.sql`
    UPDATE users
    SET full_name = ${fullName},
        subjects = ${subjects.join(", ")},
        grade_levels = ${gradeLevels.join(",")},
        assignment_types = ${assignmentTypes.join(",")},
        qualifications = ${qualifications},
        bio = ${bio},
        confidentiality_agreed_at = COALESCE(confidentiality_agreed_at, NOW()),
        profile_completed_at = COALESCE(profile_completed_at, NOW())
    WHERE id = ${session.id}
  `;

  const status = await getSetupStatus(session.id);
  return json({ status }, 200);
};

export const config: Config = {
  path: "/api/grade-angel/profile",
};
