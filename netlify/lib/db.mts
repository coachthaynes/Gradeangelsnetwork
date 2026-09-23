import { getDatabase } from "@netlify/database";

// One shared entry point for the Postgres database Netlify provisions for
// this site. Every function imports `db` from here rather than calling
// getDatabase() itself, so there is one place to change if that ever needs
// to be swapped out.
export const db = getDatabase();

export type UserRole = "teacher" | "grade_angel" | "admin";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: UserRole;
  full_name: string;
  school_or_org: string | null;
  subjects: string | null;
  background_check_status: string;
  stripe_account_id: string | null;
  stripe_charges_enabled: boolean;
  created_at: string;
}

export interface AssignmentRow {
  id: number;
  teacher_id: number;
  grade_angel_id: number | null;
  title: string;
  subject: string;
  grade_level: string;
  assignment_type: "multiple_choice" | "combo" | "essay";
  page_count: number;
  rate_per_page_cents: number;
  instructions: string | null;
  source_blob_key: string | null;
  graded_blob_key: string | null;
  status: "open" | "accepted" | "submitted" | "completed" | "cancelled";
  created_at: string;
  accepted_at: string | null;
  submitted_at: string | null;
  completed_at: string | null;
}
