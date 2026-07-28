import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { getCanonicalSiteOrigin, getReport } = await import("./client");

describe("Business Hub server client", () => {
  beforeEach(() => {
    process.env.BUSINESS_HUB_URL = "https://bh.internal";
    process.env.BH_INTERNAL_SECRET = "server-secret";
    process.env.WACRM_SITE_URL = "https://crm.example.ao/some-path";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ report: {} }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("keeps the internal secret server-side and scopes requests to the actor", async () => {
    await getReport(
      { userId: "user-1", accountId: "account-1" },
      "workspace/unsafe",
      "report/unsafe",
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(String(url)).toBe(
      "https://bh.internal/api/business-insights/workspaces/workspace%2Funsafe/reports/report%2Funsafe",
    );
    expect(headers.get("x-internal-secret")).toBe("server-secret");
    expect(headers.get("x-wacrm-user-id")).toBe("user-1");
    expect(headers.get("x-wacrm-account-id")).toBe("account-1");
    expect(headers.get("x-wacrm-site-url")).toBe("https://crm.example.ao");
    expect(init?.cache).toBe("no-store");
  });

  it("does not expose an insecure production site origin to the BH", () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.WACRM_SITE_URL = "http://localhost:3000";
    expect(getCanonicalSiteOrigin()).toBeNull();
  });
});
