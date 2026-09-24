import type { Config } from "@netlify/functions";
import { db } from "../lib/db.mts";
import { getSession } from "../lib/auth.mts";
import { json, methodNotAllowed } from "../lib/http.mts";
import { classStudents, gradedAssignments, matchedScores } from "../lib/gradebook.mts";

// The gradebook for one class: students down the side, graded assignments
// across the top. ?class_id=none lists graded work not tied to a class.
// &format=csv downloads it as a spreadsheet.
export default async (req: Request) => {
  if (req.method !== "GET") return methodNotAllowed(["GET"]);
  const session = getSession(req);
  if (!session) return json({ error: "Sign in required" }, 401);
  if (session.role !== "teacher") return json({ error: "The gradebook is for teachers" }, 403);

  const url = new URL(req.url);
  const raw = url.searchParams.get("class_id");
  let cls: any = null;
  if (raw && raw !== "none") {
    [cls] = await db.sql`SELECT id, name FROM classes WHERE id = ${Number(raw)} AND teacher_id = ${session.id}`;
    if (!cls) return json({ error: "Class not found" }, 404);
  }

  const assignments = await gradedAssignments(session.id, cls ? cls.id : null);
  const columns: any[] = [];
  const cells: Record<string, Record<number, { earned: number | null; possible: number | null; pages: number[] }>> = {};
  const loose: any[] = [];
  for (const a of assignments) {
    const lines = await matchedScores(a);
    const scored = lines.filter((l) => l.earned !== null);
    if (!scored.length) continue;
    const possible = scored.find((l) => l.possible !== null)?.possible ?? null;
    columns.push({ id: a.id, title: a.title, subject: a.subject, date: a.completed_at || a.submitted_at, possible });
    for (const l of scored) {
      if (l.student_id) (cells[l.student_id] ||= {})[a.id] = { earned: l.earned, possible: l.possible, pages: l.pages };
      else loose.push({ assignment_id: a.id, assignment: a.title, label: l.label, earned: l.earned, possible: l.possible, pages: l.pages });
    }
  }
  const students = cls ? await classStudents(cls.id) : [];
  const rows = students.map((s: any) => {
    const mine = cells[s.id] || {};
    const got = Object.values(mine).filter((c) => c.earned !== null && c.possible);
    const pct = got.length ? Math.round((got.reduce((t, c) => t + (c.earned as number), 0) / got.reduce((t, c) => t + (c.possible as number), 0)) * 1000) / 10 : null;
    return { id: s.id, name: s.name, student_code: s.student_code, scores: mine, percent: pct };
  });

  if (url.searchParams.get("format") === "csv") {
    const cell = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const lines: string[] = [];
    if (cls) {
      lines.push(["Student", "ID", ...columns.map((c) => `${c.title}${c.possible ? ` (out of ${c.possible})` : ""}`), "Overall %"].map(cell).join(","));
      for (const r of rows) lines.push([r.name, r.student_code, ...columns.map((c) => r.scores[c.id]?.earned ?? ""), r.percent ?? ""].map(cell).join(","));
    } else {
      lines.push(["Assignment", "Student", "Score", "Out of"].map(cell).join(","));
      for (const l of loose) lines.push([l.assignment, l.label, l.earned, l.possible].map(cell).join(","));
    }
    const fname = `gradebook_${(cls?.name || "unassigned").replace(/[^\w]+/g, "_")}.csv`;
    return new Response(lines.join("\n"), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fname}"` },
    });
  }

  return json({ class: cls, columns, rows, unmatched: loose }, 200);
};

export const config: Config = {
  path: "/api/gradebook",
};
