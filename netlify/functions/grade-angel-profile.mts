import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { CONTRACTOR_AGREEMENT_VERSION } from "../lib/terms.mts";
import { isSuspended } from "../lib/staff.mts";
import { ASSIGNMENT_TYPES, GRADE_LEVELS, getSetupStatus } from "../lib/grade-angel.mts";
import { readJson } from "../lib/assignments.mts";

const QUALIFICATIONS = new Set([
  "certified_teacher",
  "retired_teacher",
  "substitute_teacher",
  "tutor",
  "education_student",
  "other",
]);
const DEGREES = new Set(["high_school", "associate", "bachelor", "master", "doctorate"]);
const CERTIFICATES = new Set(["current", "expired", "none"]);

// Turns whatever the page sent (an array or a comma separated string) into
// a clean, de-duplicated list, keeping only values from `allowed` when given.
function toList(value: unknown, allowed?: readonly string[]): string[] {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(",");
  const cleaned = raw.map((v) => String(v).trim()).filter(Boolean);
  const filtered = allowed ? cleaned.filter((v) => allowed.includes(v)) : cleaned;
  return [...new Set(filtered)];
}

function text(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

// Saves one of the three information steps of Grade Angel setup:
//   personal   name, phone, and location
//   background what they can grade and why teachers should trust them
//   agreement  confidentiality plus the independent contractor agreement
// Steps go in order: a step cannot be saved before the ones ahead of it.
// COALESCE keeps each step's first completion time when it is edited later.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels have this profile" }, 403);
  }

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const before = await getSetupStatus(session.id);
  if (!before) return json({ error: "Account not found" }, 404);
  const step = String(body.step || "");

  if (step === "personal") {
    const fullName = text(body.full_name, 120);
    const phone = text(body.phone, 30);
    const city = text(body.city, 80);
    const state = text(body.state, 2).toUpperCase();
    const zip = text(body.zip, 10);
    if (!fullName) return json({ error: "Full name is required" }, 400);
    if (phone.replace(/\D/g, "").length < 10) return json({ error: "Enter a phone number with area code" }, 400);
    if (!city) return json({ error: "City is required" }, 400);
    if (!/^[A-Z]{2}$/.test(state)) return json({ error: "Choose your state" }, 400);
    if (!/^\d{5}$/.test(zip)) return json({ error: "Enter a 5 digit ZIP code" }, 400);

    await db.sql`
      UPDATE users
      SET full_name = ${fullName}, phone = ${phone}, city = ${city}, state = ${state}, zip = ${zip},
          personal_completed_at = COALESCE(personal_completed_at, NOW())
      WHERE id = ${session.id}
    `;
  } else if (step === "background") {
    if (!before.personal_complete) return json({ error: "Finish step 1 first" }, 409);

    const subjects = toList(body.subjects).map((s) => s.slice(0, 60)).slice(0, 20);
    const gradeLevels = toList(body.grade_levels, GRADE_LEVELS);
    const assignmentTypes = toList(body.assignment_types, ASSIGNMENT_TYPES);
    const qualifications = String(body.qualifications || "");
    const highestDegree = String(body.highest_degree || "");
    const degreeField = text(body.degree_field, 120) || null;
    const certificate = String(body.teaching_certificate || "");
    const certState = text(body.certification_state, 2).toUpperCase() || null;
    const years = Number(body.years_experience);
    const bio = text(body.bio, 1000);

    if (!QUALIFICATIONS.has(qualifications)) return json({ error: "Choose your background" }, 400);
    if (!DEGREES.has(highestDegree)) return json({ error: "Choose your highest degree" }, 400);
    if (!CERTIFICATES.has(certificate)) return json({ error: "Tell us about your teaching certificate" }, 400);
    if (certificate !== "none" && (!certState || !/^[A-Z]{2}$/.test(certState))) {
      return json({ error: "Choose the state that issued your certificate" }, 400);
    }
    if (!Number.isInteger(years) || years < 0 || years > 60) {
      return json({ error: "Enter your years of experience in education" }, 400);
    }
    if (subjects.length === 0) return json({ error: "Choose at least one subject" }, 400);
    if (gradeLevels.length === 0) return json({ error: "Choose at least one grade level" }, 400);
    if (assignmentTypes.length === 0) return json({ error: "Choose at least one type of assignment" }, 400);
    if (bio.length < 20) return json({ error: "Tell teachers a little about yourself (at least 20 characters)" }, 400);

    await db.sql`
      UPDATE users
      SET subjects = ${subjects.join(", ")},
          grade_levels = ${gradeLevels.join(",")},
          assignment_types = ${assignmentTypes.join(",")},
          qualifications = ${qualifications},
          highest_degree = ${highestDegree},
          degree_field = ${degreeField},
          teaching_certificate = ${certificate},
          certification_state = ${certificate === "none" ? null : certState},
          years_experience = ${years},
          bio = ${bio},
          profile_completed_at = COALESCE(profile_completed_at, NOW())
      WHERE id = ${session.id}
    `;
  } else if (step === "agreement") {
    if (!before.personal_complete || !before.profile_complete) {
      return json({ error: "Finish steps 1 and 2 first" }, 409);
    }
    const [user] = await db.sql`SELECT full_name FROM users WHERE id = ${session.id}`;
    const signature = text(body.signature_name, 120);
    const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

    if (body.confidentiality_agreed !== true) {
      return json({ error: "You need to agree to keep student work confidential" }, 400);
    }
    if (body.contractor_agreed !== true) {
      return json({ error: "You need to accept the independent contractor agreement" }, 400);
    }
    if (normalize(signature) !== normalize(user.full_name)) {
      return json({ error: `Type your full name exactly as "${user.full_name}" to sign` }, 400);
    }

    await db.sql`
      UPDATE users
      SET confidentiality_agreed_at = COALESCE(confidentiality_agreed_at, NOW()),
          contractor_agreement_signed_at = COALESCE(contractor_agreement_signed_at, NOW()),
          contractor_signature_name = COALESCE(contractor_signature_name, ${signature}),
          contractor_agreement_version = COALESCE(contractor_agreement_version, ${CONTRACTOR_AGREEMENT_VERSION})
      WHERE id = ${session.id}
    `;
  } else {
    return json({ error: "Unknown setup step" }, 400);
  }

  const status = await getSetupStatus(session.id);
  return json({ status }, 200);
};

export const config: Config = {
  path: "/api/grade-angel/profile",
};
