/** Cloudflare Worker bindings (wrangler.toml) + vars/secrets. */
export interface WorkerEnv {
  /** D1 database — [[d1_databases]] binding DB. */
  DB: D1Database;
  /** Static PWA assets — [assets] binding ASSETS with run_worker_first. */
  ASSETS?: Fetcher;

  /** "local" enables AUTH_MODE=dev; production deployments always "production". */
  ENVIRONMENT?: string;
  /** "dev" trusts DEV_USER_EMAIL — honored only when ENVIRONMENT=local. */
  AUTH_MODE?: string;
  DEV_USER_EMAIL?: string;
  /** Access team subdomain (https://<team>.cloudflareaccess.com). */
  ACCESS_TEAM_NAME?: string;
  /** Access application AUD tag for JWT verification. */
  ACCESS_AUD?: string;

  MAX_IMAGE_BYTES?: string;
  RATE_LIMIT_PER_MINUTE?: string;

  /** OpenCode Zen Go API (secret via `wrangler secret put OPENCODE_API_KEY`). */
  OPENCODE_BASE_URL?: string;
  OPENCODE_MODEL?: string;
  OPENCODE_API_KEY?: string;
  OPENCODE_TIMEOUT_MS?: string;
  /** Stable session id sent as x-opencode-session (default "meishi-app"). */
  OPENCODE_SESSION?: string;

  CORPORATE_REGISTRY?: string;
  NTA_APP_ID?: string;
  GBIZINFO_API_TOKEN?: string;

  DECISION_PROVIDER?: string;
  JEV_ENDPOINT?: string;
  JEV_API_KEY?: string;
}

export interface WorkerConfig {
  environment: "local" | "production";
  authMode: "access" | "dev";
  devUserEmail: string;
  accessTeamName: string;
  accessAud: string;
  maxImageBytes: number;
  rateLimitPerMinute: number;
  opencodeBaseUrl: string;
  opencodeModel: string;
  opencodeApiKey: string;
  opencodeTimeoutMs: number;
  opencodeSession: string;
  corporateRegistry: "nta" | "gbizinfo" | "none";
  ntaAppId: string;
  gbizinfoApiToken: string;
  decisionProvider: "rule" | "jev";
  jevEndpoint: string;
  jevApiKey: string;
}

export function loadWorkerConfig(env: WorkerEnv): WorkerConfig {
  const e = (name: keyof WorkerEnv, fallback = "") => (env[name] as string | undefined) ?? fallback;
  return {
    environment: e("ENVIRONMENT", "production") === "local" ? "local" : "production",
    authMode: e("AUTH_MODE", "access") === "dev" ? "dev" : "access",
    devUserEmail: e("DEV_USER_EMAIL", "dev@example.local"),
    accessTeamName: e("ACCESS_TEAM_NAME"),
    accessAud: e("ACCESS_AUD"),
    maxImageBytes: Number(e("MAX_IMAGE_BYTES", String(6 * 1024 * 1024))),
    rateLimitPerMinute: Number(e("RATE_LIMIT_PER_MINUTE", "60")),
    opencodeBaseUrl: e("OPENCODE_BASE_URL", "https://opencode.ai/zen/go/v1"),
    opencodeModel: e("OPENCODE_MODEL", "deepseek-v4-flash-vision-exp"),
    opencodeApiKey: e("OPENCODE_API_KEY"),
    opencodeTimeoutMs: Number(e("OPENCODE_TIMEOUT_MS", "60000")),
    opencodeSession: e("OPENCODE_SESSION", "meishi-app"),
    corporateRegistry: (() => {
      const v = e("CORPORATE_REGISTRY", "nta");
      return v === "gbizinfo" || v === "none" ? v : "nta";
    })(),
    ntaAppId: e("NTA_APP_ID"),
    gbizinfoApiToken: e("GBIZINFO_API_TOKEN"),
    decisionProvider: e("DECISION_PROVIDER", "rule") === "jev" ? "jev" : "rule",
    jevEndpoint: e("JEV_ENDPOINT"),
    jevApiKey: e("JEV_API_KEY"),
  };
}
