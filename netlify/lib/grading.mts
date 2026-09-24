import { db } from "./db.mts";
import type { SessionPayload } from "./auth.mts";
import { isActiveStaff } from "./staff.mts";
import { recordEvent } from "./assignments.mts";
import { attemptPayout } from "./payouts.mts";
import { notifyUser } from "./notify.mts";

// On site grading. Marks live in assignment_annotations, one row per page
// per layer: the Grade Angel's layer and the teacher's layer. Positions are
// fractions of the page (0 to 1), so they line up at any screen size.

export type Layer = "grade_angel" | "teacher";

// A teacher may ask for changes this many times; after that it goes to
// staff as a dispute.
export const MAX_REVISIONS = 1;
// Days after graded work is sent: a reminder to the teacher, then approval
// happens on its own so the Grade Angel is still paid.
export const APPROVAL_REMINDER_DAYS = 3;
export const AUTO_APPROVE_DAYS = 5;
// Hours a Grade Angel gets to make the changes a teacher asked for.
export const REVISION_HOURS = 48;

export const MAX_ANNOTATION_BYTES = 300 * 1024;
const ITEM_TYPES = new Set(["pen", "hl", "stamp", "text"]);
const STAMPS = new Set(["check", "x", "circle", "star", "q"]);

export const DEFAULT_COMMENT_BANK = [
  "Show your work",
  "Check your units",
  "Great explanation!",
  "Reread the question",
  "Watch your spelling",
  "Complete sentences, please",
  "Nice improvement",
  "See me about this one",
];

const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
const frac = (v: unknown) => num(v) && (v as number) >= -0.05 && (v as number) <= 1.05;

// Checks a page's marks are the shape the grading screen writes, so nothing
// else can be stored in the page layers. Returns the cleaned data or an
// error message.
export function cleanAnnotation(raw: unknown): { data?: any; error?: string } {
  if (!raw || typeof raw !== "object") return { error: "Marks must be an object" };
  const input = raw as any;
  const items = Array.isArray(input.items) ? input.items : [];
  if (items.length > 2000) return { error: "Too many marks on one page" };
  const out: any[] = [];
  for (const it of items) {
    if (!it || !ITEM_TYPES.has(it.t)) return { error: "Unknown mark type" };
    const c = typeof it.c === "string" && /^#[0-9a-fA-F]{6}$/.test(it.c) ? it.c : "#D92D20";
    if (it.t === "pen" || it.t === "hl") {
      if (!Array.isArray(it.p) || it.p.length < 1 || it.p.length > 4000) return { error: "Bad stroke" };
      if (!it.p.every((pt: any) => Array.isArray(pt) && frac(pt[0]) && frac(pt[1]))) return { error: "Bad stroke point" };
      out.push({ t: it.t, c, w: num(it.w) ? Math.min(Math.max(it.w, 0.001), 0.05) : 0.004, p: it.p.map((pt: number[]) => [+pt[0].toFixed(4), +pt[1].toFixed(4)]) });
    } else if (it.t === "stamp") {
      if (!STAMPS.has(it.k) || !frac(it.x) || !frac(it.y)) return { error: "Bad stamp" };
      out.push({ t: "stamp", k: it.k, c, x: it.x, y: it.y, s: num(it.s) ? Math.min(Math.max(it.s, 0.01), 0.2) : 0.045 });
    } else {
      const text = String(it.text || "").slice(0, 500);
      if (!text.trim() || !frac(it.x) || !frac(it.y)) return { error: "Bad note" };
      out.push({ t: "text", c, x: it.x, y: it.y, s: num(it.s) ? Math.min(Math.max(it.s, 0.01), 0.08) : 0.024, text });
    }
  }
  const score = input.score && typeof input.score === "object" ? input.score : {};
  const scoreNum = (v: unknown) => (v === null || v === undefined || v === "" ? null : num(Number(v)) && Number(v) >= 0 && Number(v) <= 100000 ? Number(v) : undefined);
  const e = scoreNum(score.e);
  const p = scoreNum(score.p);
  if (e === undefined || p === undefined) return { error: "Scores must be numbers" };
  const data = { v: 1, items: out, score: { e, p } };
  if (JSON.stringify(data).length > MAX_ANNOTATION_BYTES) return { error: "This page has too many marks to save" };
  return { data };
}

export function cleanGroups(raw: unknown, pageCount: number): { groups?: any[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "Groups must be a list" };
  if (raw.length > 200) return { error: "Too many groups" };
  const used = new Set<number>();
  const groups: any[] = [];
  for (const g of raw) {
    const kind = g?.kind === "worksheet" ? "worksheet" : "student";
    const pages = Array.isArray(g?.pages) ? [...new Set(g.pages.map(Number))].filter((n: any) => Number.isInteger(n) && n >= 0 && n < pageCount) as number[] : [];
    if (!pages.length) return { error: "Each group needs at least one page" };
    for (const p of pages) {
      if (used.has(p)) return { error: `Page ${p + 1} is in two groups` };
      used.add(p);
    }
    pages.sort((a, b) => a - b);
    const label = String(g?.label || "").trim().slice(0, 60) || (kind === "worksheet" ? "Worksheet" : "Student");
    const group: any = { id: String(g?.id || `g${groups.length + 1}`).slice(0, 20), label, kind, pages };
    if (kind === "worksheet") group.key_page = pages.includes(Number(g?.key_page)) ? Number(g.key_page) : pages[0];
    groups.push(group);
  }
  return { groups };
}

// Whether the teacher has paid for an assignment. Graded work stays locked
// until they have, so no one can take the grading without paying.
export async function isPaid(assignmentId: number): Promise<boolean> {
  const [p] = await db.sql`SELECT 1 FROM payments WHERE assignment_id = ${assignmentId} AND status = 'paid' LIMIT 1`;
  return Boolean(p);
}

// What this person may do on the grading screen for this assignment.
export async function gradingAccess(session: SessionPayload, a: any) {
  const open = a.status === "accepted" || a.status === "submitted";
  if (session.role === "grade_angel" && a.grade_angel_id === session.id) {
    return { layer: "grade_angel" as Layer, canEdit: open && !a.disputed_at, sees: ["grade_angel", "teacher"] as Layer[] };
  }
  if (session.role === "teacher" && a.teacher_id === session.id) {
    // Teachers look but do not mark: the grading is the Grade Angel's work,
    // and changes go through Ask for changes. They see the marks once the
    // work has been sent, and only after paying for it.
    const graded = a.status === "submitted" || a.status === "completed" || a.revision_count > 0;
    const paid = await isPaid(a.id);
    return {
      layer: "teacher" as Layer,
      canEdit: false,
      sees: (graded && paid ? ["grade_angel", "teacher"] : []) as Layer[],
      locked: graded && !paid,
    };
  }
  if (session.role === "admin" && (await isActiveStaff(session.id))) {
    return { layer: null, canEdit: false, sees: ["grade_angel", "teacher"] as Layer[] };
  }
  return null;
}

// Page scores for the score list: the teacher's score for a page when they
// set one, otherwise the Grade Angel's.
export async function scoreList(assignmentId: number, groups: any[], pageCount: number) {
  const rows = await db.sql`
    SELECT page_index, layer, data->'score' AS score FROM assignment_annotations WHERE assignment_id = ${assignmentId}
  `;
  const byPage = new Map<number, { e: number | null; p: number | null }>();
  for (const layer of ["grade_angel", "teacher"]) {
    for (const r of rows.filter((x: any) => x.layer === layer)) {
      const s = r.score || {};
      if (s.e !== null && s.e !== undefined) byPage.set(r.page_index, { e: s.e, p: s.p ?? null });
    }
  }
  const lines: { label: string; pages: number[]; earned: number | null; possible: number | null }[] = [];
  const grouped = new Set<number>();
  const add = (label: string, pages: number[]) => {
    const scored = pages.map((p) => byPage.get(p)).filter(Boolean) as { e: number; p: number | null }[];
    lines.push({
      label,
      pages,
      earned: scored.length ? scored.reduce((t, s) => t + s.e, 0) : null,
      possible: scored.length && scored.every((s) => s.p !== null) ? scored.reduce((t, s) => t + (s.p as number), 0) : null,
    });
  };
  for (const g of groups) {
    g.pages.forEach((p: number) => grouped.add(p));
    if (g.kind === "student") add(g.label, g.pages);
    else g.pages.filter((p: number) => p !== g.key_page).forEach((p: number, i: number) => add(`${g.label}, paper ${i + 1} (page ${p + 1})`, [p]));
  }
  for (let p = 0; p < pageCount; p++) if (!grouped.has(p) && byPage.has(p)) add(`Page ${p + 1}`, [p]);
  return lines;
}

// Approves graded work: completes the assignment and pays the Grade Angel.
// Used by the teacher's Approve button and by automatic approval.
export async function approveAssignment(assignmentId: number, actorId: number | null, auto = false) {
  const [updated] = await db.sql`
    UPDATE assignments
    SET status = 'completed', completed_at = NOW(), auto_approved_at = ${auto ? new Date().toISOString() : null}
    WHERE id = ${assignmentId} AND status = 'submitted'
    RETURNING id, teacher_id, grade_angel_id, title, status, created_at, completed_at
  `;
  if (!updated) return null;
  await recordEvent(assignmentId, actorId, auto ? "auto_approved" : "completed");
  const payout = await attemptPayout(assignmentId);
  await notifyUser(updated.grade_angel_id, {
    subject: `Approved: ${updated.title}`,
    body: auto
      ? `The teacher did not respond within ${AUTO_APPROVE_DAYS} days, so your grading of **${updated.title}** was approved automatically and your payout is on its way.\n\nPlease rate the teacher when you have a moment.`
      : `The teacher approved your grading of **${updated.title}**, and your payout is on its way.\n\nPlease rate the teacher when you have a moment.`,
    ctaLabel: "Rate the teacher",
    ctaPath: `/assignment.html?id=${assignmentId}`,
  });
  if (auto) {
    await notifyUser(updated.teacher_id, {
      subject: `Approved automatically: ${updated.title}`,
      body: `The graded work for **${updated.title}** was waiting for ${AUTO_APPROVE_DAYS} days, so it was approved automatically and your Grade Angel was paid. The graded pages are still on the site.`,
      ctaLabel: "See the graded work",
      ctaPath: `/assignment.html?id=${assignmentId}`,
    });
  }
  return { assignment: updated, payout };
}
