import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { app } from "../../src/index.js";

process.env.NODE_ENV = "test";

describe("OAuth 2.1 HTTP Endpoint Integration", () => {
  let server: http.Server;
  let port: number;
  let baseUrl: string;

  before(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address() as any;
        port = addr.port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => {
      if (server) {
        server.closeAllConnections?.();
        server.close(() => resolve());
      } else {
        resolve();
      }
    });
  });

  test("POST /oauth/token with client_credentials issues access and refresh tokens", async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "macosui-analyst",
        client_secret: "analyst-secret-2026",
      }),
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.ok(body.access_token);
    assert.ok(body.refresh_token);
    assert.equal(body.token_type, "Bearer");
    assert.equal(typeof body.expires_in, "number");
  });

  test("POST /oauth/token with refresh_token issues fresh access token", async () => {
    // 1. Initial acquisition
    const initialRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "macosui-analyst",
        client_secret: "analyst-secret-2026",
      }),
    });
    const initialTokens = await initialRes.json();

    // 2. Refresh
    const refreshRes = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: initialTokens.refresh_token,
        client_id: "macosui-analyst",
        client_secret: "analyst-secret-2026",
      }),
    });

    assert.equal(refreshRes.status, 200);
    const refreshBody = (await refreshRes.json()) as any;
    assert.ok(refreshBody.access_token);
    assert.ok(refreshBody.refresh_token);
    assert.notEqual(refreshBody.access_token, initialTokens.access_token);
  });

  test("POST /oauth/token rejects invalid client credentials with 401", async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "macosui-analyst",
        client_secret: "wrong-password",
      }),
    });

    assert.equal(res.status, 401);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_client");
  });

  test("POST /oauth/token rejects missing refresh_token with 400", async () => {
    const res = await fetch(`${baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "macosui-analyst",
        client_secret: "analyst-secret-2026",
      }),
    });

    assert.equal(res.status, 400);
    const body = (await res.json()) as any;
    assert.equal(body.error, "invalid_request");
  });
});
