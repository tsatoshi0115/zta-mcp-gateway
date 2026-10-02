import express, { Request, Response, NextFunction } from "express";
import path from "node:path";
import jwt from "jsonwebtoken";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, findUpstreamByPath } from "./config.js";
import { verifyToken, extractBearerToken } from "./auth/jwt.js";
import { resolveClients, issueTokens, refreshTokens } from "./auth/oauth.js";
import { maskTools, isToolCallAllowed } from "./pep/masking.js";
import { validateSqlQuery } from "./pep/firewall.js";
import { defaultAuditLogger } from "./audit/logger.js";
import { CatalogProvider } from "./catalog/index.js";
import { AuthContext, GatewayConfig, McpRequest, ToolDefinition } from "./types/index.js";

// Extend Express Request with authenticated AuthContext
declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

const CONFIG_PATH = process.env.GATEWAY_CONFIG_PATH || path.resolve("config/gateway-config.example.yaml");
let config: GatewayConfig;
let catalogProvider: CatalogProvider;

try {
  config = loadConfig(CONFIG_PATH);
  catalogProvider = new CatalogProvider(config.catalog?.definitions_file);
  defaultAuditLogger.log({
    event_type: "CONFIG_LOADED",
    decision: "INFO",
    details: { configPath: CONFIG_PATH, upstreamCount: config.upstreams.length },
  });
} catch (err: any) {
  console.error(`Failed to load gateway configuration: ${err.message}`);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS configuration
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

// Health check endpoint
app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "healthy", version: config.version, timestamp: new Date().toISOString() });
});

// ==============================================================================
// OAuth 2.1 Token Endpoint (Client Credentials & Refresh Token Grants)
// ==============================================================================
app.post("/oauth/token", (req: Request, res: Response) => {
  const grantType = req.body.grant_type || req.query.grant_type;
  let clientId = req.body.client_id || req.query.client_id;
  let clientSecret = req.body.client_secret || req.query.client_secret;

  // Check Basic Auth header if present
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    try {
      const b64 = authHeader.split(" ")[1];
      const [u, p] = Buffer.from(b64, "base64").toString().split(":");
      if (u) clientId = u;
      if (p) clientSecret = p;
    } catch (_) {}
  }

  // 1. Client Credentials Grant
  if (grantType === "client_credentials") {
    const clients = resolveClients(config);
    const matchedClient = clients.find(
      (c) => c.client_id === clientId && c.client_secret === clientSecret
    );

    if (!matchedClient) {
      defaultAuditLogger.log({
        event_type: "AUTH_FAILED",
        decision: "DENY",
        reason: `Invalid client credentials for clientId: ${clientId}`,
        details: { ip: req.ip },
      });
      res.status(401).json({ error: "invalid_client", error_description: "Client authentication failed" });
      return;
    }

    const scope = (req.body.scope || req.query.scope) as string | undefined;
    const tokenResponse = issueTokens(matchedClient, config, { scope });

    defaultAuditLogger.log({
      event_type: "ACCESS_ALLOWED",
      client_id: matchedClient.client_id,
      roles: matchedClient.roles,
      decision: "ALLOW",
      details: { grant_type: "client_credentials" },
    });

    res.json(tokenResponse);
    return;
  }

  // 2. Refresh Token Grant
  if (grantType === "refresh_token") {
    const refreshToken = (req.body.refresh_token || req.query.refresh_token) as string | undefined;

    if (!refreshToken) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing required 'refresh_token' parameter" });
      return;
    }

    try {
      const tokenResponse = refreshTokens(refreshToken, clientId, clientSecret, config);

      defaultAuditLogger.log({
        event_type: "ACCESS_ALLOWED",
        client_id: clientId,
        decision: "ALLOW",
        details: { grant_type: "refresh_token" },
      });

      res.json(tokenResponse);
      return;
    } catch (err: any) {
      const isClientErr = err.message.includes("invalid_client");
      const status = isClientErr ? 401 : 400;
      const errorCode = isClientErr ? "invalid_client" : "invalid_grant";

      defaultAuditLogger.log({
        event_type: "AUTH_FAILED",
        decision: "DENY",
        reason: `Token refresh failed: ${err.message}`,
        details: { ip: req.ip, clientId },
      });

      res.status(status).json({ error: errorCode, error_description: err.message });
      return;
    }
  }

  // Unsupported grant
  res.status(400).json({ error: "unsupported_grant_type", error_description: `Grant type '${grantType}' is not supported.` });
});

// State for active SSE transports
const sseTransports = new Map<string, SSEServerTransport>();

// Helper to authenticate request via Bearer header or access_token query param
function authenticate(req: Request): AuthContext | null {
  const authHeader = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  let token = extractBearerToken(authHeader);
  if (!token && typeof req.query.access_token === "string") {
    token = req.query.access_token;
  }
  if (!token && typeof req.query.token === "string") {
    token = req.query.token;
  }
  if (!token) return null;

  try {
    return verifyToken(token, config);
  } catch (e) {
    return null;
  }
}

// ==============================================================================
// SSE Transport Endpoints (GET /mcp/:upstreamId/sse & POST /mcp/:upstreamId/message)
// ==============================================================================

app.get("/mcp/:upstreamId/sse", async (req: Request, res: Response) => {
  const authContext = authenticate(req);
  if (!authContext) {
    res.status(401).json({ error: "Unauthorized: Missing or invalid Bearer token" });
    return;
  }

  const upstreamId = String(req.params.upstreamId);
  const upstream = config.upstreams.find((u) => u.id === upstreamId || u.path.endsWith(upstreamId));

  if (!upstream) {
    res.status(404).json({ error: `Upstream MCP server not found for: ${upstreamId}` });
    return;
  }

  console.log(`[ZTA Gateway SSE] Client ${authContext.clientId} (roles: [${authContext.roles.join(", ")}]) connected to ${upstream.id}`);

  const messagePostEndpoint = `/mcp/${upstreamId}/message`;
  const transport = new SSEServerTransport(messagePostEndpoint, res);
  const sessionId = transport.sessionId;
  sseTransports.set(sessionId, transport);

  // Send SSE keepalive comments every 15s to prevent idle timeout
  const keepAliveTimer = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(keepAliveTimer);
    }
  }, 15000);

  // Create isolated MCP Server session for this client
  const mcpServer = new Server(
    { name: `zta-gateway-${upstream.id}`, version: config.version },
    { capabilities: { tools: {} } }
  );

  // 1. Context Masking PEP for tools/list
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      let rawTools: ToolDefinition[] = [];

      if (upstream.id === "catalog" || upstream.target.startsWith("internal://catalog")) {
        rawTools = catalogProvider.getToolDefinitions();
      } else {
        const upstreamRes = await fetch(upstream.target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
        });
        const data = (await upstreamRes.json()) as any;
        rawTools = (data.result?.tools || []) as ToolDefinition[];
      }

      const maskedTools = maskTools(rawTools, authContext.roles, upstream);

      defaultAuditLogger.log({
        event_type: "ACCESS_ALLOWED",
        client_id: authContext.clientId,
        roles: authContext.roles,
        upstream_id: upstream.id,
        method: "tools/list",
        decision: "ALLOW",
        details: { rawCount: rawTools.length, maskedCount: maskedTools.length },
      });

      return { tools: maskedTools };
    } catch (err: any) {
      console.error(`[ZTA Gateway] Failed to list tools from upstream:`, err.message);
      return { tools: [] };
    }
  });

  // 2. Query Firewall PEP for tools/call
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Check Tool Permission (RBAC)
    if (!isToolCallAllowed(name, authContext.roles, upstream)) {
      defaultAuditLogger.log({
        event_type: "ACCESS_BLOCKED",
        client_id: authContext.clientId,
        roles: authContext.roles,
        upstream_id: upstream.id,
        method: "tools/call",
        tool_name: name,
        decision: "DENY",
        reason: `Tool '${name}' is not permitted by ZTA policy.`,
      });
      throw new Error(`Execution denied: Tool '${name}' is not permitted by ZTA policy.`);
    }

    // Handle Built-in Meta-Catalog Tools
    if (upstream.id === "catalog" || upstream.target.startsWith("internal://catalog")) {
      console.log(`[ZTA Catalog Tool] 📚 Executing Catalog Tool '${name}' | Client: ${authContext.clientId}`);
      let contentResult: any;

      if (name === "list_catalog") {
        const catalogList = catalogProvider.listCatalog(authContext.roles);
        contentResult = { content: [{ type: "text", text: JSON.stringify(catalogList, null, 2) }] };
      } else if (name === "get_catalog_detail") {
        const serviceId = String(args?.service_id || "");
        if (!serviceId) {
          throw new Error("Missing required argument: 'service_id'");
        }
        const detail = catalogProvider.getCatalogDetail(serviceId, authContext.roles);
        contentResult = { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] };
      } else {
        throw new Error(`Unknown catalog tool '${name}'`);
      }

      defaultAuditLogger.log({
        event_type: "TOOL_EXECUTION",
        client_id: authContext.clientId,
        roles: authContext.roles,
        upstream_id: upstream.id,
        method: "tools/call",
        tool_name: name,
        decision: "ALLOW",
        details: { args },
      });

      return contentResult;
    }

    // Query Firewall: check SQL argument
    const queryArg = args?.query || args?.sql;
    if (typeof queryArg === "string") {
      console.log(`[ZTA PEP Query] 🔍 Executing Tool '${name}' | Client: ${authContext.clientId} | SQL:\n${queryArg}`);
    } else {
      console.log(`[ZTA PEP Tool] ⚙️ Executing Tool '${name}' | Client: ${authContext.clientId}`);
    }

    if (typeof queryArg === "string" && upstream.policies.firewall?.enforce_sql_check) {
      const firewallDecision = validateSqlQuery(queryArg, upstream.policies.firewall, authContext.roles);

      if (!firewallDecision.allowed) {
        console.warn(`[ZTA PEP Firewall] 🚨 Blocked query: ${firewallDecision.reason}`);
        defaultAuditLogger.log({
          event_type: "FIREWALL_VIOLATION",
          client_id: authContext.clientId,
          roles: authContext.roles,
          upstream_id: upstream.id,
          method: "tools/call",
          tool_name: name,
          decision: "DENY",
          reason: firewallDecision.reason,
          details: {
            ruleViolated: firewallDecision.ruleViolated,
            querySnippet: queryArg.substring(0, 100),
          },
        });
        throw new Error(firewallDecision.reason || "Query blocked by ZTA SQL Firewall.");
      }
    }

    // Forward to upstream target
    const upstreamRes = await fetch(upstream.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name, arguments: args },
        id: Date.now(),
      }),
    });

    const data = (await upstreamRes.json()) as any;
    if (data.error) {
      throw new Error(data.error.message || "Upstream execution error");
    }

    // Log successful tool execution in ZTA audit logger
    defaultAuditLogger.log({
      event_type: "TOOL_EXECUTION",
      client_id: authContext.clientId,
      roles: authContext.roles,
      upstream_id: upstream.id,
      method: "tools/call",
      tool_name: name,
      decision: "ALLOW",
      details: {
        sqlQuery: typeof queryArg === "string" ? queryArg : undefined,
        args: typeof queryArg === "string" ? undefined : args,
      },
    });

    return data.result || { content: [] };
  });

  await mcpServer.connect(transport);

  res.on("close", () => {
    clearInterval(keepAliveTimer);
    sseTransports.delete(sessionId);
    console.log(`[ZTA Gateway SSE] Session ${sessionId} closed`);
  });
});

app.post("/mcp/:upstreamId/message", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    res.status(400).json({ error: "Missing sessionId query parameter" });
    return;
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    res.status(400).json({ error: "SSE session not found or expired" });
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
});

// Legacy direct JSON-RPC POST route
app.post("/mcp/*", async (req: Request, res: Response) => {
  const authContext = authenticate(req);
  if (!authContext) {
    res.status(401).json({ error: "Unauthorized: Missing Bearer Token" });
    return;
  }

  const upstream = findUpstreamByPath(config, req.path);
  if (!upstream) {
    res.status(404).json({ error: `No upstream MCP server configured for path: ${req.path}` });
    return;
  }

  const mcpReq = req.body as McpRequest;

  if (mcpReq.method === "tools/list") {
    try {
      let rawTools: ToolDefinition[] = [];
      if (upstream.id === "catalog" || upstream.target.startsWith("internal://catalog")) {
        rawTools = catalogProvider.getToolDefinitions();
      } else {
        const response = await fetch(upstream.target, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mcpReq),
        });
        const data = (await response.json()) as any;
        rawTools = (data.result?.tools || []) as ToolDefinition[];
      }
      const maskedTools = maskTools(rawTools, authContext.roles, upstream);
      res.status(200).json({
        jsonrpc: "2.0",
        id: mcpReq.id,
        result: { tools: maskedTools },
      });
      return;
    } catch (err: any) {
      res.status(502).json({ error: err.message });
      return;
    }
  }

  if (mcpReq.method === "tools/call" && mcpReq.params?.name) {
    const toolName = mcpReq.params.name;
    if (!isToolCallAllowed(toolName, authContext.roles, upstream)) {
      res.status(403).json({
        jsonrpc: "2.0",
        id: mcpReq.id,
        error: { code: -32600, message: `Execution denied: Tool '${toolName}' is not permitted by ZTA policy.` },
      });
      return;
    }

    const args = mcpReq.params.arguments;

    if (upstream.id === "catalog" || upstream.target.startsWith("internal://catalog")) {
      try {
        if (toolName === "list_catalog") {
          const catalogList = catalogProvider.listCatalog(authContext.roles);
          res.status(200).json({
            jsonrpc: "2.0",
            id: mcpReq.id,
            result: { content: [{ type: "text", text: JSON.stringify(catalogList, null, 2) }] },
          });
          return;
        } else if (toolName === "get_catalog_detail") {
          const serviceId = String(args?.service_id || "");
          const detail = catalogProvider.getCatalogDetail(serviceId, authContext.roles);
          res.status(200).json({
            jsonrpc: "2.0",
            id: mcpReq.id,
            result: { content: [{ type: "text", text: JSON.stringify(detail, null, 2) }] },
          });
          return;
        }
      } catch (err: any) {
        res.status(400).json({
          jsonrpc: "2.0",
          id: mcpReq.id,
          error: { code: -32603, message: err.message },
        });
        return;
      }
    }

    const queryArg = args?.query || args?.sql;
    if (typeof queryArg === "string" && upstream.policies.firewall?.enforce_sql_check) {
      const firewallDecision = validateSqlQuery(queryArg, upstream.policies.firewall, authContext.roles);
      if (!firewallDecision.allowed) {
        res.status(403).json({
          jsonrpc: "2.0",
          id: mcpReq.id,
          error: { code: -32600, message: `Execution denied: ${firewallDecision.reason}` },
        });
        return;
      }
    }
  }

  // Forward
  try {
    const response = await fetch(upstream.target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mcpReq),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (err: any) {
    res.status(502).json({ error: err.message });
  }
});

const PORT = config.server.port || 8080;
const HOST = config.server.host || "0.0.0.0";

const isTestMode =
  process.env.NODE_ENV === "test" ||
  process.argv.some((arg) => arg.includes("--test") || arg.includes("test"));

if (!isTestMode) {
  app.listen(PORT, HOST, () => {
    console.log(`[ZTA MCP Gateway] Server running at http://${HOST}:${PORT}`);
    console.log(`[ZTA MCP Gateway] Loaded ${config.upstreams.length} upstream(s)`);
  });
}

export { app };
