import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore, sanitizeFilename } from "../lib/blobs.mts";

// A Grade Angel uploads the graded work here. Multipart form data again,
// same shape as assignments-create: metadata plus a file.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "grade_angel") {
    return json({ error: "Only Grade Angels can submit graded work" }, 403);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart form data" }, 400);
  }

  const assignmentId = Number(form.get("assignment_id"));
  const file = form.get("file");
  if (!Number.isInteger(assignmentId)) {
    return json({ error: "assignment_id is required" }, 400);
  }
  if (!(file instanceof File) || file.size === 0) {
    return json({ error: "A graded file is required" }, 400);
  }

  const [assignment] = await db.sql`
    SELECT id, grade_angel_id, status FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.grade_angel_id !== session.id) {
    return json({ error: "You are not assigned to this one" }, 403);
  }
  if (assignment.status !== "accepted") {
    return json({ error: "This assignment is not in a state that can be submitted" }, 409);
  }

  const filename = sanitizeFilename(file.name || "graded");
  const key = `graded/${assignmentId}/${filename}`;
  const store = assignmentFilesStore();
  await store.set(key, await file.arrayBuffer(), {
    metadata: { contentType: file.type || "application/octet-stream" },
  });

  const [updated] = await db.sql`
    UPDATE assignments
    SET graded_blob_key = ${key}, graded_filename = ${filename},
        status = 'submitted', submitted_at = NOW()
    WHERE id = ${assignmentId}
    RETURNING id, teacher_id, grade_angel_id, title, status, created_at, submitted_at
  `;

  return json({ assignment: updated }, 200);
};

export const config: Config = {
  path: "/api/assignments/submit",
};
