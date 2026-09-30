/**
 * Thin kintone REST client. Auth is an app API token per request; the token is
 * never exposed to the browser — it only exists in gateway env vars.
 */
export class KintoneClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getRecords(
    appId: string,
    token: string,
    query: string,
    fields?: string[],
  ): Promise<KintoneRecord[]> {
    const url = new URL("/k/v1/records.json", this.baseUrl);
    url.searchParams.set("app", appId);
    url.searchParams.set("query", query);
    if (fields) for (const f of fields) url.searchParams.append(`fields[${0}]`, f);
    const res = await this.fetchImpl(url, {
      headers: { "X-Cybozu-API-Token": token },
    });
    if (!res.ok) throw new Error(`kintone GET failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { records: KintoneRecord[] };
    return body.records;
  }

  async postRecord(
    appId: string,
    token: string,
    record: Record<string, { value: unknown }>,
  ): Promise<{ id: string }> {
    const res = await this.fetchImpl(new URL("/k/v1/record.json", this.baseUrl), {
      method: "POST",
      headers: { "X-Cybozu-API-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ app: Number(appId), record }),
    });
    if (!res.ok) throw new Error(`kintone POST failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { id: string };
  }

  async putRecord(
    appId: string,
    token: string,
    id: string,
    record: Record<string, { value: unknown }>,
  ): Promise<void> {
    const res = await this.fetchImpl(new URL("/k/v1/record.json", this.baseUrl), {
      method: "PUT",
      headers: { "X-Cybozu-API-Token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ app: Number(appId), id: Number(id), record }),
    });
    if (!res.ok) throw new Error(`kintone PUT failed: ${res.status} ${await res.text()}`);
  }
}

export type KintoneRecord = Record<string, { value: unknown }> & {
  $id?: { value: string };
};

export function recordId(record: KintoneRecord): string {
  return String(record.$id?.value ?? record.Record_number?.value ?? "");
}

export function field(record: KintoneRecord, name: string): string {
  const v = record[name]?.value;
  return v == null ? "" : String(v);
}

/** Escape a string literal inside a kintone query. */
export function q(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
