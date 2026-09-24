import type { SessionPayload } from "./auth.mts";

export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_MESSAGES_PER_MINUTE = 20;

export interface ChatRow {
  teacher_id: number;
  grade_angel_id: number | null;
  status: string;
  payout_status: string | null;
}

export interface ChatAccess {
  canRead: boolean;
  canWrite: boolean;
  // Why the chat is not open for writing, for the page to explain.
  closedReason: "not_started" | "paid_out" | "cancelled" | "not_participant" | null;
}

// The chat opens when a Grade Angel accepts the assignment and stays open
// while the work is graded, reviewed, and paid for. Once the Grade Angel has
// been paid out it becomes read only, kept as a record for both people (and
// for an admin settling a dispute). `activeStaff` must be checked by the
// caller (isActiveStaff), since a pending staff request gets no access.
export function chatAccess(session: SessionPayload, a: ChatRow, activeStaff = false): ChatAccess {
  const isTeacher = session.id === a.teacher_id;
  const isAngel = a.grade_angel_id !== null && session.id === a.grade_angel_id;
  const isAdmin = activeStaff;

  if (!a.grade_angel_id) {
    return { canRead: false, canWrite: false, closedReason: a.status === "cancelled" ? "cancelled" : "not_started" };
  }
  if (!isTeacher && !isAngel && !isAdmin) return { canRead: false, canWrite: false, closedReason: "not_participant" };

  if (a.status === "cancelled") return { canRead: true, canWrite: false, closedReason: "cancelled" };
  if (a.payout_status === "transferred") return { canRead: true, canWrite: false, closedReason: "paid_out" };

  const active = ["accepted", "submitted", "completed"].includes(a.status);
  return {
    canRead: true,
    canWrite: active && (isTeacher || isAngel),
    closedReason: active ? (isAdmin ? "not_participant" : null) : "not_started",
  };
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// Ten or more digits, allowing spaces, dots, dashes, and parentheses
// between them, catches US phone numbers however they are typed.
const PHONE = /(?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4}\b/g;

// Replaces email addresses and phone numbers with a placeholder. Keeps
// teachers anonymous to Grade Angels and keeps jobs on the platform.
export function stripContactInfo(text: string): { body: string; redacted: boolean } {
  let redacted = false;
  const body = text
    .replace(EMAIL, () => ((redacted = true), "[contact info removed]"))
    .replace(PHONE, () => ((redacted = true), "[contact info removed]"));
  return { body, redacted };
}
