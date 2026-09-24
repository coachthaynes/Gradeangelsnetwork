import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { getMinRateCents } from "../lib/pricing.mts";
import { isSuspended } from "../lib/staff.mts";
import { DEFAULT_TURNAROUND_HOURS, TURNAROUND_HOURS, readJson } from "../lib/assignments.mts";
import { getSetupStatus } from "../lib/grade-angel.mts";

const ASSIGNMENT_TYPES = new Set(["multiple_choice", "combo", "essay"]);

// Step one of posting: the teacher describes the assignment and it is saved
// as a draft. The pages follow one request at a time through
// assignments-pages-upload, then assignments-publish opens it up. Splitting
// it this way keeps each request under Netlify's request size limit no
// matter how big the class set is.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") {
    return json({ error: "Only teachers can post assignments" }, 403);
  }

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);

  const title = String(body.title || "").trim();
  const subject = String(body.subject || "").trim();
  const gradeLevel = String(body.grade_level || "").trim();
  const assignmentType = String(body.assignment_type || "");
  // Per page, or one flat price for the whole stack.
  const pricingMode = body.pricing_mode === "flat" ? "flat" : "per_page";
  const flatPriceCents = pricingMode === "flat" ? Number(body.flat_price_cents) : null;
  const ratePerPageCents = pricingMode === "flat" ? 0 : Number(body.rate_per_page_cents);
  const instructions = body.instructions ? String(body.instructions).trim() : null;
  const turnaroundHours = body.turnaround_hours === undefined ? DEFAULT_TURNAROUND_HOURS : Number(body.turnaround_hours);
  const invitedId = body.invited_grade_angel_id ? Number(body.invited_grade_angel_id) : null;

  if (!title) return json({ error: "Title is required" }, 400);
  if (!subject) return json({ error: "Subject is required" }, 400);
  if (!gradeLevel) return json({ error: "Grade level is required" }, 400);
  if (!ASSIGNMENT_TYPES.has(assignmentType)) {
    return json({ error: "Assignment type must be multiple_choice, combo, or essay" }, 400);
  }
  if (pricingMode === "flat") {
    if (!Number.isInteger(flatPriceCents) || (flatPriceCents as number) <= 0 || (flatPriceCents as number) > 1000000) {
      return json({ error: "Enter a flat price for the whole stack" }, 400);
    }
  } else {
    if (!Number.isInteger(ratePerPageCents) || ratePerPageCents <= 0) {
      return json({ error: "Rate per page (in cents) must be a positive whole number" }, 400);
    }
    const minRateCents = await getMinRateCents();
    if (ratePerPageCents < minRateCents) {
      return json({ error: `The lowest price is $${(minRateCents / 100).toFixed(2)} a page, so Grade Angels are paid fairly` }, 400);
    }
  }
  const pagesPerStudent = body.pages_per_student ? Number(body.pages_per_student) : null;
  if (pagesPerStudent !== null && (!Number.isInteger(pagesPerStudent) || pagesPerStudent < 1 || pagesPerStudent > 50)) {
    return json({ error: "Pages per student must be a number from 1 to 50" }, 400);
  }
  const classId = body.class_id ? Number(body.class_id) : null;
  if (classId !== null) {
    const [c] = await db.sql`SELECT id FROM classes WHERE id = ${classId} AND teacher_id = ${session.id}`;
    if (!c) return json({ error: "Class not found" }, 400);
  }
  if (!TURNAROUND_HOURS.includes(turnaroundHours)) {
    return json({ error: "Choose a turnaround time from the list" }, 400);
  }

  if (invitedId !== null) {
    const [invitee] = await db.sql`SELECT id, role FROM users WHERE id = ${invitedId}`;
    const setup = invitee?.role === "grade_angel" ? await getSetupStatus(invitedId) : null;
    if (!setup?.ready) return json({ error: "That Grade Angel is not available for invites" }, 400);
  }

  // page_count starts at 1 to satisfy the table's check; publish sets the
  // real number from the pages actually uploaded.
  const [assignment] = await db.sql`
    INSERT INTO assignments
      (teacher_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents,
       instructions, status, turnaround_hours, invited_grade_angel_id, pages_per_student, class_id,
       pricing_mode, flat_price_cents)
    VALUES
      (${session.id}, ${title}, ${subject}, ${gradeLevel}, ${assignmentType}, 1, ${ratePerPageCents},
       ${instructions}, 'draft', ${turnaroundHours}, ${invitedId}, ${pagesPerStudent}, ${classId},
       ${pricingMode}, ${flatPriceCents})
    RETURNING id, status
  `;

  return json({ assignment }, 201);
};

export const config: Config = {
  path: "/api/assignments/create",
};
