import type { Config } from "@netlify/functions";
import { runCampaigns } from "../lib/drips.mts";

// Runs every hour: sends whatever campaign emails are due (see lib/drips.mts).
export default async () => {
  const result = await runCampaigns();
  console.log("email-campaigns", JSON.stringify(result));
};

export const config: Config = {
  schedule: "@hourly",
};
