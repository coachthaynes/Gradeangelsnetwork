import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { readJson } from "../lib/assignments.mts";
import { isSuspended } from "../lib/staff.mts";
import { classStudents, parseRoster, saveRoster } from "../lib/gradebook.mts";

// A teacher's classes and student lists, for the gradebook. Only the
// teacher ever sees these names.
export default async (req: Request) => {
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "Classes are for teachers" }, 403);

  if (req.method === "POST") {
    if (await isSuspended(session.id)) return json({ error: "This account is suspended" }, 403);
    const body = await readJson(req);
    if (!body) return json({ error: "Body must be JSON" }, 400);
    const name = String(body.name || "").trim().slice(0, 60);
    if (body.action === "create") {
      if (!name) return json({ error: "Give the class a name, like Period 2 Math" }, 400);
      const [c] = await db.sql`INSERT INTO classes (teacher_id, name) VALUES (${session.id}, ${name}) RETURNING id`;
      await saveRoster(c.id, parseRoster(body.students));
    } else if (body.action === "update" || body.action === "delete") {
      const classId = Number(body.class_id);
      const [c] = await db.sql`SELECT id FROM classes WHERE id = ${classId} AND teacher_id = ${session.id}`;
      if (!c) return json({ error: "Class not found" }, 404);
      if (body.action === "delete") {
        await db.sql`DELETE FROM classes WHERE id = ${classId}`;
      } else {
        if (name) await db.sql`UPDATE classes SET name = ${name} WHERE id = ${classId}`;
        if (body.students !== undefined) await saveRoster(classId, parseRoster(body.students));
      }
    } else {
      return json({ error: "Unknown action" }, 400);
    }
  } else if (req.method !== "GET") {
    return methodNotAllowed(["GET", "POST"]);
  }

  const classes = await db.sql`SELECT id, name, created_at FROM classes WHERE teacher_id = ${session.id} ORDER BY name`;
  for (const c of classes) c.students = await classStudents(c.id);
  return json({ classes }, 200);
};

export const config: Config = {
  path: "/api/classes",
};
