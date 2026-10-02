import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { GatewayConfig, OAuthClient } from "../types/index.js";

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope?: string;
}

export interface RefreshTokenPayload {
  sub: string;
  roles: string[];
  token_type: "refresh";
  jti: string;
  iss?: string;
  aud?: string;
  iat?: number;
  exp?: number;
}

/**
 * Resolves configured OAuth clients from config file, environment variables, or defaults.
 */
export function resolveClients(config: GatewayConfig): OAuthClient[] {
  const clients: OAuthClient[] = [];

  // 1. From YAML config
  if (config.auth?.clients && Array.isArray(config.auth.clients)) {
    clients.push(...config.auth.clients);
  }

  // 2. From environment variables (allows defining or overriding via .env)
  const envClientId = process.env.GATEWAY_CLIENT_ID;
  const envClientSecret = process.env.GATEWAY_CLIENT_SECRET;
  if (envClientId && envClientSecret) {
    const envRoles = process.env.GATEWAY_CLIENT_ROLES
      ? process.env.GATEWAY_CLIENT_ROLES.split(",").map((r) => r.trim()).filter(Boolean)
      : ["analyst"];

    const existingIndex = clients.findIndex((c) => c.client_id === envClientId);
    if (existingIndex >= 0) {
      clients[existingIndex] = { client_id: envClientId, client_secret: envClientSecret, roles: envRoles };
    } else {
      clients.push({ client_id: envClientId, client_secret: envClientSecret, roles: envRoles });
    }
  }

  // 3. Fallback to default clients if none configured
  if (clients.length === 0) {
    clients.push(
      { client_id: "macosui-analyst", client_secret: "analyst-secret-2026", roles: ["analyst"] },
      { client_id: "macosui-admin", client_secret: "admin-secret-2026", roles: ["admin"] }
    );
  }

  return clients;
}

/**
 * Returns the secret key for signing Access Tokens.
 */
export function getJwtSecret(config: GatewayConfig): string {
  return (
    (config.auth?.local_jwt_secret_env
      ? process.env[config.auth.local_jwt_secret_env]
      : undefined) ||
    process.env.GATEWAY_JWT_SECRET ||
    "zta-dev-default-secret-change-in-production"
  );
}

/**
 * Returns the secret key for signing Refresh Tokens.
 */
export function getRefreshSecret(config: GatewayConfig): string {
  return (
    process.env.GATEWAY_REFRESH_SECRET ||
    getJwtSecret(config)
  );
}

/**
 * Parses duration string (e.g., "1h", "7d", "3600s", or number string) into seconds.
 */
export function parseDurationToSeconds(duration: string | number, defaultSeconds: number): number {
  if (typeof duration === "number") return duration;
  if (!duration) return defaultSeconds;

  const match = duration.match(/^(\d+)([smhd])?$/);
  if (!match) return defaultSeconds;

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      return value;
  }
}

/**
 * Issues a new Access Token and Refresh Token for an authenticated client.
 */
export function issueTokens(
  client: OAuthClient,
  config: GatewayConfig,
  options?: {
    scope?: string;
    accessTokenExpiresIn?: string;
    refreshTokenExpiresIn?: string;
  }
): TokenResponse {
  const jwtSecret = getJwtSecret(config);
  const refreshSecret = getRefreshSecret(config);

  const issuer = config.auth?.issuer || "https://auth.techies.tokyo";
  const audience = config.auth?.audience || "zta-mcp-gateway";

  const accessExpiryStr =
    options?.accessTokenExpiresIn ||
    process.env.GATEWAY_ACCESS_TOKEN_EXPIRES_IN ||
    "1h";
  const refreshExpiryStr =
    options?.refreshTokenExpiresIn ||
    process.env.GATEWAY_REFRESH_TOKEN_EXPIRES_IN ||
    "7d";

  const accessExpiresInSec = parseDurationToSeconds(accessExpiryStr, 3600);

  // Access Token (JWT with unique jti)
  const accessToken = jwt.sign(
    {
      sub: client.client_id,
      roles: client.roles,
      token_type: "access",
      jti: crypto.randomUUID(),
      scope: options?.scope || client.roles.join(" "),
    },
    jwtSecret,
    {
      issuer,
      audience,
      expiresIn: accessExpiryStr as any,
    }
  );

  // Refresh Token (JWT with unique jti and token_type: refresh)
  const refreshToken = jwt.sign(
    {
      sub: client.client_id,
      roles: client.roles,
      token_type: "refresh",
      jti: crypto.randomUUID(),
    },
    refreshSecret,
    {
      issuer,
      audience,
      expiresIn: refreshExpiryStr as any,
    }
  );

  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: accessExpiresInSec,
    refresh_token: refreshToken,
    scope: options?.scope || client.roles.join(" "),
  };
}

/**
 * Verifies a Refresh Token and returns its decoded payload.
 */
export function verifyRefreshToken(
  refreshToken: string,
  config: GatewayConfig
): RefreshTokenPayload {
  const refreshSecret = getRefreshSecret(config);
  const issuer = config.auth?.issuer || "https://auth.techies.tokyo";
  const audience = config.auth?.audience || "zta-mcp-gateway";

  try {
    const decoded = jwt.verify(refreshToken, refreshSecret, {
      issuer,
      audience,
    }) as Record<string, any>;

    if (decoded.token_type !== "refresh") {
      throw new Error("Invalid token type: expected refresh token");
    }

    return {
      sub: decoded.sub,
      roles: Array.isArray(decoded.roles) ? decoded.roles : [],
      token_type: "refresh",
      jti: decoded.jti,
      iss: decoded.iss,
      aud: decoded.aud,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  } catch (error: any) {
    throw new Error(`Refresh token verification failed: ${error.message}`);
  }
}

/**
 * Refreshes an Access Token using a valid Refresh Token and client credentials.
 */
export function refreshTokens(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
  config: GatewayConfig
): TokenResponse {
  // 1. Authenticate client
  const clients = resolveClients(config);
  const matchedClient = clients.find(
    (c) => c.client_id === clientId && c.client_secret === clientSecret
  );

  if (!matchedClient) {
    throw new Error("invalid_client: Client authentication failed");
  }

  // 2. Verify Refresh Token
  const payload = verifyRefreshToken(refreshToken, config);

  // 3. Ensure token belongs to the requesting client
  if (payload.sub !== matchedClient.client_id) {
    throw new Error("invalid_grant: Refresh token was not issued to this client");
  }

  // 4. Issue fresh tokens
  return issueTokens(matchedClient, config);
}
