import { describe, expect, it } from "vitest";
import { type AppConfig, loadConfig } from "../src/config.ts";
import { KintoneClient, type KintoneRecord } from "../src/kintone/client.ts";
import { KintoneStore } from "../src/kintone/kintoneStore.ts";

function makeConfig(): AppConfig {
  return loadConfig({
    AUTH_MODE: "dev",
    CARD_EXTRACTOR: "stub",
    KINTONE_CORPORATIONS_APP_ID: "1",
    KINTONE_CONTACTS_APP_ID: "2",
    KINTONE_CARDS_APP_ID: "3",
    KINTONE_INTERACTIONS_APP_ID: "4",
  });
}

/** fetch stub that records every request URL and replies canned records. */
function fakeFetch(respond: (url: URL) => KintoneRecord[]) {
  const urls: URL[] = [];
  const impl = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    urls.push(url);
    return new Response(JSON.stringify({ records: respond(url) }), { status: 200 });
  }) as typeof fetch;
  return { impl, urls };
}

const contactRecord = (id: string, corpId = "42"): KintoneRecord => ({
  $id: { value: id },
  corporation_id: { value: corpId },
  name: { value: "山田太郎" },
  department: { value: "" },
  title: { value: "" },
  email: { value: "" },
  phone: { value: "" },
  mobile: { value: "" },
});

describe("KintoneStore $id queries", () => {
  it("queries getContact with a numeric $id literal, not a string", async () => {
    const { impl, urls } = fakeFetch(() => [contactRecord("1175")]);
    const store = new KintoneStore(
      new KintoneClient("https://example.cybozu.com", impl),
      makeConfig(),
    );
    const contact = await store.getContact("1175");
    expect(contact?.person_id).toBe("1175");
    const query = urls[0]?.searchParams.get("query") ?? "";
    expect(query).toBe("$id = 1175 limit 1");
    expect(query).not.toContain('"');
  });

  it("returns null for a non-numeric person_id without calling kintone", async () => {
    const { impl, urls } = fakeFetch(() => []);
    const store = new KintoneStore(
      new KintoneClient("https://example.cybozu.com", impl),
      makeConfig(),
    );
    expect(await store.getContact("person-abc")).toBeNull();
    expect(urls).toHaveLength(0);
  });

  it("hydrates the corporation with a numeric $id literal", async () => {
    const { impl, urls } = fakeFetch((url) => {
      const query = url.searchParams.get("query") ?? "";
      if (query.includes("name like")) return [contactRecord("1175", "42")];
      if (query.includes("$id")) {
        return [
          {
            $id: { value: "42" },
            corporate_number: { value: "1234567890123" },
            official_name: { value: "株式会社山田建設" },
          },
        ];
      }
      return [];
    });
    const store = new KintoneStore(
      new KintoneClient("https://example.cybozu.com", impl),
      makeConfig(),
    );
    const contacts = await store.searchContacts({ personName: "山田" });
    expect(contacts[0]?.official_name).toBe("株式会社山田建設");
    const corpQuery = urls
      .map((u) => u.searchParams.get("query") ?? "")
      .find((query) => query.startsWith("$id ="));
    expect(corpQuery).toBe("$id = 42 limit 1");
  });
});
