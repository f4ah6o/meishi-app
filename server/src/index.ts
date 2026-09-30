import { serve } from "@hono/node-server";
import { buildDeps, createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const app = createApp(buildDeps(config));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(
    JSON.stringify({
      type: "startup",
      port: info.port,
      extractor: config.cardExtractor,
      store: config.storeBackend,
      registry: config.corporateRegistry,
      auth: config.authMode,
    }),
  );
});
