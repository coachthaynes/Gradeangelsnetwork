import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { gradeAngelEarningsCents } from "../lib/grade-angel.mts";

// What each role sees on the marketplace board:
//   teacher     -> the assignments they posted, any status, with who has it
//                  and the latest note (a decline or hand back reason)
//   grade_angel -> ?scope=open (default): open work anyone can take
//                  ?scope=invited: open work a teacher sent to them
//                  ?scope=mine: work they have accepted
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
      SELECT a.id, a.grade_angel_id, a.title, a.subject, a.grade_level, a.assignment_type,
             a.page_count, a.rate_per_page_cents, a.instructions, a.status, a.created_at,
             a.accepted_at, a.submitted_at, a.completed_at, a.turnaround_hours, a.due_at,
             (a.source_blob_key IS NOT NULL) AS has_source_file,
             (a.graded_blob_key IS NOT NULL) AS has_graded_file,
             ga.full_name AS grade_angel_name,
             inv.full_name AS invited_grade_angel_name,
             p.status AS payment_status,
             p.payout_status AS payout_status,
             ev.kind AS last_event_kind,
             ev.note AS last_event_note
      FROM assignments a
      LEFT JOIN users ga ON ga.id = a.grade_angel_id
      LEFT JOIN users inv ON inv.id = a.invited_grade_angel_id
      LEFT JOIN LATERAL (
        SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT kind, note FROM assignment_events WHERE assignment_id = a.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) ev ON true
      WHERE a.teacher_id = ${session.id}
      ORDER BY a.created_at DESC
    `;
  } else if (session.role === "grade_angel") {
    if (scope === "mine") {
      rows = await db.sql`
        SELECT a.id, a.grade_angel_id, a.title, a.subject, a.grade_level, a.assignment_type,
               a.page_count, a.rate_per_page_cents, a.instructions, a.status, a.created_at,
               a.accepted_at, a.submitted_at, a.completed_at, a.turnaround_hours, a.due_at,
               (a.source_blob_key IS NOT NULL) AS has_source_file,
               (a.graded_blob_key IS NOT NULL) AS has_graded_file,
               p.status AS payment_status,
               p.payout_status AS payout_status
        FROM assignments a
        LEFT JOIN LATERAL (
          SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
        ) p ON true
        WHERE a.grade_angel_id = ${session.id}
        ORDER BY a.created_at DESC
      `;
    } else if (scope === "invited") {
      rows = await db.sql`
        SELECT id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents,
               instructions, status, created_at, published_at, turnaround_hours
        FROM assignments
        WHERE status = 'open' AND invited_grade_angel_id = ${session.id}
        ORDER BY published_at ASC NULLS LAST, created_at ASC
      `;
    } else {
      rows = await db.sql`
        SELECT id, title, subject, grade_level, assignment_type, page_count, rate_per_page_cents,
               instructions, status, created_at, published_at, turnaround_hours
        FROM assignments
        WHERE status = 'open' AND invited_grade_angel_id IS NULL
        ORDER BY published_at ASC NULLS LAST, created_at ASC
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

  // Grade Angels see what they will actually take home, after the
  // platform's share, next to the teacher's posted rate.
  if (session.role === "grade_angel") {
    rows = rows.map((a: any) => ({
      ...a,
      earnings_cents: gradeAngelEarningsCents(a.page_count * a.rate_per_page_cents),
    }));
  }

  return json({ assignments: rows }, 200);
};

export const config: Config = {
  path: "/api/assignments/list",
};
