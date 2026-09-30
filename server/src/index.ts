import { serve } from "@hono/node-server";
import { buildDeps, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

// Repo-root .env is optional; real deployments may inject env vars directly.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // no .env file
}

const config = loadConfig();
const app = createApp(buildDeps(config));

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(
    JSON.stringify({
      type: "startup",
      port: info.port,
      host: config.host,
      extractor: config.cardExtractor,
      store: config.storeBackend,
      registry: config.corporateRegistry,
      auth: config.authMode,
    }),
  );
});
