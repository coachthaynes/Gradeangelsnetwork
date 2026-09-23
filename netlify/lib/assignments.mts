import { db } from "./db.mts";
import type { SessionPayload } from "./auth.mts";
import { assignmentFilesStore } from "./blobs.mts";
import { getSetupStatus } from "./grade-angel.mts";

// Grade Angels deciding whether to take an assignment can look at this many
// pages before accepting. Enough to judge the handwriting and the work,
// without handing a whole class set of student work to someone who has not
// committed to it.
export const PREVIEW_PAGE_LIMIT = 2;

export const MAX_PAGES = 200;
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const PAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export const TURNAROUND_HOURS = [24, 48, 72, 96];
export const DEFAULT_TURNAROUND_HOURS = 48;

// none:    cannot see this assignment at all
// details: can see what it is (title, pay, instructions) but no pages
// preview: details plus the first PREVIEW_PAGE_LIMIT pages
// full:    every page and file (the teacher, the assigned Grade Angel, admins)
export type Access = "none" | "details" | "preview" | "full";

export interface AccessRow {
  teacher_id: number;
  grade_angel_id: number | null;
  invited_grade_angel_id: number | null;
  status: string;
}

export async function assignmentAccess(session: SessionPayload, a: AccessRow): Promise<Access> {
  if (session.role === "admin") return "full";
  if (session.role === "teacher") return a.teacher_id === session.id ? "full" : "none";
  if (session.role !== "grade_angel") return "none";

  if (a.grade_angel_id === session.id) return "full";
  const invitedElsewhere = a.invited_grade_angel_id !== null && a.invited_grade_angel_id !== session.id;
  if (a.status !== "open" || invitedElsewhere) return "none";

  // Only vetted Grade Angels (setup finished) ever see student work.
  const setup = await getSetupStatus(session.id);
  return setup?.ready ? "preview" : "details";
}

export async function recordEvent(assignmentId: number, actorId: number | null, kind: string, note: string | null = null) {
  await db.sql`
    INSERT INTO assignment_events (assignment_id, actor_id, kind, note)
    VALUES (${assignmentId}, ${actorId}, ${kind}, ${note})
  `;
}

export function pageBlobKey(assignmentId: number, pageIndex: number): string {
  return `pages/${assignmentId}/${String(pageIndex).padStart(4, "0")}`;
}

// Removes every stored file for an assignment: its pages, any legacy
// single file upload, and graded work. Used when a teacher cancels, and
// later by the automatic clean up of finished work.
export async function deleteAssignmentFiles(assignmentId: number) {
  const store = assignmentFilesStore();
  for (const prefix of [`pages/${assignmentId}/`, `source/${assignmentId}/`, `graded/${assignmentId}/`]) {
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
  }
  await db.sql`DELETE FROM assignment_pages WHERE assignment_id = ${assignmentId}`;
}

// Reads the JSON body of a request, or returns null if it is not JSON.
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
