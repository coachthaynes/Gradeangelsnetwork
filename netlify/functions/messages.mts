import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { MAX_MESSAGES_PER_MINUTE, MAX_MESSAGE_LENGTH, chatAccess, stripContactInfo, type ChatRow } from "../lib/chat.mts";
import { photoUrl, publicName } from "../lib/profiles.mts";

async function loadAssignment(assignmentId: number) {
  const [a] = await db.sql`
    SELECT a.id, a.teacher_id, a.grade_angel_id, a.status,
           p.payout_status,
           t.full_name AS teacher_full_name, t.display_name AS teacher_display_name, t.photo_updated_at AS teacher_photo,
           g.full_name AS angel_name, g.photo_updated_at AS angel_photo
    FROM assignments a
    JOIN users t ON t.id = a.teacher_id
    LEFT JOIN users g ON g.id = a.grade_angel_id
    LEFT JOIN LATERAL (
      SELECT payout_status FROM payments WHERE assignment_id = a.id ORDER BY id DESC LIMIT 1
    ) p ON true
    WHERE a.id = ${assignmentId}
  `;
  return a;
}

// GET  ?assignment_id=&after_id=  messages in the current thread (only
//      newer than after_id when polling), and marks them read.
// POST { assignment_id, body }     sends a message while the chat is open.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);

  let assignmentId: number;
  let body: Record<string, unknown> | null = null;
  if (req.method === "GET") {
    assignmentId = Number(new URL(req.url).searchParams.get("assignment_id"));
  } else if (req.method === "POST") {
    body = await readJson(req);
    if (!body) return json({ error: "Body must be JSON" }, 400);
    assignmentId = Number(body.assignment_id);
  } else {
    return methodNotAllowed(["GET", "POST"]);
  }
  if (!Number.isInteger(assignmentId)) return json({ error: "assignment_id is required" }, 400);

  const a = await loadAssignment(assignmentId);
  if (!a) return json({ error: "Assignment not found" }, 404);
  const access = chatAccess(session, a as ChatRow);
  if (!access.canRead) return json({ error: "This chat is not available" }, 403);

  if (req.method === "POST") {
    if (!access.canWrite) return json({ error: "This chat is closed" }, 409);

    const text = String(body!.body ?? "").trim();
    if (!text) return json({ error: "Type a message first" }, 400);
    if (text.length > MAX_MESSAGE_LENGTH) {
      return json({ error: `Messages can be up to ${MAX_MESSAGE_LENGTH} characters` }, 400);
    }

    const [recent] = await db.sql`
      SELECT COUNT(*)::int AS n FROM assignment_messages
      WHERE sender_id = ${session.id} AND created_at > NOW() - INTERVAL '1 minute'
    `;
    if (recent.n >= MAX_MESSAGES_PER_MINUTE) return json({ error: "Slow down a little, then try again" }, 429);

    const clean = stripContactInfo(text);
    await db.sql`
      INSERT INTO assignment_messages (assignment_id, grade_angel_id, sender_id, body, redacted)
      VALUES (${assignmentId}, ${a.grade_angel_id}, ${session.id}, ${clean.body}, ${clean.redacted})
    `;
  }

  const afterId = Number(new URL(req.url).searchParams.get("after_id")) || 0;
  const rows = await db.sql`
    SELECT id, sender_id, body, redacted, created_at
    FROM assignment_messages
    WHERE assignment_id = ${assignmentId} AND grade_angel_id = ${a.grade_angel_id} AND id > ${afterId}
    ORDER BY id ASC
    LIMIT 500
  `;

  // Mark everything up to the newest message as read for this person.
  const newest = rows.length ? rows[rows.length - 1].id : 0;
  if (newest && session.role !== "admin") {
    await db.sql`
      INSERT INTO assignment_chat_reads (assignment_id, user_id, last_read_message_id)
      VALUES (${assignmentId}, ${session.id}, ${newest})
      ON CONFLICT (assignment_id, user_id)
      DO UPDATE SET last_read_message_id = GREATEST(assignment_chat_reads.last_read_message_id, EXCLUDED.last_read_message_id)
    `;
  }

  // Everyone is shown by their public name: teachers by display name.
  const people: Record<number, { name: string; photo_url: string | null; role: string }> = {
    [a.teacher_id]: {
      name: publicName({ role: "teacher", full_name: a.teacher_full_name, display_name: a.teacher_display_name }),
      photo_url: photoUrl(a.teacher_id, a.teacher_photo),
      role: "teacher",
    },
    [a.grade_angel_id]: { name: a.angel_name, photo_url: photoUrl(a.grade_angel_id, a.angel_photo), role: "grade_angel" },
  };

  return json(
    {
      chat: { open: access.canWrite, closed_reason: access.canWrite ? null : access.closedReason, people },
      messages: rows.map((m: any) => ({ ...m, mine: m.sender_id === session.id })),
    },
    req.method === "POST" ? 201 : 200
  );
};

export const config: Config = {
  path: "/api/messages",
};
