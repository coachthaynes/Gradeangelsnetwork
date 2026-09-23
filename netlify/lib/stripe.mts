import Stripe from "stripe";

let cached: Stripe | null = null;

// Grade Angels are the ones who get paid, so each one needs a Stripe
// Connect Express account. The platform's 20% stays with the platform's
// own Stripe balance; the other 80% flows to the Grade Angel's account.
// Throws a clear, catchable error until a real Stripe account exists and
// its secret key has been added as the STRIPE_SECRET_KEY environment
// variable, so every caller can turn that into a friendly "not set up
// yet" response instead of a raw crash.
export function getStripe(): Stripe {
  if (cached) return cached;
  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    throw new StripeNotConfiguredError();
  }
  cached = new Stripe(key);
  return cached;
}

export class StripeNotConfiguredError extends Error {
  constructor() {
    super(
      "Stripe is not connected yet. Create a Stripe account, turn on Connect, " +
        "and add its secret key as the STRIPE_SECRET_KEY environment variable."
    );
    this.name = "StripeNotConfiguredError";
  }
}
