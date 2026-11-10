import { createApp } from "./app.js";
import { config } from "./config.js";
import { startStats } from "./stats.js";
import { startCleanup } from "./cleanup.js";

if (!config.configSecret || config.configSecret.length < 32) {
  console.error("CONFIG_SECRET (32+ characters) is required: it encrypts everyone's settings into their manifest URL.");
  console.error("Make one with `openssl rand -hex 32`, put it in .env, and keep it: changing it breaks every link.");
  process.exit(1);
}
if (!config.publicBaseUrl) {
  console.warn("PUBLIC_BASE_URL is unset: the configure page can't make links until it's set to this addon's address.");
}
if (!config.adminPassword || config.adminPassword.length < 8) {
  console.error("ADMIN_PASSWORD (8+ characters) is required: it signs in to the dashboard, which shows what everyone played.");
  process.exit(1);
}
if (!config.addonPassword) console.warn("ADDON_PASSWORD is unset: anyone who can open /configure can make a link (fine behind a proxy login).");
if (config.allowedAiostreams.length === 0) {
  console.warn("ALLOWED_AIOSTREAMS is empty: no AIOStreams URL will be accepted, so nothing will sync.");
}

await startStats();
startCleanup();

createApp().listen(config.port, () => {
  console.log(`AIOSubtitles listening on :${config.port}; configure at ${config.publicBaseUrl ?? "<PUBLIC_BASE_URL>"}/configure`);
  console.log(`AIOStreams accepted from: ${config.allowedAiostreams.join(", ") || "none"} (reached at ${config.aiostreamsBase})`);
});
