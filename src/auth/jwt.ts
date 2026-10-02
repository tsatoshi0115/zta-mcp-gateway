import jwt from "jsonwebtoken";
import { AuthContext, GatewayConfig } from "../types/index.js";

export interface VerifyTokenOptions {
  secretOrPublicKey?: string;
  algorithms?: jwt.Algorithm[];
}

/**
 * Verifies the incoming Bearer JWT and extracts client ID and roles.
 */
export function verifyToken(
  token: string,
  config: GatewayConfig,
  customSecret?: string
): AuthContext {
  const secretKey =
    customSecret ||
    (config.auth?.local_jwt_secret_env
      ? process.env[config.auth.local_jwt_secret_env]
      : undefined) ||
    process.env.GATEWAY_JWT_SECRET ||
    "zta-dev-default-secret-change-in-production";

  try {
    const decoded = jwt.verify(token, secretKey, {
      issuer: config.auth?.issuer,
      audience: config.auth?.audience,
    }) as Record<string, any>;

    // Reject refresh tokens used as access tokens
    if (decoded.token_type && decoded.token_type !== "access") {
      throw new Error(`Invalid token type: expected access token, got '${decoded.token_type}'`);
    }

    // Extract roles from standard or custom claims
    let roles: string[] = [];
    if (Array.isArray(decoded.roles)) {
      roles = decoded.roles;
    } else if (typeof decoded.role === "string") {
      roles = [decoded.role];
    } else if (typeof decoded.scope === "string") {
      roles = decoded.scope.split(" ");
    } else if (decoded.realm_access?.roles && Array.isArray(decoded.realm_access.roles)) {
      roles = decoded.realm_access.roles;
    }

    const clientId = decoded.sub || decoded.client_id || decoded.clientId || "anonymous-agent";

    return {
      clientId,
      roles,
      scopes: typeof decoded.scope === "string" ? decoded.scope.split(" ") : undefined,
      issuedAt: decoded.iat,
      expiresAt: decoded.exp,
    };
  } catch (error: any) {
    throw new Error(`JWT verification failed: ${error.message}`);
  }
}

/**
 * Extracts Bearer token from HTTP Authorization header
 */
export function extractBearerToken(authHeader?: string): string | null {
  if (!authHeader) return null;
  const parts = authHeader.trim().split(" ");
  if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
    return parts[1];
  }
  return null;
}
