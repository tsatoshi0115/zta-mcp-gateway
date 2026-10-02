import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import {
  issueTokens,
  verifyRefreshToken,
  refreshTokens,
  resolveClients,
  getJwtSecret,
} from "../../src/auth/oauth.js";
import { verifyToken } from "../../src/auth/jwt.js";
import { OAuthTokenManager } from "../../src/auth/client.js";
import { GatewayConfig } from "../../src/types/index.js";

describe("OAuth 2.1 Token Issuance & Refresh Flow", () => {
  const originalEnv = { ...process.env };

  const mockConfig: GatewayConfig = {
    version: "1.0",
    server: { port: 8080 },
    auth: {
      issuer: "https://auth.techies.tokyo",
      audience: "zta-mcp-gateway",
      clients: [
        { client_id: "test-analyst", client_secret: "secret-analyst-123", roles: ["analyst"] },
        { client_id: "test-admin", client_secret: "secret-admin-123", roles: ["admin"] },
      ],
    },
    secrets: { provider: "local" },
    upstreams: [],
  };

  beforeEach(() => {
    process.env.GATEWAY_JWT_SECRET = "test-jwt-secret-very-secure-1234567890";
    process.env.GATEWAY_REFRESH_SECRET = "test-refresh-secret-very-secure-1234567890";
    delete process.env.GATEWAY_CLIENT_ID;
    delete process.env.GATEWAY_CLIENT_SECRET;
    delete process.env.GATEWAY_CLIENT_ROLES;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("issueTokens issues valid access_token and refresh_token", () => {
    const client = mockConfig.auth!.clients![0];
    const tokens = issueTokens(client, mockConfig, { accessTokenExpiresIn: "1h", refreshTokenExpiresIn: "7d" });

    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.token_type, "Bearer");
    assert.equal(tokens.expires_in, 3600);

    // Verify access token with verifyToken
    const authContext = verifyToken(tokens.access_token, mockConfig);
    assert.equal(authContext.clientId, "test-analyst");
    assert.deepEqual(authContext.roles, ["analyst"]);

    // Verify refresh token with verifyRefreshToken
    const refreshPayload = verifyRefreshToken(tokens.refresh_token, mockConfig);
    assert.equal(refreshPayload.sub, "test-analyst");
    assert.equal(refreshPayload.token_type, "refresh");
    assert.deepEqual(refreshPayload.roles, ["analyst"]);
    assert.ok(refreshPayload.jti);
  });

  test("refreshTokens generates fresh access_token with valid refresh_token", () => {
    const client = mockConfig.auth!.clients![0];
    const initialTokens = issueTokens(client, mockConfig);

    // Refresh using the refresh token
    const newTokens = refreshTokens(
      initialTokens.refresh_token,
      "test-analyst",
      "secret-analyst-123",
      mockConfig
    );

    assert.ok(newTokens.access_token);
    assert.ok(newTokens.refresh_token);
    assert.notEqual(newTokens.access_token, initialTokens.access_token);

    // Verify new access token is valid
    const authContext = verifyToken(newTokens.access_token, mockConfig);
    assert.equal(authContext.clientId, "test-analyst");
    assert.deepEqual(authContext.roles, ["analyst"]);
  });

  test("rejects refresh with incorrect client credentials", () => {
    const client = mockConfig.auth!.clients![0];
    const tokens = issueTokens(client, mockConfig);

    assert.throws(
      () => refreshTokens(tokens.refresh_token, "test-analyst", "wrong-secret", mockConfig),
      /invalid_client/
    );
  });

  test("rejects refresh when client ID does not match refresh token subject", () => {
    const analystClient = mockConfig.auth!.clients![0];
    const tokens = issueTokens(analystClient, mockConfig);

    // Try to refresh with admin credentials using analyst's refresh token
    assert.throws(
      () => refreshTokens(tokens.refresh_token, "test-admin", "secret-admin-123", mockConfig),
      /invalid_grant/
    );
  });

  test("rejects expired or tampered refresh token", () => {
    const expiredToken = jwt.sign(
      { sub: "test-analyst", token_type: "refresh", roles: ["analyst"], jti: "123" },
      process.env.GATEWAY_REFRESH_SECRET!,
      { expiresIn: "-1s", issuer: "https://auth.techies.tokyo", audience: "zta-mcp-gateway" }
    );

    assert.throws(
      () => verifyRefreshToken(expiredToken, mockConfig),
      /Refresh token verification failed/
    );

    assert.throws(
      () => refreshTokens(expiredToken, "test-analyst", "secret-analyst-123", mockConfig),
      /Refresh token verification failed/
    );
  });

  test("rejects refresh token used as Bearer access token in verifyToken", () => {
    const client = mockConfig.auth!.clients![0];
    const tokens = issueTokens(client, mockConfig);

    // 1. When GATEWAY_REFRESH_SECRET is different, fails signature check
    assert.throws(
      () => verifyToken(tokens.refresh_token, mockConfig),
      /invalid signature/
    );

    // 2. When Refresh Token was signed with JWT_SECRET, fails token_type check
    const sameSecretRefreshToken = jwt.sign(
      { sub: "test-analyst", token_type: "refresh", roles: ["analyst"], jti: "123" },
      process.env.GATEWAY_JWT_SECRET!,
      { expiresIn: "1h", issuer: "https://auth.techies.tokyo", audience: "zta-mcp-gateway" }
    );
    assert.throws(
      () => verifyToken(sameSecretRefreshToken, mockConfig),
      /Invalid token type: expected access token/
    );
  });

  test("resolveClients loads client defined via environment variables (.env)", () => {
    process.env.GATEWAY_CLIENT_ID = "env-agent-client";
    process.env.GATEWAY_CLIENT_SECRET = "env-super-secret";
    process.env.GATEWAY_CLIENT_ROLES = "operator,analyst";

    const resolved = resolveClients(mockConfig);
    const envClient = resolved.find((c) => c.client_id === "env-agent-client");

    assert.ok(envClient);
    assert.equal(envClient.client_secret, "env-super-secret");
    assert.deepEqual(envClient.roles, ["operator", "analyst"]);
  });

  test("OAuthTokenManager client helper handles automatic token acquisition and refresh", async () => {
    const client = mockConfig.auth!.clients![0];
    let tokenCallCount = 0;
    let refreshCallCount = 0;

    // Mock fetch for token endpoint
    const mockFetch: typeof fetch = async (_input, init) => {
      const body = new URLSearchParams(init?.body as string);
      const grantType = body.get("grant_type");

      if (grantType === "client_credentials") {
        tokenCallCount++;
        const tokens = issueTokens(client, mockConfig, { accessTokenExpiresIn: "2s" });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...tokens, expires_in: 2 }),
          text: async () => "",
        } as any;
      }

      if (grantType === "refresh_token") {
        refreshCallCount++;
        const refreshToken = body.get("refresh_token")!;
        const newTokens = refreshTokens(refreshToken, "test-analyst", "secret-analyst-123", mockConfig);
        return {
          ok: true,
          status: 200,
          json: async () => ({ ...newTokens, expires_in: 3600 }),
          text: async () => "",
        } as any;
      }

      return { ok: false, status: 400, text: async () => "Bad request" } as any;
    };

    const manager = new OAuthTokenManager({
      tokenUrl: "http://localhost:8080/oauth/token",
      clientId: "test-analyst",
      clientSecret: "secret-analyst-123",
      bufferSeconds: 1,
      fetchFn: mockFetch,
    });

    // 1. Initial acquisition
    const token1 = await manager.getAccessToken();
    assert.ok(token1);
    assert.equal(tokenCallCount, 1);
    assert.equal(refreshCallCount, 0);

    // 2. Immediate cached retrieval (should not call fetch again)
    const token2 = await manager.getAccessToken();
    assert.equal(token2, token1);
    assert.equal(tokenCallCount, 1);
    assert.equal(refreshCallCount, 0);

    // 3. Authorization header format
    const authHeader = await manager.getAuthorizationHeader();
    assert.equal(authHeader, `Bearer ${token1}`);

    // 4. Force token expiration and test automatic refresh
    const tokens = manager.getTokens()!;
    tokens.expiresAt = Math.floor(Date.now() / 1000) - 5; // Set to past

    const token3 = await manager.getAccessToken();
    assert.ok(token3);
    assert.equal(refreshCallCount, 1, "Should have called refresh_token grant");
  });
});
