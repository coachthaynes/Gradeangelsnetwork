import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isSuspended } from "../lib/staff.mts";
import { publicName } from "../lib/profiles.mts";
import { DEFAULT_COMMENT_BANK, cleanAnnotation, cleanGroups, gradingAccess, scoreList } from "../lib/grading.mts";

// The grading screen. GET loads an assignment's pages, marks, groups, and
// the person's comment bank. POST saves one page's marks, the page groups,
// or the comment bank.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  const url = new URL(req.url);
  const body = req.method === "POST" ? await readJson(req) : null;
  if (req.method === "POST" && !body) return json({ error: "Body must be JSON" }, 400);
  if (req.method !== "GET" && req.method !== "POST") return methodNotAllowed(["GET", "POST"]);

  // The comment bank belongs to the person, not an assignment.
  if (body?.action === "save_bank") {
    const items = Array.isArray(body.items) ? body.items.map((s: unknown) => String(s).trim().slice(0, 120)).filter(Boolean).slice(0, 60) : null;
    if (!items) return json({ error: "items must be a list" }, 400);
    await db.sql`UPDATE users SET comment_bank = ${JSON.stringify(items)}::jsonb WHERE id = ${session.id}`;
    return json({ comment_bank: items }, 200);
  }

  const assignmentId = Number(body?.assignment_id ?? url.searchParams.get("assignment_id"));
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);

  const [a] = await db.sql`
    SELECT a.id, a.title, a.subject, a.grade_level, a.assignment_type, a.status, a.teacher_id, a.grade_angel_id,
           a.instructions, a.page_count, a.grading_groups, a.grade_angel_note, a.revision_count, a.revision_note,
           a.disputed_at, a.due_at, t.full_name AS teacher_full_name, t.display_name AS teacher_display_name,
           g.full_name AS grade_angel_name
    FROM assignments a JOIN users t ON t.id = a.teacher_id LEFT JOIN users g ON g.id = a.grade_angel_id
    WHERE a.id = ${assignmentId}
  `;
  if (!a) return json({ error: "Assignment not found" }, 404);
  const access = await gradingAccess(session, a);
  if (!access) return json({ error: "You do not have access to grade this assignment" }, 403);

  const pages = await db.sql`
    SELECT page_index, width, height FROM assignment_pages WHERE assignment_id = ${assignmentId} ORDER BY page_index
  `;

  if (req.method === "POST") {
    if (!access.canEdit || !access.layer) return json({ error: "This assignment can no longer be marked" }, 409);
    if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);

    if (body!.action === "save_page") {
      const pageIndex = Number(body!.page_index);
      if (!pages.some((p: any) => p.page_index === pageIndex)) return json({ error: "Page not found" }, 404);
      const { data, error } = cleanAnnotation(body!.data);
      if (error) return json({ error }, 400);
      await db.sql`
        INSERT INTO assignment_annotations (assignment_id, page_index, layer, author_id, data, updated_at)
        VALUES (${assignmentId}, ${pageIndex}, ${access.layer}, ${session.id}, ${JSON.stringify(data)}::jsonb, NOW())
        ON CONFLICT (assignment_id, page_index, layer)
        DO UPDATE SET data = EXCLUDED.data, author_id = EXCLUDED.author_id, updated_at = NOW()
      `;
      return json({ ok: true, saved_at: new Date().toISOString() }, 200);
    }
    if (body!.action === "save_groups") {
      if (access.layer !== "grade_angel") return json({ error: "Only the Grade Angel sets up page groups" }, 403);
      const { groups, error } = cleanGroups(body!.groups, pages.length);
      if (error) return json({ error }, 400);
      await db.sql`UPDATE assignments SET grading_groups = ${JSON.stringify(groups)}::jsonb WHERE id = ${assignmentId}`;
      return json({ groups, scores: await scoreList(assignmentId, groups!, pages.length) }, 200);
    }
    return json({ error: "Unknown action" }, 400);
  }

  // The teacher has now looked over the graded work.
  if (access.layer === "teacher" && access.sees.includes("grade_angel") && a.status === "submitted") {
    await db.sql`UPDATE assignments SET graded_viewed_at = COALESCE(graded_viewed_at, NOW()) WHERE id = ${assignmentId}`;
  }

  const marks = access.sees.length ? await db.sql`
    SELECT page_index, layer, data, updated_at FROM assignment_annotations
    WHERE assignment_id = ${assignmentId} AND layer = ANY(${access.sees})
  ` : [];
  const [me] = await db.sql`SELECT comment_bank FROM users WHERE id = ${session.id}`;
  const groups = a.grading_groups || [];

  return json({
    assignment: {
      id: a.id,
      title: a.title,
      subject: a.subject,
      grade_level: a.grade_level,
      assignment_type: a.assignment_type,
      status: a.status,
      instructions: a.instructions,
      due_at: a.due_at,
      grade_angel_note: a.grade_angel_note,
      revision_count: a.revision_count,
      revision_note: a.revision_note,
      disputed: Boolean(a.disputed_at),
      teacher_name: publicName({ role: "teacher", full_name: a.teacher_full_name, display_name: a.teacher_display_name }),
      grade_angel_name: a.grade_angel_name,
    },
    pages,
    layer: access.layer,
    can_edit: access.canEdit,
    locked: Boolean((access as any).locked),
    groups,
    marks,
    scores: (access as any).locked ? [] : await scoreList(assignmentId, groups, pages.length),
    comment_bank: me?.comment_bank || DEFAULT_COMMENT_BANK,
  }, 200);
};

export const config: Config = {
  path: "/api/grading",
};
