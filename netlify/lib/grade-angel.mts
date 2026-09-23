import { db } from "./db.mts";

// The platform keeps 20% of every assignment; the Grade Angel gets the rest.
// assignments-pay.mts charges the fee and the list endpoint shows each Grade
// Angel what they will earn, so both read it from here.
export const PLATFORM_FEE_RATE = 0.2;

export function gradeAngelEarningsCents(totalCents: number): number {
  return totalCents - Math.round(totalCents * PLATFORM_FEE_RATE);
}

export const GRADE_LEVELS = ["elementary", "middle", "high"] as const;
export const ASSIGNMENT_TYPES = ["multiple_choice", "combo", "essay"] as const;

export interface SetupStatus {
  profile_complete: boolean;
  agreement_signed: boolean;
  background_check_status: string;
  background_check_clear: boolean;
  payouts_ready: boolean;
  ready: boolean;
}

// The three things a Grade Angel has to finish before they can accept
// work: a profile (with the confidentiality agreement), a clear background
// check, and a Stripe account that can receive payouts. The dashboard, the
// setup page, and the accept endpoint all read from this one place so they
// can never disagree about whether someone is ready.
export async function getSetupStatus(userId: number): Promise<SetupStatus | null> {
  const [user] = await db.sql`
    SELECT profile_completed_at, confidentiality_agreed_at, background_check_status, stripe_payouts_ready
    FROM users WHERE id = ${userId}
  `;
  if (!user) return null;

  const profileComplete = Boolean(user.profile_completed_at);
  const agreementSigned = Boolean(user.confidentiality_agreed_at);
  const backgroundCheckClear = user.background_check_status === "clear";
  const payoutsReady = Boolean(user.stripe_payouts_ready);

  return {
    profile_complete: profileComplete,
    agreement_signed: agreementSigned,
    background_check_status: user.background_check_status,
    background_check_clear: backgroundCheckClear,
    payouts_ready: payoutsReady,
    ready: profileComplete && agreementSigned && backgroundCheckClear && payoutsReady,
  };
}
