import { db } from "./db.mts";
import { isTestEmail } from "./test-accounts.mts";

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
  personal_complete: boolean;
  profile_complete: boolean;
  agreement_signed: boolean;
  // Steps 1 to 3: everything we collect ourselves.
  info_complete: boolean;
  background_check_status: string;
  background_check_clear: boolean;
  payouts_ready: boolean;
  // Whether the outside services are connected yet. Until they are, steps
  // 4 and 5 show as opening soon instead of blocking the rest of setup.
  checkr_available: boolean;
  stripe_available: boolean;
  // Live: every step done, so the Grade Angel can accept work.
  ready: boolean;
  // A test account (see lib/test-accounts.mts): steps 4 and 5 are skipped.
  test_account: boolean;
}

// The five setup steps a Grade Angel must finish before their account is
// live and they can accept work. The dashboard, the setup page, and every
// endpoint that gates on setup read from this one place so they can never
// disagree about whether someone is ready.
export async function getSetupStatus(userId: number): Promise<SetupStatus | null> {
  let [user] = await db.sql`
    SELECT email, role, personal_completed_at, profile_completed_at, confidentiality_agreed_at,
           contractor_agreement_signed_at, background_check_status, stripe_payouts_ready
    FROM users WHERE id = ${userId}
  `;
  if (!user) return null;

  // Test accounts pass the background check and payout setup, since those
  // need Checkr and Stripe. Written to the account so every other check
  // (the Grade Angel list, go live emails) agrees.
  const testAccount = user.role === "grade_angel" && isTestEmail(user.email);
  if (testAccount && (user.background_check_status !== "clear" || !user.stripe_payouts_ready)) {
    [user] = await db.sql`
      UPDATE users SET background_check_status = 'clear', stripe_payouts_ready = true,
             stripe_account_id = COALESCE(stripe_account_id, 'acct_test_mode')
      WHERE id = ${userId}
      RETURNING email, role, personal_completed_at, profile_completed_at, confidentiality_agreed_at,
                contractor_agreement_signed_at, background_check_status, stripe_payouts_ready
    `;
  }

  const personalComplete = Boolean(user.personal_completed_at);
  const profileComplete = Boolean(user.profile_completed_at);
  const agreementSigned = Boolean(user.confidentiality_agreed_at && user.contractor_agreement_signed_at);
  const infoComplete = personalComplete && profileComplete && agreementSigned;
  const backgroundCheckClear = user.background_check_status === "clear";
  const payoutsReady = Boolean(user.stripe_payouts_ready);

  return {
    personal_complete: personalComplete,
    profile_complete: profileComplete,
    agreement_signed: agreementSigned,
    info_complete: infoComplete,
    background_check_status: user.background_check_status,
    background_check_clear: backgroundCheckClear,
    payouts_ready: payoutsReady,
    checkr_available: Boolean(Netlify.env.get("CHECKR_API_KEY")),
    stripe_available: Boolean(Netlify.env.get("STRIPE_SECRET_KEY")),
    ready: infoComplete && backgroundCheckClear && payoutsReady,
    test_account: testAccount,
  };
}
