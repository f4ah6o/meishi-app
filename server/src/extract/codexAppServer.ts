import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { BusinessCardExtraction } from "@meishi/shared";
import { type CardExtractor, EXTRACTION_PROMPT, parseExtractionJson } from "./cardExtractor.ts";

/**
 * Client for `codex app-server`, Codex's bidirectional JSON-RPC interface.
 * Protocol (codex-rs/app-server):
 *   transport: newline-delimited JSON-RPC on stdio (no "jsonrpc" header on the wire)
 *   lifecycle: initialize -> initialized -> thread/start -> turn/start ->
 *              item/* notifications -> turn/completed
 */
export class CodexAppServerExtractor implements CardExtractor {
  constructor(
    private readonly options: {
      bin: string;
      model: string | null;
      timeoutMs: number;
    },
  ) {}

  async extract(imagePath: string): Promise<BusinessCardExtraction> {
    const reply = await runExtractionTurn(imagePath, this.options);
    return parseExtractionJson(reply);
  }
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function runExtractionTurn(
  imagePath: string,
  options: { bin: string; model: string | null; timeoutMs: number },
): Promise<string> {
  const child = spawn(options.bin, ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "inherit"],
  });

  const agentTexts: string[] = [];
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let nextId = 0;
  let buffer = "";
  let turnCompleted: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let turnFailed: string | null = null;

  const send = (msg: RpcMessage) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  const request = (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ id, method, params });
    });

  const onLine = (line: string) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return; // not a protocol line
    }
    if (msg.id !== undefined && pending.has(Number(msg.id))) {
      const p = pending.get(Number(msg.id));
      pending.delete(Number(msg.id));
      if (msg.error) p?.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.method === "item/completed") {
      const params = msg.params as { item?: { type?: string; text?: string } } | undefined;
      if (params?.item?.type === "agentMessage" && typeof params.item.text === "string") {
        agentTexts.push(params.item.text);
      }
    } else if (msg.method === "turn/completed") {
      const params = msg.params as { turn?: { status?: string; error?: { message?: string } } };
      // Only status "completed" is a success — "failed" and "interrupted" must
      // not be treated as a usable extraction.
      const status = params?.turn?.status;
      if (status !== "completed") {
        turnFailed =
          params?.turn?.error?.message ?? `turn ended with status "${status ?? "unknown"}"`;
      }
      turnCompleted?.resolve();
    }
  };

  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
      idx = buffer.indexOf("\n");
    }
  });

  const kill = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already dead */
    }
  };

  const timeout = setTimeout(() => {
    kill();
    turnCompleted?.reject(new Error(`codex app-server timed out after ${options.timeoutMs}ms`));
    for (const p of pending.values()) p.reject(new Error("timed out"));
    pending.clear();
  }, options.timeoutMs);

  const spawnError = new Promise<never>((_, reject) => {
    child.once("error", reject);
  });

  try {
    const work = (async () => {
      await request("initialize", {
        clientInfo: { name: "meishi-app", title: "meishi-app gateway", version: "0.1.0" },
        capabilities: {
          experimentalApi: false,
          optOutNotificationMethods: [
            "item/agentMessage/delta",
            "item/reasoning/summaryTextDelta",
            "item/reasoning/textDelta",
          ],
        },
      });
      send({ method: "initialized", params: {} });

      const threadResult = (await request("thread/start", {
        ephemeral: true,
        cwd: dirname(imagePath),
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions:
          "You are an OCR service. Return exactly one JSON object and nothing else. Do not run commands or edit files.",
        ...(options.model ? { model: options.model } : {}),
      })) as { thread: { id: string } };
      const threadId = threadResult.thread.id;

      const done = new Promise<void>((resolve, reject) => {
        turnCompleted = { resolve, reject };
      });
      await request("turn/start", {
        threadId,
        input: [
          { type: "text", text: EXTRACTION_PROMPT },
          { type: "localImage", path: imagePath },
        ],
      });
      await done;
      if (turnFailed) throw new Error(`codex turn failed: ${turnFailed}`);
      const text = agentTexts.at(-1);
      if (!text) throw new Error("codex turn produced no agent message");
      return text;
    })();
    return await Promise.race([work, spawnError]);
  } finally {
    clearTimeout(timeout);
    kill();
  }
}
