import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, loadConfig } from '../src/server.js';
import type { BridgeConfig, JsonObject } from '../src/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

interface HttpResult {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

async function request(
  port: number,
  method: string,
  requestPath: string,
  body?: string,
  headers: Record<string, string> = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: requestPath,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': String(Buffer.byteLength(body)) }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('aborted', () => {
          reject(new Error('response aborted'));
        });
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function withBridge<T>(config: BridgeConfig, callback: (port: number) => Promise<T>): Promise<T> {
  const server = createServer(config);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await callback((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }
}

function bridgeConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    listen: { host: '127.0.0.1', port: 0 },
    upstream: { baseUrl: 'http://llama.invalid/v1' },
    ...overrides,
  };
}

function mockFetch(handler: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>): void {
  globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.resolve(handler(url, init));
  });
}

function sse(events: (JsonObject | string)[]): Response {
  const body = events
    .map((event) => {
      if (typeof event === 'string') return event;
      return `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`;
    })
    .join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

function sseEvents(text: string): JsonObject[] {
  return [...text.matchAll(/^data: (.+)$/gm)].map((match) => JSON.parse(match[1] ?? '') as JsonObject);
}

describe('configuration validation', () => {
  it('loads defaults, object URL forms, and explicit MCP disablement', async () => {
    await expect(loadConfig()).resolves.toEqual({
      listen: { host: '127.0.0.1', port: 10901 },
      maxRequestBodyBytes: 16777216,
      upstream: { baseUrl: 'http://qwen.local:5656/v1' },
    });

    const directory = await mkdtemp(path.join(tmpdir(), 'codex-llama-config-'));
    const configPath = path.join(directory, 'config.json');
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          listen: { host: ' 0.0.0.0 ', port: 0 },
          maxRequestBodyBytes: 1024,
          upstream: { baseUrl: 'https://llama.example/v1/' },
          mcpProxy: { baseUrl: 'https://mcp.example/servers/' },
          webSearchTool: { namespace: 'mcp__search', tool: 'search' },
        }),
      );
      await expect(loadConfig(configPath)).resolves.toEqual({
        listen: { host: '0.0.0.0', port: 0 },
        maxRequestBodyBytes: 1024,
        upstream: { baseUrl: 'https://llama.example/v1' },
        mcpProxy: { baseUrl: 'https://mcp.example/servers' },
        webSearchTool: { namespace: 'mcp__search', tool: 'search' },
      });
      await writeFile(configPath, JSON.stringify({ mcpProxy: null }));
      expect(await loadConfig(configPath)).not.toHaveProperty('mcpProxy');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { value: [], message: 'config must be a JSON object' },
    { value: { listen: 'localhost' }, message: 'listen must be an object' },
    { value: { listen: { host: '  ' } }, message: 'listen.host must be a non-empty string' },
    { value: { listen: { port: -1 } }, message: 'listen.port must be an integer' },
    { value: { listen: { port: 1.5 } }, message: 'listen.port must be an integer' },
    { value: { maxRequestBodyBytes: 0 }, message: 'maxRequestBodyBytes must be a positive safe integer' },
    { value: { maxRequestBodyBytes: 1.5 }, message: 'maxRequestBodyBytes must be a positive safe integer' },
    { value: { upstream: 42 }, message: 'upstream must be a URL string or an object with baseUrl' },
    { value: { upstream: {} }, message: 'upstream.baseUrl is required' },
    { value: { upstream: 'not a URL' }, message: 'upstream must be a valid URL' },
    { value: { upstream: 'file:///tmp/llama' }, message: 'upstream must use http or https' },
    { value: { upstream: 'https://user:secret@llama.example/v1' }, message: 'upstream must not include credentials' },
    { value: { upstream: 'https://llama.example/v1?token=value' }, message: 'upstream must not include a query string or fragment' },
    { value: { mcpProxy: 42 }, message: 'mcpProxy must be a URL string or an object with baseUrl' },
    { value: { mcpProxy: {} }, message: 'mcpProxy.baseUrl is required' },
    { value: { webSearchTool: null }, message: 'webSearchTool must contain non-empty namespace and tool strings' },
    { value: { webSearchTool: {} }, message: 'webSearchTool must contain non-empty namespace and tool strings' },
    {
      value: { webSearchTool: { namespace: '', tool: 'search' } },
      message: 'webSearchTool must contain non-empty namespace and tool strings',
    },
    {
      value: { webSearchTool: { namespace: 'mcp__search', tool: ' ' } },
      message: 'webSearchTool must contain non-empty namespace and tool strings',
    },
    {
      value: { webSearchTool: { namespace: 'mcp__search', tool: 1 } },
      message: 'webSearchTool must contain non-empty namespace and tool strings',
    },
    { value: { excludedMcpTools: {} }, message: 'excludedMcpTools must be an array' },
    { value: { excludedMcpTools: [null] }, message: 'excludedMcpTools[0] must be an object' },
    {
      value: { excludedMcpTools: [{ namespace: '', tools: ['one'] }] },
      message: 'excludedMcpTools[0].namespace must be a non-empty string',
    },
    {
      value: { excludedMcpTools: [{ namespace: 'mcp__time', tools: [1] }] },
      message: 'excludedMcpTools[0].tools must be a non-empty string array',
    },
  ])('rejects invalid config: $message', async ({ value, message }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'codex-llama-invalid-config-'));
    const configPath = path.join(directory, 'config.json');
    try {
      await writeFile(configPath, JSON.stringify(value));
      await expect(loadConfig(configPath)).rejects.toThrow(message);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('HTTP and upstream boundaries', () => {
  it.each([false, true])('rejects malformed upstream output instead of reporting completion (stream=%s)', async (stream) => {
    for (const output of [undefined, null, {}, [null], [[]], [42]]) {
      const response = { id: 'response', status: 'completed', output };
      mockFetch(() => (stream ? sse([{ type: 'response.completed', response }]) : Response.json(response)));
      await withBridge(bridgeConfig(), async (port) => {
        const result = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream }));
        if (stream) {
          expect(
            sseEvents(result.text).map((event) => event.type),
            JSON.stringify(output),
          ).toEqual(['response.failed']);
        } else {
          expect(result.status).toBe(500);
        }
        expect(result.text).toContain('invalid Responses');
      });
    }
  });

  it('does not accept terminal SSE without a response object', async () => {
    mockFetch(() => sse([{ type: 'response.completed' }]));
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
      expect(sseEvents(result.text).map((event) => event.type)).toEqual(['response.failed']);
      expect(result.text).toContain('invalid Responses');
    });
  });

  it.each([
    'event: response.completed\ndata: {"type":"response.failed","response":{"status":"failed","output":[]}}\n\n',
    'data: {"type":"response.completed","response":{"status":"failed","output":[]}}\n\n',
    'data: {"response":{"status":"completed","output":[]}}\n\n',
  ])('rejects inconsistent SSE event identity or terminal status', async (payload) => {
    mockFetch(() => sse([payload]));
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
      const events = sseEvents(result.text);
      expect(events.map((event) => event.type)).toEqual(['response.failed']);
      expect(result.text).toContain('Upstream returned');
    });
  });

  it('accepts SSE event identity from its header without a redundant JSON type', async () => {
    mockFetch(() => sse(['event: response.completed\ndata: {"response":{"status":"completed","output":[]}}\n\n']));
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
      expect(sseEvents(result.text).map((event) => event.type)).toEqual(['response.completed']);
    });
  });

  it.each([false, true])('rejects malformed selectors and tool field shapes before upstream (stream=%s)', async (stream) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not reach upstream'));
    await withBridge(bridgeConfig(), async (port) => {
      const invalid = [
        ...[null, [], 42, {}, 'bogus', { type: 'function' }, { type: 'custom', name: 'ordinary' }].map((tool_choice) => ({
          tools: [{ name: 'ordinary' }],
          tool_choice,
        })),
        ...[{ description: {} }, { strict: 'yes' }, { parameters: [] }, { format: 'lark' }, { format: { definition: 42 } }].map(
          (fields) => ({ tools: [{ type: 'custom', name: 'patch', ...fields }] }),
        ),
      ];
      for (const fields of invalid) {
        const response = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, ...fields }));
        expect(response.status, JSON.stringify(fields)).toBe(400);
        expect(response.headers['content-type']).toBe('application/json');
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects selectors for excluded tools before upstream (stream=%s)', async (stream) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Must not reach upstream'));
    await withBridge(bridgeConfig({ excludedMcpTools: [{ namespace: 'mcp__test', tools: ['excluded'] }] }), async (port) => {
      for (const flat of [false, true]) {
        const tools = flat
          ? [{ name: 'mcp__test__allowed' }, { name: 'mcp__test__excluded' }]
          : [{ type: 'namespace', name: 'mcp__test', tools: [{ name: 'allowed' }, { name: 'excluded' }] }];
        const choice = flat
          ? { type: 'function', name: 'mcp__test__excluded' }
          : { type: 'function', namespace: 'mcp__test', name: 'excluded' };
        for (const tool_choice of [choice, { type: 'allowed_tools', mode: 'required', tools: [choice] }]) {
          const result = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, tools, tool_choice }));
          expect(result.status).toBe(400);
          expect(result.headers['content-type']).toBe('application/json');
          expect(result.text).toContain('unavailable tool');
        }
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('strips hop-by-hop fields in both relay directions without dropping MCP session headers', async () => {
    let calls = 0;
    const upstream = http.createServer((req, res) => {
      calls++;
      req.resume();
      expect(req.headers['x-request-hop']).toBeUndefined();
      expect(req.headers['keep-alive']).toBeUndefined();
      expect(req.headers.te).toBeUndefined();
      expect(req.headers['proxy-authorization']).toBeUndefined();
      expect(req.headers['mcp-session-id']).toBe('session');
      res.writeHead(200, {
        'content-type': 'application/json',
        connection: 'keep-alive, X-Response-Hop',
        'x-response-hop': 'private',
        'mcp-session-id': 'session',
        'set-cookie': ['session=one; HttpOnly', 'csrf=two; SameSite=Strict'],
        trailer: 'x-trailer',
      });
      res.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await withBridge(
        bridgeConfig({ mcpProxy: { baseUrl: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/servers` } }),
        async (port) => {
          const result = await request(port, 'POST', '/mcp/test', '{}', {
            connection: 'keep-alive, X-Request-Hop',
            'keep-alive': 'timeout=5',
            'x-request-hop': 'private',
            te: 'trailers',
            'proxy-authorization': 'local-proxy-only',
            'mcp-session-id': 'session',
          });
          expect(result.status).toBe(200);
          expect(result.text).toBe('{"ok":true}');
          expect(result.headers['x-response-hop']).toBeUndefined();
          expect(result.headers.trailer).toBeUndefined();
          expect(result.headers['mcp-session-id']).toBe('session');
          expect(result.headers['set-cookie']).toEqual(['session=one; HttpOnly', 'csrf=two; SameSite=Strict']);
        },
      );
      expect(calls).toBe(1);
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) =>
        upstream.close(() => {
          resolve();
        }),
      );
    }
  });

  it.each([false, true])('rejects malformed tool entries before invoking upstream (stream=%s)', async (stream) => {
    const invalidTools = [
      { value: null, message: 'tools[0] must be an object' },
      { value: [], message: 'tools[0] must be an object' },
      { value: 'broken', message: 'tools[0] must be an object' },
      { value: 42, message: 'tools[0] must be an object' },
      { value: false, message: 'tools[0] must be an object' },
      { value: {}, message: 'tools[0].name must be a non-empty string' },
      { value: { name: '' }, message: 'tools[0].name must be a non-empty string' },
      { value: { name: ' ' }, message: 'tools[0].name must be a non-empty string' },
      { value: { name: 42 }, message: 'tools[0].name must be a non-empty string' },
      { value: { type: null, name: 'tool' }, message: 'tools[0].type must be a string' },
      { value: { type: 42, name: 'tool' }, message: 'tools[0].type must be a string' },
      { value: { type: 'namespace', name: 'editor' }, message: 'tools[0].tools must be an array' },
      { value: { type: 'namespace', name: 'editor', tools: {} }, message: 'tools[0].tools must be an array' },
      { value: { type: 'namespace', name: 'editor', tools: [null] }, message: 'tools[0].tools[0] must be an object' },
      { value: { type: 'namespace', name: 'editor', tools: ['broken'] }, message: 'tools[0].tools[0] must be an object' },
      { value: { type: 'namespace', name: 'editor', tools: [[]] }, message: 'tools[0].tools[0] must be an object' },
      {
        value: { type: 'namespace', name: 'editor', tools: [{ type: 'custom', name: '' }] },
        message: 'tools[0].tools[0].name must be a non-empty string',
      },
      {
        value: { type: 'namespace', name: 'editor', tools: [{ type: 'web_search' }] },
        message: 'Unsupported Responses tool type: web_search',
      },
      {
        value: { type: 'namespace', name: 'editor', tools: [{ type: 'namespace', name: 'nested', tools: [] }] },
        message: 'Unsupported Responses tool type: namespace',
      },
    ];
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Invalid tools must not reach upstream'));
    await withBridge(bridgeConfig(), async (port) => {
      for (const { value, message } of invalidTools) {
        const result = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, tools: [value] }));
        expect(result.status, JSON.stringify(value)).toBe(400);
        expect(result.headers['content-type']).toBe('application/json');
        expect(JSON.parse(result.text)).toEqual({ error: { message } });
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([false, true])('filters flat and namespaced MCP tools over HTTP (stream=%s)', async (stream) => {
    mockFetch((_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        tools: [{ name: 'mcp__chrome_devtools__navigate' }, { name: 'mcp__other__take_screenshot' }],
      });
      const response = { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: [] };
      return stream ? sse([{ type: 'response.completed', response }]) : Response.json(response);
    });
    await withBridge(
      bridgeConfig({ excludedMcpTools: [{ namespace: 'mcp__chrome_devtools', tools: ['take_screenshot'] }] }),
      async (port) => {
        for (const flat of [false, true]) {
          const tools = [
            ...(flat
              ? [{ name: 'mcp__chrome_devtools__take_screenshot' }, { name: 'mcp__chrome_devtools__navigate' }]
              : [{ type: 'namespace', name: 'mcp__chrome_devtools', tools: [{ name: 'take_screenshot' }, { name: 'navigate' }] }]),
            { name: 'mcp__other__take_screenshot' },
          ];
          const result = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, tools }));
          expect(result.status).toBe(200);
          expect(result.text).not.toContain('response.failed');
        }
      },
    );
  });

  it.each([false, true])('round-trips namespaced custom tools over HTTP (stream=%s)', async (stream) => {
    const patch = '*** Begin Patch\n*** Add File: custom.txt\n+ok\n*** End Patch\n';
    const call = {
      type: 'function_call',
      id: 'patch',
      call_id: 'patch_call',
      name: 'editor__apply_patch',
      arguments: JSON.stringify({ input: patch }),
      status: 'completed',
    };
    let turn = 0;
    mockFetch((_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({
        tools: [{ type: 'function', name: 'editor__apply_patch', parameters: { required: ['input'] } }],
      });
      turn += 1;
      if (turn === 1) {
        expect(body).toMatchObject({ tool_choice: { type: 'function', name: 'editor__apply_patch' } });
      } else {
        expect(body).toMatchObject({
          input: [call, { type: 'function_call_output', call_id: 'patch_call', output: 'created custom.txt' }],
          tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'function', name: 'editor__apply_patch' }] },
        });
      }
      const response = { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: turn === 1 ? [call] : [] };
      return stream
        ? sse([
            ...(turn === 1
              ? [
                  { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
                  { type: 'response.function_call_arguments.delta', output_index: 0, item_id: call.id, delta: call.arguments },
                  { type: 'response.function_call_arguments.done', output_index: 0, item_id: call.id, arguments: call.arguments },
                  { type: 'response.output_item.done', output_index: 0, item: call },
                ]
              : []),
            { type: 'response.completed', response },
          ])
        : Response.json(response);
    });
    await withBridge(bridgeConfig(), async (port) => {
      const tools = [{ type: 'namespace', name: 'editor', tools: [{ type: 'custom', name: 'apply_patch' }] }];
      const choice = { type: 'custom', namespace: 'editor', name: 'apply_patch' };
      const first = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, tools, tool_choice: choice }));
      expect(first.status).toBe(200);
      const events = stream ? sseEvents(first.text) : [];
      const response: unknown = stream ? events.at(-1)?.response : JSON.parse(first.text);
      const mappedCall = {
        type: 'custom_tool_call',
        id: call.id,
        call_id: call.call_id,
        name: 'apply_patch',
        namespace: 'editor',
        input: patch,
        status: 'completed',
      };
      expect(response).toMatchObject({ output: [mappedCall] });
      if (stream) {
        expect(events.map((event) => event.type)).toEqual([
          'response.output_item.added',
          'response.output_item.done',
          'response.completed',
        ]);
        expect(events.slice(0, 2).map((event) => event.item)).toEqual([mappedCall, mappedCall]);
      }
      const followup = await request(
        port,
        'POST',
        '/v1/responses',
        JSON.stringify({
          model: 'qwen',
          stream,
          tools,
          input: [mappedCall, { type: 'custom_tool_call_output', call_id: call.call_id, output: 'created custom.txt' }],
          tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [choice] },
        }),
      );
      expect(followup.status).toBe(200);
      expect(followup.text).not.toContain('response.failed');
      expect(turn).toBe(2);
    });
  });

  it.each([false, true])('maps hosted search choices and returned calls through HTTP (stream=%s)', async (stream) => {
    const call = { type: 'function_call', id: 'search', call_id: 'search', name: 'mcp__search__find', arguments: '{"terms":"test"}' };
    mockFetch((_url, init) => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
      expect(JSON.parse(init.body)).toMatchObject({
        stream,
        tools: [{ type: 'function', name: 'mcp__search__find', parameters: { required: ['terms'] } }],
        tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'mcp__search__find' }] },
      });
      const response = { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: [call] };
      return stream ? sse([{ type: 'response.completed', response }]) : Response.json(response);
    });
    await withBridge(bridgeConfig({ webSearchTool: { namespace: 'mcp__search', tool: 'find' } }), async (port) => {
      const result = await request(
        port,
        'POST',
        '/v1/responses',
        JSON.stringify({
          model: 'qwen',
          stream,
          tools: [
            { type: 'web_search' },
            {
              type: 'namespace',
              name: 'mcp__search',
              tools: [{ name: 'find', parameters: { type: 'object', properties: { terms: { type: 'string' } }, required: ['terms'] } }],
            },
          ],
          tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'web_search' }] },
        }),
      );
      expect(result.status).toBe(200);
      const response: unknown = stream ? sseEvents(result.text)[0]?.response : JSON.parse(result.text);
      expect(response).toMatchObject({ output: [{ ...call, name: 'find', namespace: 'mcp__search' }] });
    });
  });

  it.each([false, true])('rejects hosted search before sending headers or calling upstream (stream=%s)', async (stream) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await withBridge(bridgeConfig(), async (port) => {
      for (const options of [
        { tools: [{ type: 'web_search' }] },
        { tool_choice: { type: 'web_search_preview' } },
        { tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type: 'web_search' }] } },
      ]) {
        const result = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', stream, ...options }));
        expect(result.status).toBe(400);
        expect(result.headers['content-type']).toBe('application/json');
        expect(result.text).toContain('webSearchTool mapping');
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { body: '{', message: 'request body must contain valid JSON' },
    { body: '[]', message: 'request body must be a JSON object' },
    { body: '{}', message: 'model must be a non-empty string' },
    { body: '{"model":"qwen","stream":"yes"}', message: 'stream must be a boolean' },
    { body: '{"model":"qwen","tools":{}}', message: 'tools must be an array' },
  ])('returns HTTP 400 for invalid Responses requests', async ({ body, message }) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await withBridge(bridgeConfig(), async (port) => {
      const response = await request(port, 'POST', '/v1/responses', body, { 'content-type': 'application/json' });
      expect(response.status).toBe(400);
      expect(JSON.parse(response.text)).toEqual({ error: { message } });
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards model query strings, status, headers, and empty bodies', async () => {
    mockFetch((url) => {
      expect(url.href).toBe('http://llama.invalid/v1/models?details=true');
      return new Response(null, { status: 204, headers: { 'x-upstream': 'models' } });
    });
    await withBridge(bridgeConfig(), async (port) => {
      const response = await request(port, 'GET', '/v1/models?details=true');
      expect(response.status).toBe(204);
      expect(response.text).toBe('');
      expect(response.headers['x-upstream']).toBe('models');
    });
  });

  it('aborts model listing when its client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    mockFetch((_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      notifyStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    await withBridge(bridgeConfig(), async (port) => {
      const client = http.request({ host: '127.0.0.1', port, path: '/v1/models', method: 'GET' });
      client.on('error', () => {
        // The intentional disconnect may reset the socket.
      });
      client.end();
      await started;
      client.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
      });
    });
  });

  it('returns valid non-streaming Responses output', async () => {
    mockFetch((url, init) => {
      expect(url.href).toBe('http://llama.invalid/v1/responses');
      expect(init?.method).toBe('POST');
      return Response.json({
        id: 'response',
        object: 'response',
        model: 'qwen',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
      });
    });

    await withBridge(bridgeConfig(), async (port) => {
      const response = await request(port, 'POST', '/v1/responses', '{"model":"qwen"}', {
        'content-type': 'application/json',
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(response.text)).toMatchObject({ output_text: 'done' });
    });
  });

  it('preserves non-streaming upstream error status codes', async () => {
    mockFetch(() => new Response('rate limited', { status: 429 }));
    await withBridge(bridgeConfig(), async (port) => {
      const response = await request(port, 'POST', '/v1/responses', '{"model":"qwen"}', {
        'content-type': 'application/json',
      });
      expect(response.status).toBe(429);
      expect(JSON.parse(response.text)).toEqual({ error: { message: 'Upstream 429: rate limited' } });
    });
  });

  it('returns HTTP 413 when a Responses request exceeds the configured body limit', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await withBridge(bridgeConfig({ maxRequestBodyBytes: 32 }), async (port) => {
      const response = await request(port, 'POST', '/v1/responses', JSON.stringify({ model: 'qwen', input: 'x'.repeat(64) }), {
        'content-type': 'application/json',
      });
      expect(response.status).toBe(413);
      expect(JSON.parse(response.text)).toEqual({
        error: { message: 'request body exceeds the configured limit of 32 bytes' },
      });
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('enforces the Responses body limit without a Content-Length header', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await withBridge(bridgeConfig({ maxRequestBodyBytes: 32 }), async (port) => {
      const response = await new Promise<HttpResult>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: '/v1/responses',
            headers: { 'content-type': 'application/json' },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('error', reject);
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
              resolve({
                status: res.statusCode ?? 0,
                text: Buffer.concat(chunks).toString('utf8'),
                headers: res.headers,
              });
            });
          },
        );
        req.on('error', reject);
        req.write('{"model":"qwen","input":"');
        req.end(`${'x'.repeat(64)}"}`);
      });
      expect(response.status).toBe(413);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('returns HTTP 413 when an MCP request exceeds the configured body limit', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await withBridge(bridgeConfig({ maxRequestBodyBytes: 8, mcpProxy: { baseUrl: 'http://mcp.invalid/servers' } }), async (port) => {
      const response = await request(port, 'POST', '/mcp/time', '123456789', { 'content-type': 'application/json' });
      expect(response.status).toBe(413);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('aborts non-streaming generation when its client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    mockFetch((_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      notifyStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    await withBridge(bridgeConfig(), async (port) => {
      const client = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      client.on('error', () => {
        // The intentional disconnect may reset the socket.
      });
      client.end(JSON.stringify({ model: 'qwen', stream: false, input: 'keep working' }));
      await started;
      client.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
      });
    });
  });

  it('forwards MCP methods, query strings, headers, bodies, and response metadata', async () => {
    let captured:
      | {
          method: string | undefined;
          url: string;
          body: string;
          header: string | undefined;
        }
      | undefined;
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured = {
          method: req.method,
          url: req.url ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
          header: req.headers['x-mcp-test'] as string | undefined,
        };
        res.writeHead(201, { 'content-type': 'application/json', 'x-mcp-upstream': 'yes' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamPort = (upstream.address() as AddressInfo).port;
    try {
      await withBridge(bridgeConfig({ mcpProxy: { baseUrl: `http://127.0.0.1:${String(upstreamPort)}/servers` } }), async (port) => {
        const response = await request(port, 'PATCH', '/mcp/time?session=one', '{"ping":true}', {
          'content-type': 'application/json',
          'x-mcp-test': 'forwarded',
        });
        expect(response.status).toBe(201);
        expect(response.text).toBe('{"ok":true}');
        expect(response.headers['x-mcp-upstream']).toBe('yes');
        expect(captured).toEqual({
          method: 'PATCH',
          url: '/servers/time/mcp?session=one',
          body: '{"ping":true}',
          header: 'forwarded',
        });
      });
    } finally {
      await new Promise<void>((resolve) => {
        upstream.close(() => {
          resolve();
        });
      });
    }
  });

  it('returns 404 for MCP routes when no proxy is configured', async () => {
    await withBridge(bridgeConfig(), async (port) => {
      const response = await request(port, 'POST', '/mcp/time', '{}');
      expect(response.status).toBe(404);
    });
  });

  it('aborts an MCP request when its client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let notifyStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    mockFetch((_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      notifyStarted?.();
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    await withBridge(bridgeConfig({ mcpProxy: { baseUrl: 'http://mcp.invalid/servers' } }), async (port) => {
      const client = http.request({
        host: '127.0.0.1',
        port,
        path: '/mcp/time',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      client.on('error', () => {
        // The intentional disconnect may reset the socket.
      });
      client.end('{}');
      await started;
      client.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
      });
    });
  });

  it.each([
    {
      name: 'non-SSE content',
      response: () => Response.json({ status: 'completed' }),
      expected: 'must use text/event-stream',
    },
    {
      name: 'invalid SSE JSON',
      response: () => new Response('event: response.created\ndata: {invalid}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      expected: 'invalid JSON in an SSE event',
    },
    {
      name: 'non-object SSE JSON',
      response: () => new Response('event: response.created\ndata: []\n\n', { headers: { 'content-type': 'text/event-stream' } }),
      expected: 'non-object JSON in an SSE event',
    },
    {
      name: 'truncated SSE stream',
      response: () =>
        sse([
          {
            type: 'response.created',
            response: { id: 'response', object: 'response', model: 'qwen', status: 'in_progress', output: [] },
          },
        ]),
      expected: 'ended before a terminal event',
    },
  ])('emits response.failed for $name', async ({ response, expected }) => {
    mockFetch(() => response());
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}', {
        'content-type': 'application/json',
      });
      expect(result.status).toBe(200);
      expect(result.text).toContain('event: response.failed');
      expect(result.text).toContain(expected);
    });
  });

  it.each([
    { contentType: 'text/event-stream', body: 'event: response.created\ndata: {invalid}\n\n' },
    { contentType: 'application/json', body: '{"unfinished":' },
  ])('closes an unfinished upstream connection after rejecting $contentType', async ({ contentType, body }) => {
    let upstreamClosed = false;
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.on('close', () => {
        upstreamClosed = true;
      });
      res.writeHead(200, { 'content-type': contentType });
      res.write(body);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await withBridge(
        bridgeConfig({ upstream: { baseUrl: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/v1` } }),
        async (port) => {
          const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
          expect(result.text).toContain('event: response.failed');
          await vi.waitFor(() => {
            expect(upstreamClosed).toBe(true);
          });
        },
      );
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) =>
        upstream.close(() => {
          resolve();
        }),
      );
    }
  });

  it.each(['completed', 'failed', 'incomplete'])('preserves all interleaved messages before response.%s', async (status) => {
    const messages = ['first', 'second'].map((id) => ({
      type: 'message',
      id,
      role: 'assistant',
      content: [{ type: 'output_text', text: id }],
    }));
    const events: JsonObject[] = [
      ...messages.map((item, output_index) => ({
        type: 'response.output_item.added',
        output_index,
        item: { ...item, content: [] },
      })),
      ...messages.flatMap((item, output_index) => [
        { type: 'response.output_text.delta', output_index, item_id: item.id, delta: item.id },
        { type: 'response.output_item.done', output_index, item },
      ]),
      { type: `response.${status}`, response: { id: 'response', status, output: messages } },
    ];
    mockFetch(() => sse(events));
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
      const output = sseEvents(result.text);
      expect(output.map((event) => event.type)).toEqual(events.map((event) => event.type));
      expect(output.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual([
        'first',
        'second',
      ]);
      expect(output.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)).toEqual(
        messages.map((item) => ({ ...item, phase: 'final_answer' })),
      );
      expect(output.map((event) => event.sequence_number)).toEqual(output.map((_, index) => index));
    });
  });

  it.each(['completed', 'failed', 'incomplete'])('preserves late text and authoritative phases before response.%s', async (status) => {
    const first = {
      type: 'message',
      id: 'first',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [
        { type: 'output_text', text: 'Before after.' },
        { type: 'output_text', text: 'Second part.' },
      ],
    };
    const call = { type: 'function_call', id: 'call', call_id: 'call', name: 'probe', arguments: '{}' };
    const final = { type: 'message', id: 'final', phase: 'final_answer', content: [{ type: 'output_text', text: 'Final.' }] };
    mockFetch(() =>
      sse([
        { type: 'response.output_item.added', output_index: 0, item: { ...first, phase: undefined, status: 'in_progress', content: [] } },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'first', content_index: 0, delta: 'Before ' },
        { type: 'response.output_item.added', output_index: 1, item: call },
        { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'call', delta: '{}' },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'first', content_index: 0, delta: 'after.' },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'first', content_index: 1, delta: 'Second part.' },
        { type: 'response.output_item.done', output_index: 0, item: first },
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.output_item.added', output_index: 2, item: { ...final, content: [] } },
        { type: 'response.output_item.done', output_index: 2, item: final },
        { type: `response.${status}`, response: { id: 'response', status, output: [first, call, final] } },
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const events = sseEvents((await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}')).text);
      expect(
        events
          .filter((event) => event.type === 'response.output_text.delta')
          .map((event) => event.delta)
          .join(''),
      ).toBe('Before after.Second part.');
      const done = events.filter((event) => event.type === 'response.output_item.done');
      expect(done.map((event) => event.item)).toEqual([first, call, final]);
      const firstDone = done[0];
      if (!firstDone) throw new Error('Missing message completion');
      expect(events.indexOf(firstDone)).toBeLessThan(
        events.findIndex((event) => event.type === 'response.output_item.added' && (event.item as JsonObject).id === 'call'),
      );
      expect(
        events.filter((event) => event.type === 'response.output_item.added').map((event) => (event.item as JsonObject).phase),
      ).toEqual(['commentary', undefined, 'final_answer']);
      expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
    });
  });

  it.each([false, true])(
    'infers a final answer after an earlier tool without rewriting it as commentary (interleaved=%s)',
    async (interleaved) => {
      const call = { type: 'function_call', id: 'call', call_id: 'call', name: 'probe', arguments: '{}' };
      const item = { type: 'message', id: 'final', content: [{ type: 'output_text', text: 'Done.' }] };
      mockFetch(() =>
        sse([
          { type: 'response.output_item.added', output_index: 0, item: call },
          ...(!interleaved ? [{ type: 'response.output_item.done', output_index: 0, item: call }] : []),
          { type: 'response.output_item.added', output_index: 1, item: { ...item, content: [] } },
          ...(interleaved ? [{ type: 'response.output_item.done', output_index: 0, item: call }] : []),
          { type: 'response.output_item.done', output_index: 1, item },
          { type: 'response.completed', response: { status: 'completed', output: [call, item] } },
        ]),
      );
      await withBridge(bridgeConfig(), async (port) => {
        const events = sseEvents((await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}')).text);
        expect(
          events
            .filter((event) => (event.item as JsonObject | undefined)?.type === 'message')
            .map((event) => (event.item as JsonObject).phase),
        ).toEqual(['final_answer', 'final_answer']);
        expect(events.at(-1)).toMatchObject({ response: { output: [call, { ...item, phase: 'final_answer' }] } });
      });
    },
  );

  it.each(['done', 'terminal'])('uses an explicit phase first supplied at %s throughout the message lifecycle', async (source) => {
    const item = { type: 'message', id: 'message', content: [{ type: 'output_text', text: 'text' }] };
    mockFetch(() =>
      sse([
        { type: 'response.output_item.added', item: { ...item, content: [] }, output_index: 0 },
        { type: 'response.output_item.done', item: { ...item, ...(source === 'done' ? { phase: 'commentary' } : {}) }, output_index: 0 },
        { type: 'response.completed', response: { status: 'completed', output: [{ ...item, phase: 'commentary' }] } },
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const events = sseEvents((await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}')).text);
      expect(events.filter((event) => event.item).map((event) => (event.item as JsonObject).phase)).toEqual(['commentary', 'commentary']);
    });
  });

  it.each([false, true])('preserves item lifecycles across all message/tool interleavings (custom=%s)', async (custom) => {
    const message = { type: 'message', id: 'message', content: [{ type: 'output_text', text: 'Complete.' }] };
    const call = { type: 'function_call', id: 'call', call_id: 'call', name: 'probe', arguments: '{"input":"value"}' };
    const messageEvents = [
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'Complete.' },
      { type: 'response.output_item.done', output_index: 0, item: message },
    ];
    const callEvents = [
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: call.arguments },
      { type: 'response.output_item.done', output_index: 1, item: call },
    ];
    const merge = (left: JsonObject[], right: JsonObject[]): JsonObject[][] => {
      const first = left[0];
      const second = right[0];
      if (!first) return [right];
      if (!second) return [left];
      return [
        ...merge(left.slice(1), right).map((tail) => [first, ...tail]),
        ...merge(left, right.slice(1)).map((tail) => [second, ...tail]),
      ];
    };
    const permutations = merge(messageEvents, callEvents).filter((events) => events[0] === messageEvents[0]);
    expect(permutations).toHaveLength(10);
    await withBridge(bridgeConfig(), async (port) => {
      for (const permutation of permutations) {
        mockFetch(() => sse([...permutation, { type: 'response.completed', response: { status: 'completed', output: [message, call] } }]));
        const result = await request(
          port,
          'POST',
          '/v1/responses',
          JSON.stringify({
            model: 'qwen',
            stream: true,
            tools: [{ type: custom ? 'custom' : 'function', name: 'probe' }],
          }),
        );
        const events = sseEvents(result.text);
        expect(events.filter((event) => event.type === 'response.output_text.delta').map((event) => event.delta)).toEqual(['Complete.']);
        const completions = events.filter((event) => event.type === 'response.output_item.done');
        expect(completions[0]?.item).toEqual({ ...message, phase: 'commentary' });
        expect(completions[1]?.item).toMatchObject(custom ? { type: 'custom_tool_call', input: 'value' } : call);
        const callAdded = events.findIndex(
          (event) => event.type === 'response.output_item.added' && (event.item as JsonObject).id === 'call',
        );
        if (custom) {
          expect(events.some((event) => event.type === 'response.function_call_arguments.delta')).toBe(false);
        } else {
          expect(events.findIndex((event) => event.type === 'response.function_call_arguments.delta')).toBeGreaterThan(callAdded);
        }
        expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
      }
    });
  });

  it.each(['completed', 'failed', 'incomplete'])(
    'treats response.%s as final despite malformed or duplicate trailing events',
    async (status) => {
      mockFetch(() =>
        sse([
          { type: `response.${status}`, response: { id: 'response', status, output: [] } },
          { type: 'response.completed', response: { status: 'completed', output: [] } },
          'data: {broken}\n\n',
        ]),
      );
      await withBridge(bridgeConfig(), async (port) => {
        const events = sseEvents((await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}')).text);
        expect(events.map((event) => event.type)).toEqual([`response.${status}`]);
      });
    },
  );

  it.each([false, true])('completes every buffered commentary message before a tool (already completed=%s)', async (completed) => {
    const messages = ['first', 'second'].map((id) => ({
      type: 'message',
      id,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: id }],
    }));
    const call = { type: 'function_call', id: 'call', call_id: 'call', name: 'probe', arguments: '{}' };
    const doneEvents = messages.map((item, output_index) => ({ type: 'response.output_item.done', output_index, item }));
    mockFetch(() =>
      sse([
        ...messages.flatMap((item, output_index) => [
          { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } },
          { type: 'response.output_text.delta', output_index, item_id: item.id, delta: item.id },
        ]),
        ...(completed ? doneEvents : []),
        { type: 'response.output_item.added', output_index: 2, item: call },
        ...(completed ? [] : doneEvents),
        { type: 'response.output_item.done', output_index: 2, item: call },
        { type: 'response.completed', response: { id: 'response', status: 'completed', output: [...messages, call] } },
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
      const events = sseEvents(result.text);
      const toolIndex = events.findIndex(
        (event) => event.type === 'response.output_item.added' && (event.item as JsonObject).id === 'call',
      );
      const messageCompletions = events.filter(
        (event) => event.type === 'response.output_item.done' && (event.item as JsonObject).type === 'message',
      );
      expect(messageCompletions.map((event) => event.item)).toEqual(messages.map((item) => ({ ...item, phase: 'commentary' })));
      expect(messageCompletions.every((event) => events.indexOf(event) < toolIndex)).toBe(true);
    });
  });

  it.each([false, true])('flushes buffered messages when the upstream stream ends without a terminal event (tool=%s)', async (tool) => {
    mockFetch(() =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'message', content: [{ type: 'output_text', text: '' }] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'partial' },
        ...(tool
          ? [{ type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'call', name: 'probe' } }]
          : []),
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}', {
        'content-type': 'application/json',
      });
      const messageIndex = result.text.indexOf('"delta":"partial"');
      const failureIndex = result.text.indexOf('event: response.failed');
      expect(result.text).toContain(`"phase":"${tool ? 'commentary' : 'final_answer'}"`);
      expect(messageIndex).toBeGreaterThanOrEqual(0);
      expect(failureIndex).toBeGreaterThan(messageIndex);
      expect(result.text).toContain('ended before a terminal event');
    });
  });

  it('flushes buffered messages before terminal failure events', async () => {
    mockFetch(() =>
      sse([
        {
          type: 'response.output_item.added',
          output_index: 0,
          item: { type: 'message', id: 'message', content: [{ type: 'output_text', text: '' }] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'message', delta: 'partial' },
        {
          type: 'response.failed',
          response: { id: 'response', object: 'response', model: 'qwen', status: 'failed', output: [] },
        },
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}', {
        'content-type': 'application/json',
      });
      expect(result.text).toContain('"phase":"final_answer"');
      expect(result.text).toContain('event: response.failed');
      expect(result.text).not.toContain('ended before a terminal event');
    });
  });

  it.each(['\n', '\r\n', '\r'])('decodes UTF-8 and SSE records across every byte boundary (%j)', async (newline) => {
    const text = 'caf\u00e9 \ud83e\udd99';
    const item = { type: 'message', id: 'message', content: [{ type: 'output_text', text }] };
    const payload = [
      ': comment',
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'message', output_index: 0, delta: text })}`,
      '',
      `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })}`,
      '',
      'event: response.completed',
      'data: {"type":"response.completed",',
      `data: "response":${JSON.stringify({ status: 'completed', output: [item] })}}`,
      '',
      '',
    ].join(newline);
    mockFetch(() => {
      const bytes = new TextEncoder().encode(payload);
      let position = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (position === bytes.length) controller.close();
            else controller.enqueue(bytes.slice(position, ++position));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    await withBridge(bridgeConfig(), async (port) => {
      const events = sseEvents((await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}')).text);
      expect(events.map((event) => event.type)).toEqual([
        'response.output_item.added',
        'response.output_text.delta',
        'response.output_item.done',
        'response.completed',
      ]);
      expect(events[1]?.delta).toBe(text);
      expect(events[2]).toMatchObject({ item });
    });
  });

  it.each(['completed', 'failed', 'incomplete'])('closes a still-open upstream immediately after response.%s', async (status) => {
    let closed = false;
    const upstream = http.createServer((req, res) => {
      req.resume();
      res.once('close', () => {
        closed = true;
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ type: `response.${status}`, response: { status, output: [] } })}\n\n`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    try {
      await withBridge(
        bridgeConfig({ upstream: { baseUrl: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/v1` } }),
        async (port) => {
          const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}');
          expect(sseEvents(result.text).map((event) => event.type)).toEqual([`response.${status}`]);
          await vi.waitFor(() => {
            expect(closed).toBe(true);
          });
        },
      );
    } finally {
      upstream.closeAllConnections();
      await new Promise<void>((resolve) =>
        upstream.close(() => {
          resolve();
        }),
      );
    }
  });

  it('preserves the SSE done marker after a terminal event', async () => {
    mockFetch(() =>
      sse([
        {
          type: 'response.completed',
          response: { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: [] },
        },
        'data: [DONE]\n\n',
      ]),
    );
    await withBridge(bridgeConfig(), async (port) => {
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}', {
        'content-type': 'application/json',
      });
      expect(result.text).toContain('event: response.completed');
      expect(result.text).toContain('data: [DONE]');
    });
  });

  it('waits for downstream SSE backpressure before completing the stream', async () => {
    mockFetch(() =>
      sse([
        {
          type: 'response.completed',
          response: { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: [] },
        },
      ]),
    );
    const originalWriteValue: unknown = Reflect.get(http.ServerResponse.prototype, 'write');
    if (typeof originalWriteValue !== 'function') throw new Error('ServerResponse.write is unavailable');
    const originalWrite = originalWriteValue as (this: http.ServerResponse, ...args: unknown[]) => boolean;
    let blocked = false;
    vi.spyOn(http.ServerResponse.prototype, 'write').mockImplementation(function (this: http.ServerResponse, ...args: unknown[]) {
      const result = originalWrite.apply(this, args);
      if (!blocked && typeof args[0] === 'string' && args[0].includes('event: response.completed')) {
        blocked = true;
        setTimeout(() => {
          this.emit('drain');
        }, 50);
        return false;
      }
      return result;
    });

    await withBridge(bridgeConfig(), async (port) => {
      const started = Date.now();
      const result = await request(port, 'POST', '/v1/responses', '{"model":"qwen","stream":true}', {
        'content-type': 'application/json',
      });
      expect(result.status).toBe(200);
      expect(result.text).toContain('event: response.completed');
      expect(Date.now() - started).toBeGreaterThanOrEqual(40);
    });
  });

  it('aborts downstream responses when a proxied body fails after headers', async () => {
    mockFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'));
          controller.error(new Error('upstream body failed'));
        },
      });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    });
    await withBridge(bridgeConfig(), async (port) => {
      await expect(request(port, 'GET', '/v1/models')).rejects.toThrow(/response aborted|socket hang up/);
    });
  });
});
