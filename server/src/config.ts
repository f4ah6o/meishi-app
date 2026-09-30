export interface AppConfig {
  port: number;
  /** Maximum accepted image size in bytes (decoded). */
  maxImageBytes: number;
  /** How long captured card images are kept on the gateway. */
  imageRetention: "ephemeral" | "keep";

  /** Authentication mode: "access" verifies Cloudflare Access JWT; "dev" trusts a header. */
  authMode: "access" | "dev";
  accessTeamName: string;
  accessAud: string;
  /** Identity used when authMode === "dev". */
  devUserEmail: string;

  rateLimitPerMinute: number;

  cardExtractor: "codex" | "stub";
  codexBin: string;
  codexModel: string | null;
  codexTimeoutMs: number;

  storeBackend: "kintone" | "memory";
  kintoneBaseUrl: string;
  /** Fallback API token used for every app; per-app tokens override it. */
  kintoneApiToken: string;
  kintoneApps: {
    corporations: { appId: string; token: string };
    contacts: { appId: string; token: string };
    businessCards: { appId: string; token: string };
    interactions: { appId: string; token: string };
  };

  corporateRegistry: "nta" | "gbizinfo" | "none";
  ntaAppId: string;
  gbizinfoApiToken: string;

  decisionProvider: "rule" | "jev";
  jevEndpoint: string;
  jevApiKey: string;
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export function loadConfig(envMap: NodeJS.ProcessEnv = process.env): AppConfig {
  const e = (name: string, fallback = "") => envMap[name] ?? fallback;
  return {
    port: Number(e("PORT", "8787")),
    maxImageBytes: Number(e("MAX_IMAGE_BYTES", String(6 * 1024 * 1024))),
    imageRetention: e("IMAGE_RETENTION", "ephemeral") === "keep" ? "keep" : "ephemeral",

    authMode: e("AUTH_MODE", env("AUTH_MODE", "dev")) === "access" ? "access" : "dev",
    accessTeamName: e("ACCESS_TEAM_NAME"),
    accessAud: e("ACCESS_AUD"),
    devUserEmail: e("DEV_USER_EMAIL", "dev@example.local"),

    rateLimitPerMinute: Number(e("RATE_LIMIT_PER_MINUTE", "60")),

    cardExtractor: e("CARD_EXTRACTOR", "codex") === "stub" ? "stub" : "codex",
    codexBin: e("CODEX_APP_SERVER_BIN", "codex"),
    codexModel: e("CODEX_MODEL") || null,
    codexTimeoutMs: Number(e("CODEX_TIMEOUT_MS", "120000")),

    storeBackend: e("STORE_BACKEND", "memory") === "kintone" ? "kintone" : "memory",
    kintoneBaseUrl: e("KINTONE_BASE_URL"),
    kintoneApiToken: e("KINTONE_API_TOKEN"),
    kintoneApps: {
      corporations: {
        appId: e("KINTONE_CORPORATIONS_APP_ID"),
        token: e("KINTONE_CORPORATIONS_APP_TOKEN") || e("KINTONE_API_TOKEN"),
      },
      contacts: {
        appId: e("KINTONE_CONTACTS_APP_ID"),
        token: e("KINTONE_CONTACTS_APP_TOKEN") || e("KINTONE_API_TOKEN"),
      },
      businessCards: {
        appId: e("KINTONE_CARDS_APP_ID"),
        token: e("KINTONE_CARDS_APP_TOKEN") || e("KINTONE_API_TOKEN"),
      },
      interactions: {
        appId: e("KINTONE_INTERACTIONS_APP_ID"),
        token: e("KINTONE_INTERACTIONS_APP_TOKEN") || e("KINTONE_API_TOKEN"),
      },
    },

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
