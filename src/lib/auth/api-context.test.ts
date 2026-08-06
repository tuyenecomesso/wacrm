import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError } from "@/lib/api/v1/respond";
import { __resetRateLimitForTests, RATE_LIMITS } from "@/lib/rate-limit";

// Mock the store so we control which row a hash resolves to. The
// auth fallback path resolves through `resolveBearerKey` (auth.ts),
// which imports these from the same module specifier — the mock
// intercepts both call sites.
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// Import AFTER the mocks are registered.
const {
  requireApiKey,
  requireScope,
  contextFromInternalHeaders,
  INTERNAL_ACCOUNT_HEADER,
  INTERNAL_CREATED_BY_HEADER,
  INTERNAL_KEY_HEADER,
  INTERNAL_SCOPES_HEADER,
} = await import("./api-context");

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function reqWithInternalHeaders(overrides: {
  accountId?: string;
  createdBy?: string | null;
  keyId?: string;
  scopes?: string[];
}): Request {
  const headers = new Headers();
  headers.set(INTERNAL_ACCOUNT_HEADER, overrides.accountId ?? "acct-1");
  headers.set(INTERNAL_KEY_HEADER, overrides.keyId ?? "key-1");
  if (overrides.createdBy !== null) {
    headers.set(INTERNAL_CREATED_BY_HEADER, overrides.createdBy ?? "user-1");
  }
  headers.set(INTERNAL_SCOPES_HEADER, (overrides.scopes ?? []).join(","));
  return new Request("https://crm.example.com/api/v1/me", { headers });
}

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: "acct-1",
    created_by: "user-1",
    name: "Test key",
    scopes: ["messages:send"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
});

afterEach(() => {
  __resetRateLimitForTests();
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe("requireApiKey", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(requireApiKey(reqWith()), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a wacrm key", async () => {
    await expectApiError(
      requireApiKey(reqWith("Bearer some-invite-token")),
      "unauthorized",
      401,
    );
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired (store returns null)", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "unauthorized",
      401,
    );
  });

  it("returns a context for a valid key with no scope required", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyId).toBe("key-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe("acct-1");
  });

  it("403s when the key lacks the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["contacts:read"] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send"),
      "forbidden",
      403,
    );
  });

  it("passes when the key has the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["messages:send"] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send");
    expect(ctx.accountId).toBe("acct-1");
  });

  it("429s once the per-key budget is exhausted", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    // Burn the whole window.
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "rate_limited",
      429,
    );
  });

  it("reads the context from middleware-injected headers (fast path)", async () => {
    const ctx = await requireApiKey(
      reqWithInternalHeaders({ scopes: ["messages:send"] }),
    );
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyId).toBe("key-1");
    expect(ctx.createdBy).toBe("user-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    // No DB hit on the fast path.
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("403s on the fast path when the injected scopes lack the required scope", async () => {
    await expectApiError(
      requireApiKey(
        reqWithInternalHeaders({ scopes: ["contacts:read"] }),
        "messages:send",
      ),
      "forbidden",
      403,
    );
  });
});

describe("contextFromInternalHeaders", () => {
  it("returns null when the internal headers are absent", () => {
    expect(contextFromInternalHeaders(reqWith())).toBeNull();
  });

  it("parses the injected scopes header", () => {
    const ctx = contextFromInternalHeaders(
      reqWithInternalHeaders({ scopes: ["a:b", "c:d"] }),
    );
    expect(ctx?.scopes).toEqual(["a:b", "c:d"]);
  });

  it("preserves the injected createdBy header on the fast path", () => {
    const ctx = contextFromInternalHeaders(
      reqWithInternalHeaders({ createdBy: "user-9" }),
    );
    expect(ctx?.authType).toBe("api_key");
    expect(ctx && "createdBy" in ctx ? ctx.createdBy : null).toBe("user-9");
  });
});

describe("requireScope", () => {
  it("passes when the scope is granted", () => {
    expect(() => requireScope(["messages:send"], "messages:send")).not.toThrow();
  });

  it("throws a typed 403 when the scope is missing", () => {
    try {
      requireScope(["contacts:read"], "messages:send");
      throw new Error("expected requireScope to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe("forbidden");
      expect(apiError.status).toBe(403);
    }
  });

  it("passes for a first-party key (null sentinel = trusted)", () => {
    expect(() => requireScope(null, "admin")).not.toThrow();
  });

  it("passes when no scope is required", () => {
    expect(() => requireScope(["contacts:read"], undefined)).not.toThrow();
  });
});
