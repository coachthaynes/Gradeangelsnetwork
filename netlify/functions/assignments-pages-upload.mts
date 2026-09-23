import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore } from "../lib/blobs.mts";
import { MAX_PAGES, MAX_PAGE_BYTES, PAGE_CONTENT_TYPES, pageBlobKey } from "../lib/assignments.mts";

// Uploads one page image of a draft assignment. The browser has already
// shrunk and converted each photo or PDF page to a JPEG, so a page is
// usually a few hundred KB. Uploading the same page_index again replaces it,
// which makes a retry after a dropped connection safe.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Only teachers upload assignment pages" }, 403);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return json({ error: "Expected multipart form data" }, 400);
  }

  const assignmentId = Number(form.get("assignment_id"));
  const pageIndex = Number(form.get("page_index"));
  const width = Number(form.get("width")) || null;
  const height = Number(form.get("height")) || null;
  const file = form.get("file");

  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= MAX_PAGES) {
    return json({ error: `page_index must be between 0 and ${MAX_PAGES - 1}` }, 400);
  }
  if (!(file instanceof File) || file.size === 0) return json({ error: "A page image is required" }, 400);
  if (file.size > MAX_PAGE_BYTES) return json({ error: "That page image is too large" }, 413);
  if (!PAGE_CONTENT_TYPES.has(file.type)) return json({ error: "Pages must be JPEG, PNG, or WebP images" }, 415);

  const [assignment] = await db.sql`SELECT teacher_id, status FROM assignments WHERE id = ${assignmentId}`;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.teacher_id !== session.id) return json({ error: "This is not your assignment" }, 403);
  if (assignment.status !== "draft") return json({ error: "Pages can only be added before the assignment is posted" }, 409);

  const key = pageBlobKey(assignmentId, pageIndex);
  await assignmentFilesStore().set(key, await file.arrayBuffer(), { metadata: { contentType: file.type } });

  await db.sql`
    INSERT INTO assignment_pages (assignment_id, page_index, blob_key, content_type, byte_size, width, height)
    VALUES (${assignmentId}, ${pageIndex}, ${key}, ${file.type}, ${file.size}, ${width}, ${height})
    ON CONFLICT (assignment_id, page_index) DO UPDATE
      SET blob_key = EXCLUDED.blob_key, content_type = EXCLUDED.content_type,
          byte_size = EXCLUDED.byte_size, width = EXCLUDED.width, height = EXCLUDED.height,
          created_at = NOW()
  `;

  return json({ ok: true, page_index: pageIndex }, 200);
};

export const config: Config = {
  path: "/api/assignments/pages/upload",
};
