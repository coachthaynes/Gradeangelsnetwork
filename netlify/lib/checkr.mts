// Thin wrapper around Checkr's REST API. There is no official package for
// it, so this talks to the HTTP API directly with fetch. Everything here
// throws CheckrNotConfiguredError until a real Checkr account exists and
// CHECKR_API_KEY is set, so callers can turn that into a friendly response
// rather than a raw crash. If the 2019 GoodHire relationship turns out to
// still be active, this file is the one to swap for a GoodHire equivalent.

const CHECKR_API_BASE = "https://api.checkr.com/v1";

export class CheckrNotConfiguredError extends Error {
  constructor() {
    super(
      "Background checks are not connected yet. Create a Checkr account " +
        "and add its API key as the CHECKR_API_KEY environment variable."
    );
    this.name = "CheckrNotConfiguredError";
  }
}

function getApiKey(): string {
  const key = Netlify.env.get("CHECKR_API_KEY");
  if (!key) throw new CheckrNotConfiguredError();
  return key;
}

async function checkrRequest(path: string, init: RequestInit = {}): Promise<any> {
  const key = getApiKey();
  const auth = Buffer.from(`${key}:`).toString("base64");
  const res = await fetch(`${CHECKR_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Checkr API error ${res.status}: ${text}`);
  }
  return res.json();
}

export async function createCandidateAndInvitation(email: string, fullName: string) {
  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const candidate = await checkrRequest("/candidates", {
    method: "POST",
    body: JSON.stringify({ email, first_name: firstName, last_name: lastName }),
  });

  // The package slug has to match whatever screening package is set up in
  // the Checkr dashboard once the account exists. CHECKR_PACKAGE lets that
  // be configured without touching code.
  const packageSlug = Netlify.env.get("CHECKR_PACKAGE") || "basic_plus";
  const invitation = await checkrRequest("/invitations", {
    method: "POST",
    body: JSON.stringify({ candidate_id: candidate.id, package: packageSlug }),
  });

  return { candidate, invitation };
}
