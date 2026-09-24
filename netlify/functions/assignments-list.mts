import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { gradeAngelEarningsCents } from "../lib/grade-angel.mts";
import { photoUrl, publicName } from "../lib/profiles.mts";

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
             ga.photo_updated_at AS grade_angel_photo_updated_at,
             inv.full_name AS invited_grade_angel_name,
             (SELECT rating FROM reviews WHERE assignment_id = a.id AND author_id = ${session.id}) AS my_rating,
             (SELECT COUNT(*)::int FROM assignment_messages m
                WHERE m.assignment_id = a.id AND m.grade_angel_id = a.grade_angel_id AND m.sender_id <> ${session.id}
                  AND m.id > COALESCE((SELECT last_read_message_id FROM assignment_chat_reads r
                                       WHERE r.assignment_id = a.id AND r.user_id = ${session.id}), 0)) AS unread_messages,
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
               p.payout_status AS payout_status,
               a.teacher_id, t.full_name AS teacher_full_name, t.display_name AS teacher_display_name,
               t.photo_updated_at AS teacher_photo_updated_at,
               (SELECT COUNT(*)::int FROM assignment_messages m
                WHERE m.assignment_id = a.id AND m.grade_angel_id = a.grade_angel_id AND m.sender_id <> ${session.id}
                  AND m.id > COALESCE((SELECT last_read_message_id FROM assignment_chat_reads r
                                       WHERE r.assignment_id = a.id AND r.user_id = ${session.id}), 0)) AS unread_messages,
               (SELECT rating FROM reviews WHERE assignment_id = a.id AND author_id = ${session.id}) AS my_rating
        FROM assignments a
        JOIN users t ON t.id = a.teacher_id
        LEFT JOIN LATERAL (
          SELECT status, payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
        ) p ON true
        WHERE a.grade_angel_id = ${session.id}
        ORDER BY a.created_at DESC
      `;
    } else if (scope === "invited") {
      rows = await db.sql`
        SELECT a.id, a.title, a.subject, a.grade_level, a.assignment_type, a.page_count, a.rate_per_page_cents,
               a.instructions, a.status, a.created_at, a.published_at, a.turnaround_hours,
               a.teacher_id, t.full_name AS teacher_full_name, t.display_name AS teacher_display_name,
               t.photo_updated_at AS teacher_photo_updated_at
        FROM assignments a JOIN users t ON t.id = a.teacher_id
        WHERE a.status = 'open' AND a.invited_grade_angel_id = ${session.id}
        ORDER BY a.published_at ASC NULLS LAST, a.created_at ASC
      `;
    } else {
      rows = await db.sql`
        SELECT a.id, a.title, a.subject, a.grade_level, a.assignment_type, a.page_count, a.rate_per_page_cents,
               a.instructions, a.status, a.created_at, a.published_at, a.turnaround_hours,
               a.teacher_id, t.full_name AS teacher_full_name, t.display_name AS teacher_display_name,
               t.photo_updated_at AS teacher_photo_updated_at
        FROM assignments a JOIN users t ON t.id = a.teacher_id
        WHERE a.status = 'open' AND a.invited_grade_angel_id IS NULL
        ORDER BY a.published_at ASC NULLS LAST, a.created_at ASC
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
  // Teachers appear to Grade Angels only by their public name.
  if (session.role === "grade_angel") {
    rows = rows.map(({ teacher_full_name, teacher_display_name, teacher_photo_updated_at, ...a }: any) => ({
      ...a,
      teacher_name: publicName({ role: "teacher", full_name: teacher_full_name, display_name: teacher_display_name }),
      teacher_photo_url: photoUrl(a.teacher_id, teacher_photo_updated_at),
      earnings_cents: gradeAngelEarningsCents(a.page_count * a.rate_per_page_cents),
    }));
  } else if (session.role === "teacher") {
    rows = rows.map(({ grade_angel_photo_updated_at, ...a }: any) => ({
      ...a,
      grade_angel_photo_url: a.grade_angel_id ? photoUrl(a.grade_angel_id, grade_angel_photo_updated_at) : null,
    }));
  }

  return json({ assignments: rows }, 200);
};

export const config: Config = {
  path: "/api/assignments/list",
};
