import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore, sanitizeFilename } from "../lib/blobs.mts";

const ASSIGNMENT_TYPES = new Set(["multiple_choice", "combo", "essay"]);

// Teachers post a new assignment here. The request is multipart form data
// so the source file (the worksheet or test to grade) can ride along with
// the metadata in one call.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") {
    return json({ error: "Only teachers can post assignments" }, 403);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart form data" }, 400);
  }

  const title = String(form.get("title") || "").trim();
  const subject = String(form.get("subject") || "").trim();
  const gradeLevel = String(form.get("grade_level") || "").trim();
  const assignmentType = String(form.get("assignment_type") || "");
  const pageCount = Number(form.get("page_count"));
  const ratePerPageCents = Number(form.get("rate_per_page_cents"));
  const instructions = form.get("instructions") ? String(form.get("instructions")).trim() : null;
  const file = form.get("file");

  if (!title) return json({ error: "Title is required" }, 400);
  if (!subject) return json({ error: "Subject is required" }, 400);
  if (!gradeLevel) return json({ error: "Grade level is required" }, 400);
  if (!ASSIGNMENT_TYPES.has(assignmentType)) {
    return json({ error: "Assignment type must be multiple_choice, combo, or essay" }, 400);
  }
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    return json({ error: "Page count must be a positive whole number" }, 400);
  }
  if (!Number.isInteger(ratePerPageCents) || ratePerPageCents <= 0) {
    return json({ error: "Rate per page (in cents) must be a positive whole number" }, 400);
  }

  const [assignment] = await db.sql`
    INSERT INTO assignments
      (teacher_id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents, instructions)
    VALUES
      (${session.id}, ${title}, ${subject}, ${gradeLevel}, ${assignmentType}, ${pageCount}, ${ratePerPageCents}, ${instructions})
    RETURNING id, teacher_id, title, subject, grade_level, assignment_type, page_count,
              rate_per_page_cents, instructions, status, created_at
  `;

  if (file instanceof File && file.size > 0) {
    const filename = sanitizeFilename(file.name || "assignment");
    const key = `source/${assignment.id}/${filename}`;
    const store = assignmentFilesStore();
    await store.set(key, await file.arrayBuffer(), {
      metadata: { contentType: file.type || "application/octet-stream" },
    });
    await db.sql`
      UPDATE assignments SET source_blob_key = ${key}, source_filename = ${filename}
      WHERE id = ${assignment.id}
    `;
    assignment.source_filename = filename;
    assignment.has_source_file = true;
  } else {
    assignment.has_source_file = false;
  }

  return json({ assignment }, 201);
};

export const config: Config = {
  path: "/api/assignments/create",
};
