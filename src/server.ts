import { once } from 'node:events';
import { setDefaultResultOrder } from 'node:dns';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import {
  completeResponses,
  mapUpstreamOutput,
  mapUpstreamResponse,
  ResponsesRequestError,
  responsesRequestForUpstream,
  transformResponsesTools,
  UpstreamHttpError,
} from './bridge.js';
import type { BridgeConfig, JsonObject, McpToolExclusion, ResponsesRequest, ResponsesResponse, ToolRegistry } from './types.js';

setDefaultResultOrder('ipv4first');

const DEFAULT_MAX_REQUEST_BODY_BYTES = 16 * 1024 * 1024;

const DEFAULT_CONFIG: BridgeConfig = {
  listen: { host: '127.0.0.1', port: 10901 },
  maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
  upstream: { baseUrl: 'http://qwen.local:5656/v1' },
};

function isJsonObject(value: unknown): value is JsonObject {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function upstreamUrl(baseUrl: string, path: string): URL {
  const url = new URL(baseUrl);
  const prefix = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
  url.pathname = `${prefix}${path.replace(/^\/+/, '')}`;
  return url;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function bodyLimitMessage(maxBytes: number): string {
  return `request body exceeds the configured limit of ${String(maxBytes)} bytes`;
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<JsonObject> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readBody(req, maxBytes)).toString('utf8') || '{}') as unknown;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'request body must contain valid JSON');
  }
  if (!isJsonObject(parsed)) throw new HttpError(400, 'request body must be a JSON object');
  return parsed;
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const contentLength = req.headers['content-length'];
  if (typeof contentLength === 'string') {
    const declaredLength = Number(contentLength);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      req.resume();
      throw new HttpError(413, bodyLimitMessage(maxBytes));
    }
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) {
      req.resume();
      throw new HttpError(413, bodyLimitMessage(maxBytes));
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function normalizeExcludedMcpTools(value: unknown): McpToolExclusion[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) throw new Error('excludedMcpTools must be an array');
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`excludedMcpTools[${String(index)}] must be an object`);
    }
    const item = entry as JsonObject;
    if (typeof item.namespace !== 'string' || item.namespace.length === 0) {
      throw new Error(`excludedMcpTools[${String(index)}].namespace must be a non-empty string`);
    }
    const tools = item.tools;
    if (!Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === 'string' && tool.length > 0)) {
      throw new Error(`excludedMcpTools[${String(index)}].tools must be a non-empty string array`);
    }
    return { namespace: item.namespace, tools: tools.map((tool) => String(tool)) };
  });
}

export async function loadConfig(path?: string): Promise<BridgeConfig> {
  const parsed: unknown = path ? JSON.parse(await readFile(path, 'utf8')) : {};
  if (!isJsonObject(parsed)) throw new Error('config must be a JSON object');
  const raw = parsed;
  if (raw.listen !== undefined && !isJsonObject(raw.listen)) throw new Error('listen must be an object');
  const listen = raw.listen ?? {};
  const rawHost = listen.host ?? DEFAULT_CONFIG.listen.host;
  const port = listen.port ?? DEFAULT_CONFIG.listen.port;
  if (typeof rawHost !== 'string' || rawHost.trim().length === 0) throw new Error('listen.host must be a non-empty string');
  const host = rawHost.trim();
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('listen.port must be an integer from 0 through 65535');
  }
  const maxRequestBodyBytes = raw.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (typeof maxRequestBodyBytes !== 'number' || !Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new Error('maxRequestBodyBytes must be a positive safe integer');
  }

  let upstreamValue: unknown = DEFAULT_CONFIG.upstream.baseUrl;
  if (raw.upstream !== undefined) {
    if (typeof raw.upstream === 'string') upstreamValue = raw.upstream;
    else if (isJsonObject(raw.upstream)) {
      if (!Object.hasOwn(raw.upstream, 'baseUrl')) throw new Error('upstream.baseUrl is required');
      upstreamValue = raw.upstream.baseUrl;
    } else {
      throw new Error('upstream must be a URL string or an object with baseUrl');
    }
  }
  const upstream = normalizeBaseUrl(upstreamValue, 'upstream');

  let mcpProxyValue: unknown;
  if (raw.mcpProxy != null) {
    if (typeof raw.mcpProxy === 'string') mcpProxyValue = raw.mcpProxy;
    else if (isJsonObject(raw.mcpProxy)) {
      if (!Object.hasOwn(raw.mcpProxy, 'baseUrl')) throw new Error('mcpProxy.baseUrl is required');
      mcpProxyValue = raw.mcpProxy.baseUrl;
    } else {
      throw new Error('mcpProxy must be a URL string or an object with baseUrl');
    }
  }
  const mcpProxy = mcpProxyValue == null ? undefined : normalizeBaseUrl(mcpProxyValue, 'mcpProxy');
  const excludedMcpTools = normalizeExcludedMcpTools(raw.excludedMcpTools);
  let webSearchTool: BridgeConfig['webSearchTool'];
  if (raw.webSearchTool !== undefined) {
    if (
      !isJsonObject(raw.webSearchTool) ||
      typeof raw.webSearchTool.namespace !== 'string' ||
      raw.webSearchTool.namespace.trim().length === 0 ||
      typeof raw.webSearchTool.tool !== 'string' ||
      raw.webSearchTool.tool.trim().length === 0
    ) {
      throw new Error('webSearchTool must contain non-empty namespace and tool strings');
    }
    webSearchTool = { namespace: raw.webSearchTool.namespace, tool: raw.webSearchTool.tool };
  }
  return {
    listen: { host, port },
    maxRequestBodyBytes,
    upstream: { baseUrl: upstream },
    ...(mcpProxy ? { mcpProxy: { baseUrl: mcpProxy } } : {}),
    ...(excludedMcpTools ? { excludedMcpTools } : {}),
    ...(webSearchTool ? { webSearchTool } : {}),
  };
}

function normalizeBaseUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a non-empty URL string`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`${field} must use http or https`);
  if (url.username || url.password) throw new Error(`${field} must not include credentials`);
  if (url.search || url.hash) throw new Error(`${field} must not include a query string or fragment`);
  return url.href.replace(/\/$/, '');
}

function writeJson(res: ServerResponse, status: number, value: unknown): void {
  const payload = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hopByHopHeaders(connection: string): Set<string> {
  return new Set([
    'connection',
    'keep-alive',
    'proxy-connection',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...connection
      .toLowerCase()
      .split(',')
      .map((name) => name.trim()),
  ]);
}

function requestHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  const excluded = hopByHopHeaders(req.headers.connection ?? '');
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || name === 'host' || name === 'content-length' || excluded.has(name) || name === 'accept-encoding') {
      continue;
    }
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

function responseHeaders(response: Response): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  const excluded = hopByHopHeaders(response.headers.get('connection') ?? '');
  for (const [name, value] of response.headers) {
    if (name === 'content-length' || name === 'content-encoding' || excluded.has(name)) {
      continue;
    }
    headers[name] = name === 'set-cookie' ? response.headers.getSetCookie() : value;
  }
  return headers;
}

async function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  if (res.destroyed) return;
  const controller = new AbortController();
  try {
    await Promise.race([once(res, 'drain', { signal: controller.signal }), once(res, 'close', { signal: controller.signal })]);
  } finally {
    controller.abort();
  }
}

async function writeUpstreamResponse(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, responseHeaders(response));
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  for (;;) {
    const result = await (reader.read() as Promise<{ done: boolean; value?: Uint8Array }>);
    if (result.done) break;
    if (result.value && !res.write(result.value)) await waitForDrainOrClose(res);
  }
  res.end();
}

async function proxyMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  baseUrl: string,
  serverName: string,
  search: string,
  maxRequestBodyBytes: number,
): Promise<void> {
  const method = req.method ?? 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(req, maxRequestBodyBytes);
  const controller = new AbortController();
  const abortUpstream = (): void => {
    controller.abort();
  };
  res.once('close', abortUpstream);
  try {
    const target = upstreamUrl(baseUrl, `${serverName}/mcp`);
    target.search = search;
    const response = await fetch(target, {
      method,
      headers: requestHeaders(req),
      ...(body && body.length > 0 ? { body } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    await writeUpstreamResponse(res, response);
  } finally {
    res.off('close', abortUpstream);
  }
}

function writeSseEvent(res: ServerResponse, event: string, data: JsonObject): boolean {
  return res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function eventItem(data: JsonObject): JsonObject | undefined {
  return isJsonObject(data.item) ? data.item : undefined;
}

function mappedEventItem(data: JsonObject, registry: ToolRegistry): JsonObject {
  const item = eventItem(data);
  return item ? { ...data, item: mapUpstreamOutput([item], registry)[0] ?? item } : data;
}

function mappedResponseEvent(data: JsonObject, registry: ToolRegistry): JsonObject {
  const response = data.response;
  if (!isJsonObject(response) || !Array.isArray(response.output)) return data;
  return { ...data, response: mapUpstreamResponse(response as unknown as ResponsesResponse, registry) };
}

interface CustomCallState {
  ids: Set<string>;
  indexes: Set<number>;
  callIds: Set<string>;
}

type AssistantMessagePhase = 'commentary' | 'final_answer';

interface BufferedMessageEvent {
  event: string;
  data: JsonObject;
}

function withAssistantMessagePhase(data: JsonObject, phase: AssistantMessagePhase, phases: Map<string, AssistantMessagePhase>): JsonObject {
  const mapItem = (item: JsonObject): JsonObject =>
    item.type === 'message' && item.phase == null ? { ...item, phase: phases.get(String(item.id)) ?? phase } : item;
  let mapped = data;
  if (isJsonObject(mapped.item)) mapped = { ...mapped, item: mapItem(mapped.item) };
  if (!isJsonObject(mapped.response) || !Array.isArray(mapped.response.output)) return mapped;

  const responseOutput = mapped.response.output as unknown[];
  const output = responseOutput.map((item) => (isJsonObject(item) ? mapItem(item) : item));
  return { ...mapped, response: { ...mapped.response, output } };
}

function rememberCustomCall(data: JsonObject, item: JsonObject, state: CustomCallState): void {
  if (typeof item.id === 'string') state.ids.add(item.id);
  if (typeof item.call_id === 'string') state.callIds.add(item.call_id);
  if (typeof data.output_index === 'number') state.indexes.add(data.output_index);
}

function isCustomCallEvent(data: JsonObject, state: CustomCallState): boolean {
  return (
    (typeof data.item_id === 'string' && state.ids.has(data.item_id)) ||
    (typeof data.call_id === 'string' && state.callIds.has(data.call_id)) ||
    (typeof data.output_index === 'number' && state.indexes.has(data.output_index))
  );
}

function forgetCustomCall(data: JsonObject, item: JsonObject, state: CustomCallState): void {
  if (typeof item.id === 'string') state.ids.delete(item.id);
  if (typeof item.call_id === 'string') state.callIds.delete(item.call_id);
  if (typeof data.output_index === 'number') state.indexes.delete(data.output_index);
}

function transformStreamEvent(
  event: string,
  data: JsonObject,
  registry: ToolRegistry,
  customCalls: CustomCallState,
): { event: string; data: JsonObject }[] {
  if (event === 'response.output_item.added') {
    const item = eventItem(data);
    if (item?.type === 'function_call' && registry.get(String(item.name))?.kind === 'client_custom') {
      rememberCustomCall(data, item, customCalls);
      return [];
    }
    return [{ event, data: mappedEventItem(data, registry) }];
  }

  if (event.startsWith('response.function_call_arguments.') && isCustomCallEvent(data, customCalls)) return [];

  if (event === 'response.output_item.done') {
    const item = eventItem(data);
    if (item && isCustomCallEvent(data, customCalls)) {
      const mapped = mappedEventItem(data, registry);
      forgetCustomCall(data, item, customCalls);
      return [
        { event: 'response.output_item.added', data: { ...mapped, type: 'response.output_item.added' } },
        { event, data: mapped },
      ];
    }
    return [{ event, data: mappedEventItem(data, registry) }];
  }

  if (
    event === 'response.completed' ||
    event === 'response.failed' ||
    event === 'response.incomplete' ||
    event === 'response.in_progress' ||
    event === 'response.created'
  ) {
    return [{ event, data: mappedResponseEvent(data, registry) }];
  }

  return [{ event, data }];
}

function parseSseBlock(block: string): { event: string; dataText: string } | undefined {
  let event = '';
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trimStart();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, dataText: dataLines.join('\n') };
}

async function streamResponsesNative(res: ServerResponse, body: ResponsesRequest, config: BridgeConfig): Promise<void> {
  const { responseTools, registry, webSearchToolName } = transformResponsesTools(body.tools ?? [], {
    excludedMcpTools: config.excludedMcpTools,
    webSearchTool: config.webSearchTool,
  });
  const upstreamBody = responsesRequestForUpstream(body, responseTools, true, registry, webSearchToolName);
  const customCalls: CustomCallState = { ids: new Set(), indexes: new Set(), callIds: new Set() };
  let bufferedMessageEvents: BufferedMessageEvent[] | undefined;
  const inferredMessagePhases = new Map<string, AssistantMessagePhase>();
  const openMessages = new Set<string>();
  let bufferedToolSeen = false;
  let sequenceNumber = 0;
  let terminalEventSeen = false;
  let flushBufferedMessageOnFailure: (() => void) | undefined;
  let waitForDownstreamOnFailure: (() => Promise<void>) | undefined;

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  const upstreamAbort = new AbortController();
  const abortUpstream = (): void => {
    upstreamAbort.abort();
  };
  res.once('close', abortUpstream);

  try {
    const upstream = await fetch(upstreamUrl(config.upstream.baseUrl, 'responses'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(upstreamBody),
      signal: upstreamAbort.signal,
    });
    if (!upstream.ok) throw new Error(`Upstream ${String(upstream.status)}: ${await upstream.text()}`);
    if (!upstream.body) throw new Error('Upstream returned no response stream');
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      throw new Error(`Upstream streaming response must use text/event-stream, received ${contentType || 'no content type'}`);
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let pending = '';
    let previousCarriageReturn = false;
    let downstreamBackpressured = false;
    const emitEvent = (event: string, data: JsonObject): void => {
      for (const transformed of transformStreamEvent(event, data, registry, customCalls)) {
        transformed.data.sequence_number = sequenceNumber++;
        if (!writeSseEvent(res, transformed.event, transformed.data)) downstreamBackpressured = true;
      }
    };
    const waitForDownstream = async (): Promise<void> => {
      if (!downstreamBackpressured) return;
      downstreamBackpressured = false;
      await waitForDrainOrClose(res);
    };
    const emitBufferedMessage = (phase: AssistantMessagePhase): void => {
      if (!bufferedMessageEvents) return;
      // Codex needs a message's authoritative completion before the next tool starts.
      // Group interleaved item events by their original start order, never synthesize completion.
      if (bufferedToolSeen) {
        const order = new Map<string | number, number>();
        for (const buffered of bufferedMessageEvents) {
          const id = eventItem(buffered.data)?.id ?? buffered.data.item_id;
          const index = buffered.data.output_index;
          const rank =
            (typeof id === 'string' ? order.get(id) : undefined) ??
            (typeof index === 'number' ? order.get(index) : undefined) ??
            order.size;
          if (typeof id === 'string') order.set(id, rank);
          if (typeof index === 'number') order.set(index, rank);
        }
        const eventOrder = (buffered: BufferedMessageEvent): number => {
          const id = eventItem(buffered.data)?.id ?? buffered.data.item_id;
          const index = buffered.data.output_index;
          return (typeof id === 'string' ? order.get(id) : undefined) ?? (typeof index === 'number' ? order.get(index) : undefined) ?? -1;
        };
        bufferedMessageEvents.sort((a, b) => eventOrder(a) - eventOrder(b));
      }
      for (const buffered of bufferedMessageEvents) {
        const item = eventItem(buffered.data);
        if (item?.type === 'message' && typeof item.id === 'string' && !inferredMessagePhases.has(item.id)) {
          inferredMessagePhases.set(item.id, phase);
        }
        emitEvent(buffered.event, withAssistantMessagePhase(buffered.data, phase, inferredMessagePhases));
      }
      bufferedMessageEvents = undefined;
      bufferedToolSeen = false;
    };
    flushBufferedMessageOnFailure = () => {
      emitBufferedMessage(bufferedToolSeen ? 'commentary' : 'final_answer');
    };
    waitForDownstreamOnFailure = waitForDownstream;
    const emitBlock = (block: string): boolean => {
      const parsed = parseSseBlock(block);
      if (!parsed) return false;
      if (parsed.dataText === '[DONE]') {
        if (terminalEventSeen && !res.write('data: [DONE]\n\n')) downstreamBackpressured = true;
        return false;
      }
      if (terminalEventSeen) return false;
      let data: unknown;
      try {
        data = JSON.parse(parsed.dataText);
      } catch {
        throw new Error('Upstream returned invalid JSON in an SSE event');
      }
      if (!isJsonObject(data)) throw new Error('Upstream returned non-object JSON in an SSE event');
      const event = parsed.event || (typeof data.type === 'string' ? data.type : '');
      if (!event || (data.type !== undefined && data.type !== event)) {
        throw new Error('Upstream returned an inconsistent SSE event type');
      }
      let eventData: JsonObject = { ...data, type: event };

      const item = eventItem(eventData);
      if (item?.type === 'message' && typeof item.id === 'string') {
        if (item.phase === 'commentary' || item.phase === 'final_answer') inferredMessagePhases.set(item.id, item.phase);
        if (event === 'response.output_item.added') {
          openMessages.add(item.id);
          bufferedMessageEvents ??= [];
        }
        if (event === 'response.output_item.done') openMessages.delete(item.id);
      }
      const terminalEvent = event === 'response.completed' || event === 'response.failed' || event === 'response.incomplete';
      if (bufferedMessageEvents && !terminalEvent) {
        bufferedMessageEvents.push({ event, data: eventData });
        if (event === 'response.output_item.added' && item?.type === 'function_call') bufferedToolSeen = true;
        if (bufferedToolSeen && openMessages.size === 0) emitBufferedMessage('commentary');
        return false;
      }
      if (terminalEvent) {
        if (!isJsonObject(eventData.response) || !Array.isArray(eventData.response.output)) {
          throw new Error('Upstream returned an invalid Responses object');
        }
        if (eventData.response.status !== event.slice('response.'.length)) {
          throw new Error('Upstream returned an inconsistent Responses terminal status');
        }
        // Validate before releasing buffered events or committing a terminal outcome.
        mapUpstreamOutput(eventData.response.output as JsonObject[], registry);
        if (isJsonObject(eventData.response) && Array.isArray(eventData.response.output)) {
          let followingTool = false;
          const outputs: unknown[] = eventData.response.output;
          for (const output of [...outputs].reverse()) {
            if (isJsonObject(output) && output.type === 'function_call') followingTool = true;
            if (isJsonObject(output) && output.type === 'message' && typeof output.id === 'string') {
              if (output.phase === 'commentary' || output.phase === 'final_answer') {
                inferredMessagePhases.set(output.id, output.phase);
              } else if (!inferredMessagePhases.has(output.id)) {
                inferredMessagePhases.set(output.id, followingTool ? 'commentary' : 'final_answer');
              }
            }
          }
        }
        const phase = bufferedToolSeen ? 'commentary' : 'final_answer';
        emitBufferedMessage(phase);
        eventData = withAssistantMessagePhase(eventData, phase, inferredMessagePhases);
      }
      emitEvent(event, eventData);
      return terminalEvent;
    };

    for (;;) {
      const result = await (reader.read() as Promise<{ done: boolean; value?: Uint8Array }>);
      const text = result.value ? decoder.decode(result.value, { stream: !result.done }) : decoder.decode();
      if (text) {
        pending += (previousCarriageReturn && text.startsWith('\n') ? text.slice(1) : text).replace(/\r\n?/g, '\n');
        previousCarriageReturn = text.endsWith('\r');
      }
      let separator = pending.indexOf('\n\n');
      while (separator >= 0) {
        const block = pending.slice(0, separator);
        pending = pending.slice(separator + 2);
        terminalEventSeen = emitBlock(block) || terminalEventSeen;
        await waitForDownstream();
        separator = pending.indexOf('\n\n');
      }
      if (result.done || terminalEventSeen) break;
    }
    if (pending.trim()) {
      terminalEventSeen = emitBlock(pending) || terminalEventSeen;
      await waitForDownstream();
    }
    if (!terminalEventSeen) throw new Error('Upstream response stream ended before a terminal event');
  } catch (error) {
    const alreadyAborted = upstreamAbort.signal.aborted;
    upstreamAbort.abort();
    if (!res.destroyed && !alreadyAborted && !terminalEventSeen) {
      flushBufferedMessageOnFailure?.();
      await waitForDownstreamOnFailure?.();
      if (
        !writeSseEvent(res, 'response.failed', {
          type: 'response.failed',
          sequence_number: sequenceNumber++,
          response: { status: 'failed', output: [], error: { message: errorMessage(error) } },
        })
      ) {
        await waitForDrainOrClose(res);
      }
    }
  } finally {
    upstreamAbort.abort();
    res.off('close', abortUpstream);
    res.end();
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, config: BridgeConfig): Promise<void> {
  try {
    const requestUrl = new URL(req.url ?? '/', 'http://bridge.local');
    const maxRequestBodyBytes = config.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      writeJson(res, 200, {
        status: 'ready',
        protocol: 'native-responses',
        capabilities: {
          mcpProxy: Boolean(config.mcpProxy),
        },
        config: {
          upstream: config.upstream.baseUrl,
          mcpProxy: config.mcpProxy?.baseUrl ?? null,
          maxRequestBodyBytes,
          excludedMcpTools: config.excludedMcpTools ?? [],
          webSearchTool: config.webSearchTool ?? null,
        },
      });
      return;
    }
    const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(requestUrl.pathname);
    if (mcpMatch?.[1] && config.mcpProxy) {
      await proxyMcpRequest(req, res, config.mcpProxy.baseUrl, mcpMatch[1], requestUrl.search, maxRequestBodyBytes);
      return;
    }
    if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
      const target = upstreamUrl(config.upstream.baseUrl, 'models');
      target.search = requestUrl.search;
      const upstreamAbort = new AbortController();
      const abortUpstream = (): void => {
        upstreamAbort.abort();
      };
      res.once('close', abortUpstream);
      try {
        const upstreamRes = await fetch(target, { signal: upstreamAbort.signal });
        await writeUpstreamResponse(res, upstreamRes);
      } finally {
        res.off('close', abortUpstream);
      }
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/v1/responses') {
      const body = await readJsonBody(req, maxRequestBodyBytes);
      if (typeof body.model !== 'string' || body.model.length === 0) {
        throw new HttpError(400, 'model must be a non-empty string');
      }
      if (body.stream !== undefined && typeof body.stream !== 'boolean') {
        throw new HttpError(400, 'stream must be a boolean');
      }
      if (body.tools !== undefined && !Array.isArray(body.tools)) {
        throw new HttpError(400, 'tools must be an array');
      }
      const request = body as unknown as ResponsesRequest;
      const stream = request.stream === true;
      if (stream) await streamResponsesNative(res, request, config);
      else {
        const upstreamAbort = new AbortController();
        const abortUpstream = (): void => {
          upstreamAbort.abort();
        };
        res.once('close', abortUpstream);
        try {
          writeJson(res, 200, await completeResponses(request, config, upstreamAbort.signal));
        } finally {
          res.off('close', abortUpstream);
        }
      }
      return;
    }
    writeJson(res, 404, { error: { message: 'not found' } });
  } catch (error) {
    if (res.destroyed) return;
    if (!res.headersSent) {
      const status =
        error instanceof ResponsesRequestError
          ? 400
          : error instanceof HttpError || error instanceof UpstreamHttpError
            ? error.status
            : 500;
      writeJson(res, status, { error: { message: errorMessage(error) } });
      return;
    }
    res.destroy(error instanceof Error ? error : undefined);
  }
}

export function createServer(config: BridgeConfig): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(req, res, config);
  });
}

export async function main(configPath = process.env.CODEX_LLAMA_CPP_BRIDGE_CONFIG): Promise<http.Server> {
  const config = await loadConfig(configPath);
  const server = createServer(config);
  server.listen(config.listen.port, config.listen.host);
  await once(server, 'listening');
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : config.listen.port;
  console.error(`codex-llama.cpp-bridge listening on http://${config.listen.host}:${String(port)}/v1`);
  return server;
}
