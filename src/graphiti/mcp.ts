import type { GraphitiPluginConfig } from "./types.js";

interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

interface JsonRpcError {
  code?: number;
  message?: string;
  data?: unknown;
}

interface JsonRpcResponse {
  result?: unknown;
  error?: JsonRpcError;
}

interface McpToolDescriptor {
  name?: string;
  description?: string;
  inputSchema?: unknown;
}

export class GraphitiMcpClient {
  private endpoint: string | null = null;
  private toolCache: McpToolDescriptor[] = [];

  constructor(
    private readonly config: Pick<GraphitiPluginConfig, "baseUrl" | "timeoutMs" | "transport">,
    private readonly logger?: LoggerLike,
  ) {}

  async discoverTools(forceRefresh = false): Promise<McpToolDescriptor[]> {
    if (!forceRefresh && this.toolCache.length > 0) {
      return this.toolCache;
    }

    const result = (await this.callMcp("tools/list", undefined, true)) as Record<string, unknown>;
    const tools = Array.isArray(result.tools) ? (result.tools as McpToolDescriptor[]) : [];
    this.toolCache = tools;
    return this.toolCache;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.callMcp("tools/call", { name, arguments: args }, false);
  }

  private async callMcp(
    method: string,
    params: Record<string, unknown> | undefined,
    allowEndpointProbe: boolean,
  ): Promise<unknown> {
    const endpoint = await this.resolveEndpoint(allowEndpointProbe);
    const payload = {
      jsonrpc: "2.0",
      id: `graphiti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      params,
    };

    const response = await this.postJsonRpc(endpoint, payload, this.config.timeoutMs);
    if (response.error) {
      throw new Error(
        `Graphiti MCP ${method} failed: ${response.error.message || "unknown_error"} (code=${String(response.error.code ?? "n/a")})`,
      );
    }
    return response.result;
  }

  private async resolveEndpoint(allowProbe: boolean): Promise<string> {
    if (!allowProbe && this.endpoint) {
      return this.endpoint;
    }

    const candidates = this.endpointCandidates();
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const response = await this.postJsonRpc(
          candidate,
          {
            jsonrpc: "2.0",
            id: `graphiti-probe-${Date.now()}`,
            method: "tools/list",
            params: {},
          },
          this.config.timeoutMs,
        );
        if (response.error) {
          throw new Error(response.error.message || "tools/list returned error");
        }
        this.endpoint = candidate;
        this.logger?.debug?.(`memory-lancedb-pro: graphiti endpoint selected: ${candidate}`);
        return candidate;
      } catch (err) {
        lastError = err;
      }
    }

    throw new Error(
      `Graphiti MCP endpoint unavailable under ${this.config.baseUrl}. Last error: ${String(lastError)}`,
    );
  }

  private endpointCandidates(): string[] {
    const normalized = this.config.baseUrl.replace(/\/+$/, "");
    if (this.config.transport === "mcp") {
      return [`${normalized}/mcp`, `${normalized}/mcp/`];
    }
    return [`${normalized}/mcp`, `${normalized}/mcp/`];
  }

  private async postJsonRpc(
    url: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as JsonRpcResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}
