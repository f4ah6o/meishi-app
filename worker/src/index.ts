import { buildDeps, createWorkerApp } from "./app.ts";
import type { WorkerEnv } from "./env.ts";

export default {
  fetch(request: Request, env: WorkerEnv, ctx: ExecutionContext): Response | Promise<Response> {
    return createWorkerApp(buildDeps(env)).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<WorkerEnv>;
