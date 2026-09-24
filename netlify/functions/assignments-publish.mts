import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { isSuspended } from "../lib/staff.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";

// Last step of posting. Checks that every page from 0 up to the expected
// count arrived, sets the page count from the real pages (which is what the
// teacher pays for), and opens the assignment to Grade Angels, or to the
// one Grade Angel they invited.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Only teachers post assignments" }, 403);

  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
  const body = await readJson(req);
  if (!body) return json({ error: "Body must be JSON" }, 400);
  const assignmentId = Number(body.assignment_id);
  const expectedPages = Number(body.expected_pages);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (!Number.isInteger(expectedPages) || expectedPages < 1) {
    return json({ error: "expected_pages is required" }, 400);
  }

  const [assignment] = await db.sql`
    SELECT teacher_id, status, invited_grade_angel_id FROM assignments WHERE id = ${assignmentId}
  `;
  if (!assignment) return json({ error: "Assignment not found" }, 404);
  if (assignment.teacher_id !== session.id) return json({ error: "This is not your assignment" }, 403);
  if (assignment.status !== "draft") return json({ error: "This assignment is already posted" }, 409);

  const pages = await db.sql`
    SELECT page_index FROM assignment_pages WHERE assignment_id = ${assignmentId} ORDER BY page_index
  `;
  const indexes = pages.map((p: any) => p.page_index).filter((idx: number) => idx < expectedPages);
  const complete = indexes.length === expectedPages && indexes.every((idx: number, i: number) => idx === i);
  if (!complete) {
    return json({ error: `Only ${indexes.length} of ${expectedPages} pages arrived. Try the upload again.` }, 409);
  }

  // Pages beyond the expected count can linger if a teacher removed pages
  // and retried; they are not part of this assignment.
  await db.sql`DELETE FROM assignment_pages WHERE assignment_id = ${assignmentId} AND page_index >= ${expectedPages}`;

  const [updated] = await db.sql`
    UPDATE assignments
    SET status = 'open', page_count = ${expectedPages}, published_at = NOW()
    WHERE id = ${assignmentId} AND status = 'draft'
    RETURNING id, status, page_count
  `;
  if (!updated) return json({ error: "This assignment is already posted" }, 409);

  await recordEvent(assignmentId, session.id, "posted");
  if (assignment.invited_grade_angel_id) {
    await recordEvent(assignmentId, session.id, "invited", null);
  }

  return json({ assignment: updated }, 200);
};

export const config: Config = {
  path: "/api/assignments/publish",
};
