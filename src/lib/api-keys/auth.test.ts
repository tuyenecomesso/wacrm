import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";

// Mock the api-key store so we control which hash resolves to a row.
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// Mock the first-party secret lookup + decryption so we can simulate a
// matching `whsec_…` endpoint without a real DB or key.
const listBypassEndpointSecrets = vi.fn();
vi.mock("@/lib/webhooks/pg-repo", () => ({
  listBypassEndpointSecrets: () => listBypassEndpointSecrets(),
}));

vi.mock("@/lib/whatsapp/encryption", () => ({
  decrypt: (ciphertext: string) => ciphertext,
}));

// Import AFTER the mocks are registered.
const { resolveBearerKey } = await import("./auth");

const KEY = generateApiKey().plaintext;

function request(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function apiKeyRow(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
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

function endpoints(secrets: string[]): Array<{ id: string; account_id: string; secret: string }> {
  return secrets.map((secret, i) => ({
    id: `endpoint-${i}`,
    account_id: `acct-fp-${i}`,
    secret,
  }));
}

beforeEach(() => {
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
  listBypassEndpointSecrets.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveBearerKey", () => {
  it("resolves null when there is no Authorization header", async () => {
    await expect(resolveBearerKey(request())).resolves.toBeNull();
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("resolves null for a token that isn't a wacrm key or whsec", async () => {
    await expect(
      resolveBearerKey(request("Bearer some-invite-token")),
    ).resolves.toBeNull();
    expect(listBypassEndpointSecrets).not.toHaveBeenCalled();
  });

  it("resolves an api_key from a valid wacrm_live_ key", async () => {
    findActiveKeyByHash.mockResolvedValue(apiKeyRow());
    const resolved = await resolveBearerKey(request(`Bearer ${KEY}`));
    expect(resolved).toEqual({
      kind: "api_key",
      accountId: "acct-1",
      keyId: "key-1",
      scopes: ["messages:send"],
      createdBy: "user-1",
    });
    expect(findActiveKeyByHash).toHaveBeenCalledTimes(1);
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("resolves null for an unknown/revoked/expired key", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expect(resolveBearerKey(request(`Bearer ${KEY}`))).resolves.toBeNull();
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it("resolves a first-party whsec_ key to its endpoint", async () => {
    const secret = "whsec_super-secret";
    listBypassEndpointSecrets.mockResolvedValue(
      endpoints(["whsec_super-secret", "whsec_other"]),
    );
    const resolved = await resolveBearerKey(request(`Bearer ${secret}`));
    expect(resolved).toEqual({
      kind: "first_party",
      accountId: "acct-fp-0",
      endpointId: "endpoint-0",
    });
    // First-party resolution must not touch the api-key store.
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("resolves null when no whsec_ endpoint matches", async () => {
    listBypassEndpointSecrets.mockResolvedValue(endpoints(["whsec_other"]));
    await expect(
      resolveBearerKey(request("Bearer whsec_nomatch")),
    ).resolves.toBeNull();
  });

  it("tolerates a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(apiKeyRow());
    await expect(resolveBearerKey(request(KEY))).resolves.toMatchObject({
      kind: "api_key",
      accountId: "acct-1",
    });
  });
});
