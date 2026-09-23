import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { PREVIEW_PAGE_LIMIT, assignmentAccess, type AccessRow } from "../lib/assignments.mts";
import { gradeAngelEarningsCents } from "../lib/grade-angel.mts";

// Everything the assignment page needs. What comes back depends on who is
// asking: Grade Angels never see who the teacher is (the 2019 plan keeps
// teachers anonymous to graders), and only see as many pages as their
// access allows.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);

  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const assignmentId = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(assignmentId)) return json({ error: "id is required" }, 400);

  const [a] = await db.sql`
    SELECT a.id, a.teacher_id, a.grade_angel_id, a.invited_grade_angel_id, a.title, a.subject,
           a.grade_level, a.assignment_type, a.page_count, a.rate_per_page_cents, a.instructions,
           a.status, a.turnaround_hours, a.due_at, a.created_at, a.published_at, a.accepted_at,
           a.submitted_at, a.completed_at, a.cancelled_at,
           (a.source_blob_key IS NOT NULL) AS has_source_file,
           (a.graded_blob_key IS NOT NULL) AS has_graded_file,
           ga.full_name AS grade_angel_name,
           inv.full_name AS invited_grade_angel_name,
           p.status AS payment_status,
           p.payout_status AS payout_status,
           (SELECT COUNT(*)::int FROM assignment_pages ap WHERE ap.assignment_id = a.id) AS stored_pages
    FROM assignments a
    LEFT JOIN users ga ON ga.id = a.grade_angel_id
    LEFT JOIN users inv ON inv.id = a.invited_grade_angel_id
    LEFT JOIN LATERAL (
      SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
    ) p ON true
    WHERE a.id = ${assignmentId}
  `;
  if (!a) return json({ error: "Assignment not found" }, 404);

  const access = await assignmentAccess(session, a as AccessRow);
  if (access === "none") return json({ error: "You do not have access to this assignment" }, 403);

  const viewablePages =
    access === "full" ? a.stored_pages : access === "preview" ? Math.min(a.stored_pages, PREVIEW_PAGE_LIMIT) : 0;

  const assignment: Record<string, unknown> = {
    ...a,
    total_cents: a.page_count * a.rate_per_page_cents,
    viewable_pages: viewablePages,
    access,
  };

  let events: unknown[] = [];
  if (session.role === "grade_angel") {
    // Keep the teacher anonymous and hide other Grade Angels' names.
    delete assignment.teacher_id;
    delete assignment.invited_grade_angel_name;
    delete assignment.grade_angel_name;
    assignment.invited_you = a.invited_grade_angel_id === session.id;
    delete assignment.invited_grade_angel_id;
    assignment.earnings_cents = gradeAngelEarningsCents(a.page_count * a.rate_per_page_cents);
  } else {
    events = await db.sql`
      SELECT e.kind, e.note, e.created_at, u.full_name AS actor_name, u.role AS actor_role
      FROM assignment_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.assignment_id = ${assignmentId}
      ORDER BY e.created_at DESC, e.id DESC
    `;
  }

  return json({ assignment, events }, 200);
};

export const config: Config = {
  path: "/api/assignments/get",
};
