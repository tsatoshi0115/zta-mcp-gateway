export interface OAuthTokenManagerOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
  bufferSeconds?: number;
  fetchFn?: typeof fetch;
}

export interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number; // Unix timestamp in seconds
  tokenType: string;
  scope?: string;
}

/**
 * Manages OAuth 2.1 access and refresh tokens for clients (agents, test scripts, UI).
 * Automatically acquires tokens via Client Credentials and refreshes them via Refresh Token.
 */
export class OAuthTokenManager {
  private tokenUrl: string;
  private clientId: string;
  private clientSecret: string;
  private scope?: string;
  private bufferSeconds: number;
  private fetchFn: typeof fetch;
  private currentTokens: StoredTokens | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(options: OAuthTokenManagerOptions) {
    this.tokenUrl = options.tokenUrl;
    this.clientId = options.clientId;
    this.clientSecret = options.clientSecret;
    this.scope = options.scope;
    this.bufferSeconds = options.bufferSeconds ?? 60;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  /**
   * Returns a valid Access Token. Automatically refreshes or re-authenticates if expired.
   */
  async getAccessToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);

    // Return cached token if valid and not close to expiring
    if (this.currentTokens && this.currentTokens.expiresAt - now > this.bufferSeconds) {
      return this.currentTokens.accessToken;
    }

    // Deduplicate concurrent refresh calls
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.resolveAccessToken();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  /**
   * Returns standard Authorization Bearer header value: "Bearer <token>"
   */
  async getAuthorizationHeader(): Promise<string> {
    const token = await this.getAccessToken();
    return `Bearer ${token}`;
  }

  /**
   * Gets current stored tokens if available.
   */
  getTokens(): StoredTokens | null {
    return this.currentTokens;
  }

  /**
   * Clears internal token cache.
   */
  clear(): void {
    this.currentTokens = null;
  }

  private async resolveAccessToken(): Promise<string> {
    // Attempt refresh if refresh_token is available
    if (this.currentTokens?.refreshToken) {
      try {
        await this.refreshWithRefreshToken(this.currentTokens.refreshToken);
        return this.currentTokens!.accessToken;
      } catch (err: any) {
        // Fallback to client_credentials if refresh fails
        console.warn(`[OAuthTokenManager] Refresh token grant failed (${err.message}), falling back to client_credentials.`);
      }
    }

    // Acquire new token via client_credentials
    await this.acquireWithClientCredentials();
    return this.currentTokens!.accessToken;
  }

  /**
   * Acquires new tokens using grant_type=client_credentials.
   */
  async acquireWithClientCredentials(): Promise<StoredTokens> {
    const bodyParams = new URLSearchParams();
    bodyParams.set("grant_type", "client_credentials");
    bodyParams.set("client_id", this.clientId);
    bodyParams.set("client_secret", this.clientSecret);
    if (this.scope) {
      bodyParams.set("scope", this.scope);
    }

    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: bodyParams.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OAuth token request failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

    this.currentTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: now + expiresIn,
      tokenType: data.token_type || "Bearer",
      scope: data.scope,
    };

    return this.currentTokens;
  }

  /**
   * Refreshes access token using grant_type=refresh_token.
   */
  async refreshWithRefreshToken(refreshToken: string): Promise<StoredTokens> {
    const bodyParams = new URLSearchParams();
    bodyParams.set("grant_type", "refresh_token");
    bodyParams.set("refresh_token", refreshToken);
    bodyParams.set("client_id", this.clientId);
    bodyParams.set("client_secret", this.clientSecret);

    const res = await this.fetchFn(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: bodyParams.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OAuth refresh request failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;

    this.currentTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken, // Keep previous if not rotated
      expiresAt: now + expiresIn,
      tokenType: data.token_type || "Bearer",
      scope: data.scope,
    };

    return this.currentTokens;
  }
}
