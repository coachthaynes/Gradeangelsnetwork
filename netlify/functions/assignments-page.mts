import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore } from "../lib/blobs.mts";
import { PREVIEW_PAGE_LIMIT, assignmentAccess, type AccessRow } from "../lib/assignments.mts";

// Serves one page image. Every request goes through the same access check
// as the assignment itself, and Grade Angels who have not accepted yet only
// get the first PREVIEW_PAGE_LIMIT pages.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const assignmentId = Number(url.searchParams.get("assignment_id"));
  const pageIndex = Number(url.searchParams.get("page"));
  if (!Number.isInteger(assignmentId) || !Number.isInteger(pageIndex)) {
    return json({ error: "assignment_id and page are required" }, 400);
  }

  const [assignment] = await db.sql`
    SELECT teacher_id, grade_angel_id, invited_grade_angel_id, status FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);

  const access = await assignmentAccess(session, assignment as AccessRow);
  const allowed = access === "full" || (access === "preview" && pageIndex < PREVIEW_PAGE_LIMIT);
  if (!allowed) return json({ error: "You do not have access to this page" }, 403);

  const [page] = await db.sql`
    SELECT blob_key, content_type FROM assignment_pages
    WHERE assignment_id = ${assignmentId} AND page_index = ${pageIndex}
  `;
  if (!page) return json({ error: "Page not found" }, 404);

  const data = await assignmentFilesStore().get(page.blob_key, { type: "arrayBuffer" });
  if (!data) return json({ error: "Page is missing from storage" }, 404);

  return new Response(data, {
    status: 200,
    headers: {
      "content-type": page.content_type,
      // Private: student work must never sit in a shared cache.
      "cache-control": "private, max-age=600",
    },
  });
};

export const config: Config = {
  path: "/api/assignments/page",
};
