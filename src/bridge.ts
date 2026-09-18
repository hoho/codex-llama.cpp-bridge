import type {
  BridgeConfig,
  JsonObject,
  McpToolExclusion,
  McpToolReference,
  ResponsesRequest,
  ResponsesResponse,
  ResponsesTool,
  ToolRegistry,
  ToolRegistryEntry,
} from './types.js';

export interface ToolTransformOptions {
  excludedMcpTools?: McpToolExclusion[] | undefined;
  webSearchTool?: McpToolReference | undefined;
}

export class ResponsesRequestError extends Error {}

function unsupportedToolError(type: unknown): ResponsesRequestError {
  return new ResponsesRequestError(
    type === 'web_search' || type === 'web_search_preview'
      ? 'Hosted web search requires a webSearchTool mapping to an available Codex MCP search tool.'
      : `Unsupported Responses tool type: ${String(type)}`,
  );
}

function stringFromUnknown(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return fallback;
}

export function sanitizeToolName(name: unknown, fallback = 'tool'): string {
  const sanitized = stringFromUnknown(name, fallback).replace(/[^A-Za-z0-9_-]/g, '_');
  return sanitized || fallback;
}

export function namespaceToolName(namespaceName: string, toolName: unknown): string {
  return `${sanitizeToolName(namespaceName, 'namespace')}__${sanitizeToolName(toolName, 'tool')}`;
}

function parseJsonObject(value: unknown): JsonObject {
  if (value != null && typeof value === 'object' && !Array.isArray(value)) return value as JsonObject;
  try {
    const parsed = JSON.parse(stringFromUnknown(value, '{}')) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : {};
  } catch {
    return {};
  }
}

function customToolDescription(tool: ResponsesTool): string {
  const parts = [tool.description ?? 'Call the custom tool.'];
  if (tool.format?.definition) parts.push(`Input must match this ${tool.format.syntax ?? ''} grammar:\n${tool.format.definition}`);
  if (tool.name === 'apply_patch') parts.push('Example input:\n*** Begin Patch\n*** Add File: example.txt\n+hello\n*** End Patch\n');
  return parts.filter(Boolean).join('\n\n');
}

function functionTool(tool: ResponsesTool, fallbackName = 'function'): ResponsesTool {
  return {
    type: 'function',
    name: sanitizeToolName(tool.name, fallbackName),
    description: tool.description ?? '',
    parameters: tool.parameters ?? { type: 'object', properties: {}, additionalProperties: true },
    strict: tool.strict ?? true,
  };
}

function customTool(tool: ResponsesTool): ResponsesTool {
  const description = customToolDescription(tool);
  return functionTool(
    {
      name: sanitizeToolName(tool.name, 'custom_tool'),
      description,
      parameters: {
        type: 'object',
        properties: { input: { type: 'string', description } },
        required: ['input'],
        additionalProperties: false,
      },
      strict: true,
    },
    'custom_tool',
  );
}

function addTool(responseTools: ResponsesTool[], registry: ToolRegistry, tool: ResponsesTool, entry?: ToolRegistryEntry): void {
  const name = stringFromUnknown(tool.name);
  if (responseTools.some((existing) => existing.name === name)) {
    throw new ResponsesRequestError(`Transformed tool name collision: ${name}`);
  }
  responseTools.push(tool);
  if (entry) registry.set(name, entry);
}

function isExcludedMcpTool(namespaceName: string, toolName: unknown, excludedMcpTools: McpToolExclusion[] = []): boolean {
  const sanitizedNamespace = sanitizeToolName(namespaceName, 'namespace');
  const sanitizedTool = sanitizeToolName(toolName, 'tool');
  const fullName = namespaceToolName(sanitizedNamespace, sanitizedTool);
  return excludedMcpTools.some((exclusion) => {
    if (sanitizeToolName(exclusion.namespace, 'namespace') !== sanitizedNamespace) return false;
    return exclusion.tools.some((tool) => {
      const excludedTool = sanitizeToolName(tool, 'tool');
      return excludedTool === sanitizedTool || excludedTool === fullName;
    });
  });
}

function isExcludedFlatMcpTool(toolName: unknown, excludedMcpTools: McpToolExclusion[] = []): boolean {
  const name = sanitizeToolName(toolName, 'function');
  return excludedMcpTools.some((exclusion) => {
    const prefix = `${sanitizeToolName(exclusion.namespace, 'namespace')}__`;
    return name.startsWith(prefix) && isExcludedMcpTool(exclusion.namespace, name.slice(prefix.length), [exclusion]);
  });
}

function validateResponsesTools(value: unknown, location = 'tools', inNamespace = false): void {
  if (!Array.isArray(value)) throw new ResponsesRequestError(`${location} must be an array`);
  const tools: unknown[] = value;
  for (const [index, raw] of tools.entries()) {
    const field = `${location}[${String(index)}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ResponsesRequestError(`${field} must be an object`);
    }
    const tool = raw as JsonObject;
    if (tool.type !== undefined && typeof tool.type !== 'string') {
      throw new ResponsesRequestError(`${field}.type must be a string`);
    }
    const type = tool.type ?? 'function';
    if (tool.description !== undefined && typeof tool.description !== 'string') {
      throw new ResponsesRequestError(`${field}.description must be a string`);
    }
    if (tool.strict !== undefined && tool.strict !== null && typeof tool.strict !== 'boolean') {
      throw new ResponsesRequestError(`${field}.strict must be a boolean or null`);
    }
    if (
      tool.parameters !== undefined &&
      tool.parameters !== null &&
      (typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))
    ) {
      throw new ResponsesRequestError(`${field}.parameters must be an object or null`);
    }
    if (tool.format !== undefined) {
      if (!tool.format || typeof tool.format !== 'object' || Array.isArray(tool.format)) {
        throw new ResponsesRequestError(`${field}.format must be an object`);
      }
      const format = tool.format as JsonObject;
      for (const key of ['type', 'syntax', 'definition']) {
        if (format[key] !== undefined && typeof format[key] !== 'string') {
          throw new ResponsesRequestError(`${field}.format.${key} must be a string`);
        }
      }
    }
    if (inNamespace && type !== 'function' && type !== 'custom') {
      throw new ResponsesRequestError(`Unsupported Responses tool type: ${type}`);
    }
    if (type === 'function' || type === 'custom' || type === 'namespace') {
      if (typeof tool.name !== 'string' || tool.name.trim().length === 0) {
        throw new ResponsesRequestError(`${field}.name must be a non-empty string`);
      }
    }
    if (type === 'namespace') validateResponsesTools(tool.tools, `${field}.tools`, true);
  }
}

export function transformResponsesTools(
  tools: ResponsesTool[] = [],
  options: ToolTransformOptions = {},
): { responseTools: ResponsesTool[]; registry: ToolRegistry; webSearchToolName?: string } {
  validateResponsesTools(tools);
  const responseTools: ResponsesTool[] = [];
  const registry: ToolRegistry = new Map();
  let hostedSearchRequested = false;

  for (const tool of tools) {
    if (tool.type === 'web_search' || tool.type === 'web_search_preview') {
      hostedSearchRequested = true;
      continue;
    }
    if ((tool.type ?? 'function') === 'function') {
      if (isExcludedFlatMcpTool(tool.name, options.excludedMcpTools)) continue;
      const originalName = stringFromUnknown(tool.name) || 'function';
      const converted = functionTool(tool);
      addTool(
        responseTools,
        registry,
        converted,
        converted.name === originalName ? undefined : { kind: 'client_function', name: originalName },
      );
      continue;
    }

    if (tool.type === 'custom') {
      const converted = customTool(tool);
      const originalName = stringFromUnknown(tool.name) || 'custom_tool';
      addTool(responseTools, registry, converted, {
        kind: 'client_custom',
        name: originalName,
      });
      continue;
    }

    if (tool.type === 'namespace') {
      const originalNamespace = stringFromUnknown(tool.name) || 'namespace';
      const namespace = sanitizeToolName(originalNamespace, 'namespace');
      for (const nested of Array.isArray(tool.tools) ? tool.tools : []) {
        if (isExcludedMcpTool(namespace, nested.name, options.excludedMcpTools)) continue;
        const originalToolName = stringFromUnknown(nested.name) || 'tool';
        const name = namespaceToolName(namespace, nested.name);
        const described = { ...nested, description: [tool.description, nested.description].filter(Boolean).join('\n\n') };
        const converted = nested.type === 'custom' ? customTool(described) : functionTool(described);
        addTool(
          responseTools,
          registry,
          { ...converted, name },
          nested.type === 'custom'
            ? { kind: 'client_custom', namespace: originalNamespace, name: originalToolName }
            : { kind: 'mcp', namespace: originalNamespace, tool: originalToolName },
        );
      }
      continue;
    }

    throw unsupportedToolError(tool.type);
  }

  let webSearchToolName: string | undefined;
  if (options.webSearchTool && !isExcludedMcpTool(options.webSearchTool.namespace, options.webSearchTool.tool, options.excludedMcpTools)) {
    const target = options.webSearchTool;
    const flattenedName = namespaceToolName(target.namespace, target.tool);
    webSearchToolName =
      [...registry].find(([, entry]) => entry.kind === 'mcp' && entry.namespace === target.namespace && entry.tool === target.tool)?.[0] ??
      responseTools.find((tool) => tool.name === flattenedName && !registry.has(flattenedName))?.name;
  }
  if (hostedSearchRequested && !webSearchToolName) {
    throw unsupportedToolError('web_search');
  }
  return { responseTools, registry, ...(webSearchToolName ? { webSearchToolName } : {}) };
}

export function responsesInputForUpstream(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const items = input as unknown[];
  return items.map((rawItem) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return rawItem;
    const item = rawItem as JsonObject;
    if (item.type === 'custom_tool_call') {
      return {
        type: 'function_call',
        id: item.id,
        call_id: item.call_id,
        name: item.namespace ? namespaceToolName(stringFromUnknown(item.namespace), item.name) : sanitizeToolName(item.name, 'custom_tool'),
        arguments: JSON.stringify({ input: item.input ?? '' }),
        status: item.status,
      };
    }
    if (item.type === 'custom_tool_call_output') {
      return { ...item, type: 'function_call_output' };
    }
    if (item.type === 'function_call' && item.namespace) {
      const rest = { ...item };
      delete rest.namespace;
      return { ...rest, name: namespaceToolName(stringFromUnknown(item.namespace), item.name) };
    }
    if (item.type === 'function_call') return { ...item, name: sanitizeToolName(item.name, 'function') };
    return item;
  });
}

function toolChoiceForUpstream(
  toolChoice: unknown,
  responseTools: ResponsesTool[],
  registry: ToolRegistry,
  webSearchToolName?: string,
): unknown {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') {
    if (toolChoice === 'required' && responseTools.length === 0) {
      throw new ResponsesRequestError('tool_choice "required" needs an available tool');
    }
    return toolChoice;
  }
  if (!toolChoice || typeof toolChoice !== 'object' || Array.isArray(toolChoice)) {
    throw new ResponsesRequestError('tool_choice must be "auto", "none", "required", or a tool choice object');
  }
  const choice = toolChoice as JsonObject;
  if (choice.type === 'web_search' || choice.type === 'web_search_preview') {
    if (!webSearchToolName || !responseTools.some((tool) => tool.name === webSearchToolName)) throw unsupportedToolError(choice.type);
    return { type: 'function', name: webSearchToolName };
  }
  if (choice.type === 'allowed_tools') {
    if ((choice.mode !== 'auto' && choice.mode !== 'required') || !Array.isArray(choice.tools) || choice.tools.length === 0) {
      throw new ResponsesRequestError('allowed_tools requires mode "auto" or "required" and a non-empty tools array');
    }
    return {
      ...choice,
      tools: choice.tools.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new ResponsesRequestError('allowed_tools entries must be tool choice objects');
        }
        const tool = entry as JsonObject;
        if (tool.type === 'web_search' || tool.type === 'web_search_preview') {
          return toolChoiceForUpstream(tool, responseTools, registry, webSearchToolName);
        }
        if (tool.type !== 'function' && tool.type !== 'custom') throw unsupportedToolError(tool.type);
        if (typeof tool.name !== 'string' || tool.name.length === 0) {
          throw new ResponsesRequestError('allowed_tools entries require a non-empty tool name');
        }
        return toolChoiceForUpstream(tool, responseTools, registry, webSearchToolName);
      }),
    };
  }
  if (choice.type !== 'function' && choice.type !== 'custom') throw unsupportedToolError(choice.type);
  if (typeof choice.name !== 'string' || choice.name.trim().length === 0) {
    throw new ResponsesRequestError('tool_choice requires a non-empty tool name');
  }
  if (choice.namespace !== undefined && (typeof choice.namespace !== 'string' || choice.namespace.trim().length === 0)) {
    throw new ResponsesRequestError('tool_choice.namespace must be a non-empty string');
  }

  const namespace = stringFromUnknown(choice.namespace);
  const transformedName =
    [...registry].find(([, entry]) => {
      if (entry.kind === 'client_function') {
        return choice.type === 'function' && !namespace && entry.name === choice.name;
      }
      if (entry.kind === 'client_custom')
        return choice.type === 'custom' && (entry.namespace ?? '') === namespace && entry.name === choice.name;
      return choice.type === 'function' && entry.namespace === namespace && entry.tool === choice.name;
    })?.[0] ??
    (choice.type === 'function' && !namespace && !registry.has(choice.name) && responseTools.some((tool) => tool.name === choice.name)
      ? choice.name
      : undefined);
  if (!transformedName || !responseTools.some((tool) => tool.name === transformedName)) {
    throw new ResponsesRequestError(`tool_choice references an unavailable tool: ${namespace ? `${namespace}.` : ''}${choice.name}`);
  }
  const transformed: JsonObject = { ...choice, name: transformedName };
  delete transformed.namespace;
  if (choice.type === 'custom') transformed.type = 'function';
  return transformed;
}

export function responsesRequestForUpstream(
  request: ResponsesRequest,
  responseTools: ResponsesTool[],
  stream = false,
  registry: ToolRegistry = new Map(),
  webSearchToolName?: string,
): ResponsesRequest {
  return {
    ...request,
    input: responsesInputForUpstream(request.input),
    ...(request.tool_choice !== undefined
      ? { tool_choice: toolChoiceForUpstream(request.tool_choice, responseTools, registry, webSearchToolName) }
      : {}),
    stream,
    ...(request.tools ? { tools: responseTools } : {}),
  };
}

export function mapUpstreamOutput(output: JsonObject[] = [], registry: ToolRegistry): JsonObject[] {
  const items: unknown[] = output;
  if (!Array.isArray(items) || items.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('Upstream returned invalid Responses output');
  }
  return output.map((item) => {
    if (item.type === 'reasoning' && (!Array.isArray(item.summary) || item.summary.length === 0) && Array.isArray(item.content)) {
      const text = item.content
        .map((part) => (part && typeof part === 'object' ? stringFromUnknown((part as JsonObject).text) : ''))
        .filter(Boolean)
        .join('\n');
      return text ? { ...item, summary: [{ type: 'summary_text', text }] } : item;
    }
    if (item.type !== 'function_call') return item;
    const name = stringFromUnknown(item.name);
    const metadata = registry.get(name);
    if (metadata?.kind === 'client_function') {
      return { ...item, name: metadata.name };
    }
    if (metadata?.kind === 'client_custom') {
      const parsed = parseJsonObject(item.arguments);
      const rest = { ...item };
      delete rest.arguments;
      return {
        ...rest,
        type: 'custom_tool_call',
        name: metadata.name,
        ...(metadata.namespace ? { namespace: metadata.namespace } : {}),
        input: typeof parsed.input === 'string' ? parsed.input : stringFromUnknown(item.arguments),
      };
    }
    if (metadata?.kind === 'mcp') {
      return { ...item, name: metadata.tool, namespace: metadata.namespace };
    }
    return item;
  });
}

function responseOutputText(output: JsonObject[]): string {
  return output
    .filter((item) => item.type === 'message')
    .flatMap((item): unknown[] => (Array.isArray(item.content) ? (item.content as unknown[]) : []))
    .map((part) => (part && typeof part === 'object' ? stringFromUnknown((part as JsonObject).text) : ''))
    .join('');
}

export function mapUpstreamResponse(response: ResponsesResponse, registry: ToolRegistry): ResponsesResponse {
  if (!Array.isArray(response.output)) throw new Error('Upstream returned an invalid Responses object');
  const output = mapUpstreamOutput(response.output, registry);
  return {
    ...response,
    output,
    output_text: typeof response.output_text === 'string' ? response.output_text : responseOutputText(output),
  };
}

function upstreamUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}${path.replace(/^\/+/, '')}`;
  return url;
}

async function upstreamResponses(baseUrl: string, body: ResponsesRequest, signal?: AbortSignal): Promise<ResponsesResponse> {
  const response = await fetch(upstreamUrl(baseUrl, 'responses'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new UpstreamHttpError(response.status, text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Upstream returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { output?: unknown }).output)) {
    throw new Error('Upstream returned an invalid Responses object');
  }
  return parsed as ResponsesResponse;
}

export class UpstreamHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`Upstream ${String(status)}: ${body}`);
  }
}

export async function completeResponses(request: ResponsesRequest, config: BridgeConfig, signal?: AbortSignal): Promise<ResponsesResponse> {
  const { responseTools, registry, webSearchToolName } = transformResponsesTools(request.tools ?? [], {
    excludedMcpTools: config.excludedMcpTools,
    webSearchTool: config.webSearchTool,
  });
  const response = await upstreamResponses(
    config.upstream.baseUrl,
    responsesRequestForUpstream(request, responseTools, false, registry, webSearchToolName),
    signal,
  );
  return mapUpstreamResponse(response, registry);
}
