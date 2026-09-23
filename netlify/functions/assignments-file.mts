import type { Config, Context } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { assignmentFilesStore } from "../lib/blobs.mts";

// Streams back the source file a teacher uploaded, or the graded file a
// Grade Angel uploaded, to whichever of the two people are on this
// assignment (or an admin). Nothing here is a public URL, every download
// goes through a permission check first.
export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const assignmentId = Number(url.searchParams.get("assignment_id"));
  const kind = url.searchParams.get("kind") === "graded" ? "graded" : "source";
  if (!Number.isInteger(assignmentId)) {
    return json({ error: "assignment_id is required" }, 400);
  }

  const [assignment] = await db.sql`
    SELECT teacher_id, grade_angel_id, source_blob_key, source_filename,
           graded_blob_key, graded_filename
    FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);

  const isParty =
    session.role === "admin" ||
    assignment.teacher_id === session.id ||
    assignment.grade_angel_id === session.id;
  if (!isParty) return json({ error: "You do not have access to this file" }, 403);

  const key = kind === "graded" ? assignment.graded_blob_key : assignment.source_blob_key;
  const filename = kind === "graded" ? assignment.graded_filename : assignment.source_filename;
  if (!key) return json({ error: `No ${kind} file has been uploaded yet` }, 404);

  const store = assignmentFilesStore();
  const result = await store.getWithMetadata(key, { type: "arrayBuffer" });
  if (!result) return json({ error: "File is missing from storage" }, 404);

  const contentType = (result.metadata?.contentType as string) || "application/octet-stream";
  return new Response(result.data as ArrayBuffer, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${filename || "download"}"`,
    },
  });
};

export const config: Config = {
  path: "/api/assignments/file",
};
