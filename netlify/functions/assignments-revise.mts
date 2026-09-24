import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson, recordEvent } from "../lib/assignments.mts";
import { isSuspended } from "../lib/staff.mts";
import { MAX_REVISIONS, REVISION_HOURS } from "../lib/grading.mts";
import { notifyUser } from "../lib/notify.mts";

// The teacher asks for changes instead of approving. The first time, the
// work goes back to the Grade Angel with the teacher's note and a new due
// time. After that, it goes to Grade Angels staff as a dispute.
export default async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed(["POST"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Only the posting teacher can ask for changes" }, 403);
  if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);

  const body = await readJson(req);
  const assignmentId = Number(body?.assignment_id);
  const note = String(body?.note || "").trim().slice(0, 2000);
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);
  if (note.length < 5) return json({ error: "Tell your Grade Angel what needs to change" }, 400);

  const [a] = await db.sql`
    SELECT id, teacher_id, grade_angel_id, title, status, revision_count, disputed_at FROM assignments WHERE id = ${assignmentId}
  `;
  if (!a || a.teacher_id !== session.id) return json({ error: "Assignment not found" }, 404);
  if (a.status !== "submitted") return json({ error: "You can ask for changes once graded work has been sent" }, 409);
  if (a.disputed_at) return json({ error: "Our team is already looking at this assignment" }, 409);

  if (a.revision_count >= MAX_REVISIONS) {
    await db.sql`UPDATE assignments SET disputed_at = NOW(), dispute_note = ${note} WHERE id = ${assignmentId}`;
    await recordEvent(assignmentId, session.id, "disputed", note);
    await notifyUser(a.grade_angel_id, {
      subject: `Our team is reviewing: ${a.title}`,
      body: `The teacher still has concerns about **${a.title}** after one round of changes, so our Dispute Resolution Team will review it and contact you both. Your payout waits until then.`,
      ctaPath: `/assignment.html?id=${assignmentId}`,
      ctaLabel: "See the assignment",
    });
    return json({ disputed: true }, 200);
  }

  const [updated] = await db.sql`
    UPDATE assignments
    SET status = 'accepted', revision_count = revision_count + 1, revision_note = ${note},
        revision_requested_at = NOW(), submitted_at = NULL, approval_reminder_at = NULL,
        due_at = NOW() + make_interval(hours => ${REVISION_HOURS})
    WHERE id = ${assignmentId} AND status = 'submitted'
    RETURNING id, status, due_at, revision_count
  `;
  if (!updated) return json({ error: "This assignment changed. Refresh and try again." }, 409);
  await recordEvent(assignmentId, session.id, "changes_requested", note);
  await notifyUser(a.grade_angel_id, {
    subject: `Changes requested: ${a.title}`,
    body: `The teacher asked for changes to **${a.title}**:\n\n${note}\n\nYou have ${REVISION_HOURS} hours to update the graded pages and send them again.`,
    ctaLabel: "Open the grading screen",
    ctaPath: `/grade.html?id=${assignmentId}`,
  });
  return json({ assignment: updated }, 200);
};

export const config: Config = {
  path: "/api/assignments/revise",
};
