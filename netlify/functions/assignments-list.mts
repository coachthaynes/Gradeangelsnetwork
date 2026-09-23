import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";

// What each role sees on the marketplace board:
//   teacher     -> the assignments they posted, any status
//   grade_angel -> open assignments by default (?scope=mine for the ones
//                  they have accepted or submitted)
//   admin       -> everything, optionally filtered by ?status=
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const scope = url.searchParams.get("scope") || "";
  const statusFilter = url.searchParams.get("status") || "";

  let rows;
  if (session.role === "teacher") {
    rows = await db.sql`
      SELECT a.id, a.teacher_id, a.grade_angel_id, a.title, a.subject, a.grade_level, a.assignment_type,
             a.page_count, a.rate_per_page_cents, a.instructions, a.status, a.created_at,
             a.accepted_at, a.submitted_at, a.completed_at,
             (a.source_blob_key IS NOT NULL) AS has_source_file,
             (a.graded_blob_key IS NOT NULL) AS has_graded_file,
             p.status AS payment_status,
             p.payout_status AS payout_status
      FROM assignments a
      LEFT JOIN LATERAL (
        SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
      ) p ON true
      WHERE a.teacher_id = ${session.id}
      ORDER BY a.created_at DESC
    `;
  } else if (session.role === "grade_angel") {
    if (scope === "mine") {
      rows = await db.sql`
        SELECT id, teacher_id, grade_angel_id, title, subject, grade_level, assignment_type,
               page_count, rate_per_page_cents, instructions, status, created_at,
               accepted_at, submitted_at, completed_at,
               (source_blob_key IS NOT NULL) AS has_source_file,
               (graded_blob_key IS NOT NULL) AS has_graded_file
        FROM assignments
        WHERE grade_angel_id = ${session.id}
        ORDER BY created_at DESC
      `;
    } else {
      rows = await db.sql`
        SELECT id, teacher_id, title, subject, grade_level, assignment_type,
               page_count, rate_per_page_cents, instructions, status, created_at,
               (source_blob_key IS NOT NULL) AS has_source_file
        FROM assignments
        WHERE status = 'open'
        ORDER BY created_at ASC
      `;
    }
  } else if (session.role === "admin") {
    rows = statusFilter
      ? await db.sql`
          SELECT * FROM assignments WHERE status = ${statusFilter} ORDER BY created_at DESC
        `
      : await db.sql`SELECT * FROM assignments ORDER BY created_at DESC`;
  } else {
    return json({ error: "Unknown role" }, 403);
  }

  return json({ assignments: rows }, 200);
};

export const config: Config = {
  path: "/api/assignments/list",
};
