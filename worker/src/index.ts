import type { Hono } from "hono";
import { buildDeps, createWorkerApp } from "./app.ts";
import type { WorkerEnv } from "./env.ts";

// The app (and its middleware state, e.g. the rate-limit window Map) is
// isolate-scoped: build it once, not per request, or per-request rebuilds
// would reset the limiter and never enforce the configured rate.
let app: Hono<{ Bindings: WorkerEnv }> | null = null;

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    app ??= createWorkerApp(buildDeps(env));
    return app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
