import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { APPROVAL_REMINDER_DAYS, AUTO_APPROVE_DAYS, approveAssignment } from "../lib/grading.mts";
import { notifyUser } from "../lib/notify.mts";

// Runs every hour. Graded work waiting on the teacher gets a reminder after
// APPROVAL_REMINDER_DAYS, and is approved automatically after
// AUTO_APPROVE_DAYS so the Grade Angel is still paid. Disputed work waits
// for staff, and work the teacher has not paid for yet is left for staff too.
export default async () => {
  const remind = await db.sql`
    SELECT id, teacher_id, title FROM assignments
    WHERE status = 'submitted' AND disputed_at IS NULL AND approval_reminder_at IS NULL
      AND submitted_at < NOW() - make_interval(days => ${APPROVAL_REMINDER_DAYS})
    LIMIT 200
  `;
  for (const a of remind) {
    const claimed = await db.sql`UPDATE assignments SET approval_reminder_at = NOW() WHERE id = ${a.id} AND approval_reminder_at IS NULL RETURNING id`;
    if (!claimed.length) continue;
    await notifyUser(a.teacher_id, {
      subject: `Waiting on you: ${a.title}`,
      body: `Your graded work for **${a.title}** is ready for review. Please approve it or ask for changes. If we do not hear from you within ${AUTO_APPROVE_DAYS - APPROVAL_REMINDER_DAYS} more days, it is approved automatically so your Grade Angel is paid.`,
      ctaLabel: "Review the graded work",
      ctaPath: `/assignment.html?id=${a.id}`,
    });
  }

  const due = await db.sql`
    SELECT a.id FROM assignments a
    WHERE a.status = 'submitted' AND a.disputed_at IS NULL
      AND a.submitted_at < NOW() - make_interval(days => ${AUTO_APPROVE_DAYS})
      AND EXISTS (SELECT 1 FROM payments p WHERE p.assignment_id = a.id AND p.status = 'paid')
    LIMIT 100
  `;
  let approved = 0;
  for (const a of due) if (await approveAssignment(a.id, null, true)) approved++;
  console.log(`auto-approve: ${remind.length} reminders, ${approved} approved`);
  return new Response(JSON.stringify({ reminded: remind.length, approved }), { headers: { "content-type": "application/json" } });
};

export const config: Config = {
  schedule: "@hourly",
};
