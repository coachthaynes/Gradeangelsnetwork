import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isSuspended } from "../lib/staff.mts";
import { assignmentFilesStore, sanitizeFilename } from "../lib/blobs.mts";
import { recordEvent } from "../lib/assignments.mts";
import { AUTO_APPROVE_DAYS } from "../lib/grading.mts";
import { notifyUser } from "../lib/notify.mts";

// A Grade Angel sends the graded work to the teacher. Usually the pages
// were marked on the grading screen, so this sends JSON:
//   { assignment_id, note }
// A finished file can still be uploaded instead, as multipart form data
// with assignment_id, note, and file. Either way the teacher is emailed.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels can submit graded work" }, 403);
  }
  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);

  let assignmentId: number;
  let note: string | null;
  let file: File | null = null;
  const type = req.headers.get("content-type") || "";
  try {
    if (type.includes("application/json")) {
      const body = await req.json();
      assignmentId = Number(body.assignment_id);
      note = body.note ? String(body.note) : null;
    } else {
      const form = await req.formData();
      assignmentId = Number(form.get("assignment_id"));
      note = form.get("note") ? String(form.get("note")) : null;
      const f = form.get("file");
      if (f instanceof File && f.size > 0) file = f;
    }
  } catch {
    return json({ error: "Could not read the request" }, 400);
  }
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  note = note ? note.trim().slice(0, 2000) || null : null;

  const [assignment] = await db.sql`
    SELECT id, grade_angel_id, teacher_id, title, status FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.grade_angel_id !== session.id) {
    return json({ error: "You are not assigned to this one" }, 403);
  }
  if (assignment.status !== "accepted") {
    return json({ error: "This assignment is not in a state that can be submitted" }, 409);
  }

  let key: string | null = null;
  let filename: string | null = null;
  if (file) {
    filename = sanitizeFilename(file.name || "graded");
    key = `graded/${assignmentId}/${filename}`;
    await assignmentFilesStore().set(key, await file.arrayBuffer(), {
      metadata: { contentType: file.type || "application/octet-stream" },
    });
  } else {
    const [marked] = await db.sql`
      SELECT COUNT(*)::int AS n FROM assignment_annotations
      WHERE assignment_id = ${assignmentId} AND layer = 'grade_angel' AND jsonb_array_length(data->'items') > 0
    `;
    if (!marked.n) {
      return json({ error: "Mark the pages on the grading screen first, or upload a finished file" }, 400);
    }
  }

  const [updated] = await db.sql`
    UPDATE assignments
    SET graded_blob_key = COALESCE(${key}, graded_blob_key), graded_filename = COALESCE(${filename}, graded_filename),
        graded_on_site = ${!file}, grade_angel_note = ${note},
        status = 'submitted', submitted_at = NOW(), approval_reminder_at = NULL
    WHERE id = ${assignmentId} AND status = 'accepted'
    RETURNING id, teacher_id, grade_angel_id, title, status, created_at, submitted_at, graded_on_site
  `;
  if (!updated) return json({ error: "This assignment changed. Refresh and try again." }, 409);
  await recordEvent(assignmentId, session.id, "submitted", note);
  await notifyUser(assignment.teacher_id, {
    subject: `Graded work is ready: ${assignment.title}`,
    body: `Your Grade Angel sent back **${assignment.title}**.${note ? `\n\nTheir note:\n${note}` : ""}\n\nLook over the graded pages, then approve them or ask for changes. If we do not hear from you in ${AUTO_APPROVE_DAYS} days, the work is approved automatically.`,
    ctaLabel: "Review the graded work",
    ctaPath: `/assignment.html?id=${assignmentId}`,
  });

  return json({ assignment: updated }, 200);
};

export const config: Config = {
  path: "/api/assignments/submit",
};
