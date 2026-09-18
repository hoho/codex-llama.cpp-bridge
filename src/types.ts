export type JsonObject = Record<string, unknown>;

export interface BridgeConfig {
  listen: {
    host: string;
    port: number;
  };
  maxRequestBodyBytes?: number;
  upstream: {
    baseUrl: string;
  };
  mcpProxy?: {
    baseUrl: string;
  };
  excludedMcpTools?: McpToolExclusion[];
  webSearchTool?: McpToolReference;
}

export interface McpToolReference {
  namespace: string;
  tool: string;
}

export interface McpToolExclusion {
  namespace: string;
  tools: string[];
}

export interface ResponsesTool extends JsonObject {
  type?: string;
  name?: string;
  description?: string;
  strict?: boolean;
  parameters?: JsonObject;
  tools?: ResponsesTool[];
  format?: {
    type?: string;
    syntax?: string;
    definition?: string;
  };
}

export interface ResponsesRequest extends JsonObject {
  model: string;
  input?: unknown;
  tools?: ResponsesTool[];
  stream?: boolean;
}

export interface ResponsesResponse extends JsonObject {
  id: string;
  object: string;
  model: string;
  status: string;
  output: JsonObject[];
}

export type ToolRegistryEntry =
  | { kind: 'client_function'; name: string }
  | { kind: 'client_custom'; name: string; namespace?: string }
  | { kind: 'mcp'; namespace: string; tool: string };

export type ToolRegistry = Map<string, ToolRegistryEntry>;
