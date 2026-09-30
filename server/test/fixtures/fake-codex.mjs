#!/usr/bin/env node
// Fake `codex app-server` speaking newline-delimited JSON-RPC on stdio.
// Turn status is controlled by FAKE_TURN_STATUS (default "interrupted").
const status = process.env.FAKE_TURN_STATUS ?? "interrupted";

const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx = buf.indexOf("\n");
  while (idx >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    idx = buf.indexOf("\n");
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.method === "initialize") {
      out({ id: msg.id, result: { userAgent: "fake-codex/0.0.0" } });
    } else if (msg.method === "thread/start") {
      out({ id: msg.id, result: { thread: { id: "thread_1" } } });
    } else if (msg.method === "turn/start") {
      out({ id: msg.id, result: { turn: { id: "turn_1", status: "inProgress" } } });
      out({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", text: '{"person_name":"山田太郎"}' },
        },
      });
      out({ method: "turn/completed", params: { turn: { id: "turn_1", status } } });
    }
  }
});

setInterval(() => {}, 60_000);
