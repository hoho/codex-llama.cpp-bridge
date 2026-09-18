import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeResponses,
  mapUpstreamOutput,
  namespaceToolName,
  responsesInputForUpstream,
  responsesRequestForUpstream,
  transformResponsesTools,
} from '../src/bridge.js';
import { runCli } from '../src/cli.js';
import { createServer, loadConfig } from '../src/server.js';
import type { JsonObject, ResponsesRequest, ResponsesTool } from '../src/types.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: URL, body: JsonObject | undefined, init: RequestInit | undefined) => Response | Promise<Response>): void {
  const implementation: typeof fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const parsed: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : undefined;
    return Promise.resolve(handler(url, body, init));
  };
  globalThis.fetch = vi.fn(implementation);
}

async function requestServer(port: number, method: string, path: string, body?: JsonObject): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

async function requestServerSseEvents(port: number, body: JsonObject): Promise<{ elapsedMs: number; data: JsonObject }[]> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const payload = JSON.stringify(body);
    const events: { elapsedMs: number; data: JsonObject }[] = [];
    let pending = '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        res.on('data', (chunk: Buffer) => {
          pending += chunk.toString('utf8');
          const blocks = pending.split(/\r?\n\r?\n/);
          pending = blocks.pop() ?? '';
          for (const block of blocks) {
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (!data || data === '[DONE]') continue;
            events.push({ elapsedMs: Date.now() - started, data: JSON.parse(data) as JsonObject });
          }
        });
        res.on('end', () => {
          resolve(events);
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function upstreamResponse(output: JsonObject[]): JsonObject {
  return {
    id: 'resp_1',
    object: 'response',
    model: 'qwen',
    status: 'completed',
    output,
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
}

function sseResponse(events: JsonObject[]): Response {
  const body = events
    .map((data) => {
      const event = String(data.type);
      return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    })
    .join('');
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function stagedSseResponse(stages: JsonObject[][], delayMs: number): Response {
  const encoder = new TextEncoder();
  const encode = (events: JsonObject[]): Uint8Array =>
    encoder.encode(events.map((data) => `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stages.forEach((stage, index) => {
        setTimeout(() => {
          controller.enqueue(encode(stage));
          if (index === stages.length - 1) controller.close();
        }, index * delayMs);
      });
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

function parseSseEvents(body: string): JsonObject[] {
  return body
    .split(/\r?\n\r?\n/)
    .map((block) => /^data: (.+)$/m.exec(block)?.[1])
    .filter((data): data is string => Boolean(data) && data !== '[DONE]')
    .map((data) => JSON.parse(data) as JsonObject);
}

describe('native Responses bridge', () => {
  it('prints CLI help and initializes installable examples', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-llama-cli-'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await runCli(['--help']);
      expect(log.mock.calls.flat().join('\n')).toContain('codex-llama.cpp-bridge --init');
      log.mockClear();

      await runCli(['--init', dir]);
      expect(
        JSON.parse(await import('node:fs/promises').then(({ readFile }) => readFile(join(dir, 'bridge.config.json'), 'utf8'))),
      ).toMatchObject({
        listen: { host: '127.0.0.1', port: 10901 },
        upstream: 'http://127.0.0.1:5656/v1',
      });
      expect(await import('node:fs/promises').then(({ readFile }) => readFile(join(dir, 'codex.config.toml'), 'utf8'))).toContain(
        'wire_api = "responses"',
      );
      await expect(runCli(['--init', dir])).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('flattens namespace tool names', () => {
    expect(namespaceToolName('mcp__time', 'get.current')).toBe('mcp__time__get_current');
  });

  it('converts Codex custom and namespace tools to Responses function tools', () => {
    const tools: ResponsesTool[] = [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Apply a patch',
        format: { syntax: 'lark', definition: 'start: "patch"' },
      },
      {
        type: 'namespace',
        name: 'mcp__time',
        description: 'Time tools',
        tools: [{ type: 'function', name: 'get_current_time', parameters: { type: 'object' } }],
      },
      { type: 'function', name: 'shell', parameters: { type: 'object' } },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);

    expect(responseTools.map((tool) => tool.name)).toEqual(['apply_patch', 'mcp__time__get_current_time', 'shell']);
    expect(responseTools.every((tool) => tool.type === 'function')).toBe(true);
    expect(responseTools[0]?.description).toContain('Example input:');
    expect(responseTools[0]?.description).toContain('start: "patch"');
    expect(registry.get('apply_patch')).toEqual({ kind: 'client_custom', name: 'apply_patch' });
    expect(registry.get('mcp__time__get_current_time')).toEqual({
      kind: 'mcp',
      namespace: 'mcp__time',
      tool: 'get_current_time',
    });
  });

  it('filters configured MCP tools', () => {
    const { responseTools } = transformResponsesTools(
      [
        {
          type: 'namespace',
          name: 'mcp__chrome_devtools',
          tools: [
            { type: 'function', name: 'navigate' },
            { type: 'function', name: 'take_screenshot' },
          ],
        },
      ],
      { excludedMcpTools: [{ namespace: 'mcp__chrome_devtools', tools: ['mcp__chrome_devtools__take_screenshot'] }] },
    );
    expect(responseTools.map((tool) => tool.name)).toEqual(['mcp__chrome_devtools__navigate']);
  });

  it('maps Codex tool history into native Responses function history', () => {
    const input = responsesInputForUpstream([
      { role: 'user', content: 'use time' },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'get_current_time',
        namespace: 'mcp__time',
        arguments: '{"timezone":"UTC"}',
      },
      { type: 'function_call_output', call_id: 'call_1', output: '12:00' },
      { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_2', name: 'apply_patch', input: 'patch', status: 'completed' },
      { type: 'custom_tool_call_output', call_id: 'call_2', output: 'done' },
    ]) as JsonObject[];

    expect(input[1]).toMatchObject({ name: 'mcp__time__get_current_time' });
    expect(input[1]).not.toHaveProperty('namespace');
    expect(input[3]).toMatchObject({
      type: 'function_call',
      name: 'apply_patch',
      arguments: '{"input":"patch"}',
    });
    expect(input[4]).toMatchObject({ type: 'function_call_output', output: 'done' });
    expect(responsesInputForUpstream('hello')).toBe('hello');
  });

  it('preserves native request fields while disabling upstream streaming', () => {
    const request: ResponsesRequest = {
      model: 'qwen',
      input: 'hello',
      stream: true,
      temperature: 0,
      tools: [{ type: 'custom', name: 'apply_patch' }],
    };
    const { responseTools } = transformResponsesTools(request.tools);
    expect(responsesRequestForUpstream(request, responseTools)).toMatchObject({
      model: 'qwen',
      input: 'hello',
      stream: false,
      temperature: 0,
      tools: [{ type: 'function', name: 'apply_patch' }],
    });
  });

  it('maps upstream calls back while preserving reasoning and ordinary calls', () => {
    const { registry } = transformResponsesTools([
      { type: 'custom', name: 'apply_patch' },
      {
        type: 'namespace',
        name: 'mcp__time',
        tools: [{ type: 'function', name: 'get_current_time' }],
      },
    ]);
    const output = mapUpstreamOutput(
      [
        { type: 'reasoning', id: 'rs_1', summary: [] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'apply_patch',
          arguments: '{"input":"patch text"}',
          status: 'completed',
        },
        {
          type: 'function_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'mcp__time__get_current_time',
          arguments: '{"timezone":"UTC"}',
        },
        { type: 'function_call', id: 'fc_3', name: 'shell', arguments: '{}' },
      ],
      registry,
    );

    expect(output[0]).toMatchObject({ type: 'reasoning', id: 'rs_1', summary: [] });
    expect(output[1]).toMatchObject({ type: 'custom_tool_call', name: 'apply_patch', input: 'patch text' });
    expect(output[1]).not.toHaveProperty('arguments');
    expect(output[2]).toMatchObject({ type: 'function_call', name: 'get_current_time', namespace: 'mcp__time' });
    expect(output[3]).toMatchObject({ type: 'function_call', name: 'shell' });
  });

  it('exposes llama.cpp reasoning content as a Codex reasoning summary', () => {
    const output = mapUpstreamOutput(
      [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Inspect the repository, then make the focused change.' }],
        },
      ],
      new Map(),
    );

    expect(output[0]).toMatchObject({
      type: 'reasoning',
      id: 'rs_1',
      summary: [{ type: 'summary_text', text: 'Inspect the repository, then make the focused change.' }],
    });
  });

  it('calls upstream native Responses without authorization and preserves response metadata', async () => {
    mockFetch((url, body, init) => {
      expect(url.href).toBe('http://llama.invalid/v1/responses');
      expect(init?.headers).toEqual({ 'content-type': 'application/json' });
      expect(body).toMatchObject({ model: 'qwen', stream: false });
      return Response.json(
        upstreamResponse([
          {
            type: 'message',
            id: 'msg_1',
            content: [{ type: 'output_text', text: 'hello' }],
          },
        ]),
      );
    });

    await expect(
      completeResponses(
        { model: 'qwen', input: 'hi' },
        { listen: { host: '127.0.0.1', port: 0 }, upstream: { baseUrl: 'http://llama.invalid/v1' } },
      ),
    ).resolves.toMatchObject({ id: 'resp_1', output_text: 'hello' });
  });

  it('surfaces upstream errors', async () => {
    mockFetch(() => new Response('bad request', { status: 400 }));
    await expect(
      completeResponses(
        { model: 'qwen', input: 'hi' },
        { listen: { host: '127.0.0.1', port: 0 }, upstream: { baseUrl: 'http://llama.invalid/v1' } },
      ),
    ).rejects.toThrow('Upstream 400: bad request');
  });

  it('loads config and passes through transformed native Responses stream events', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-llama-bridge-'));
    const configPath = join(dir, 'config.json');
    let mcpRequestBody = '';
    let mcpRequestUrl = '';
    const mcpServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        mcpRequestBody = Buffer.concat(chunks).toString('utf8');
        mcpRequestUrl = req.url ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: {} }));
      });
    });
    await new Promise<void>((resolve) => mcpServer.listen(0, '127.0.0.1', resolve));
    const mcpPort = (mcpServer.address() as AddressInfo).port;
    await writeFile(
      configPath,
      JSON.stringify({
        upstream: 'http://llama.invalid/v1',
        mcpProxy: `http://127.0.0.1:${String(mcpPort)}/servers`,
        listen: { port: 0 },
        excludedMcpTools: [{ namespace: 'mcp__chrome_devtools', tools: ['take_screenshot'] }],
      }),
    );
    const config = await loadConfig(configPath);
    expect(config.upstream.baseUrl).toBe('http://llama.invalid/v1');
    expect(config.mcpProxy?.baseUrl).toBe(`http://127.0.0.1:${String(mcpPort)}/servers`);

    mockFetch((url, body, init) => {
      if (url.origin === `http://127.0.0.1:${String(mcpPort)}`) return originalFetch(url, init);
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'qwen' }] });
      if (body?.input === 'delayed-tool') {
        const message = {
          type: 'message',
          id: 'msg_delayed',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Checking.' }],
        };
        const call = { type: 'function_call', id: 'fc_delayed', call_id: 'call_delayed', name: 'probe', arguments: '{}' };
        return stagedSseResponse(
          [
            [
              {
                type: 'response.created',
                sequence_number: 0,
                response: { ...upstreamResponse([]), status: 'in_progress' },
              },
              { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: message },
              {
                type: 'response.output_text.delta',
                sequence_number: 2,
                output_index: 0,
                item_id: 'msg_delayed',
                delta: 'Checking.',
              },
            ],
            [
              { type: 'response.output_item.added', sequence_number: 3, output_index: 1, item: call },
              { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: message },
            ],
            [
              { type: 'response.output_item.done', sequence_number: 5, output_index: 1, item: call },
              {
                type: 'response.completed',
                sequence_number: 6,
                response: { ...upstreamResponse([message, call]), output_text: 'Checking.' },
              },
            ],
          ],
          250,
        );
      }
      if (body?.input === 'final') {
        const item = { type: 'message', id: 'msg_final', content: [{ type: 'output_text', text: 'done' }] };
        return sseResponse([
          { type: 'response.created', sequence_number: 0, response: { ...upstreamResponse([]), status: 'in_progress' } },
          { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item },
          { type: 'response.output_text.delta', sequence_number: 2, output_index: 0, item_id: 'msg_final', delta: 'done' },
          { type: 'response.output_item.done', sequence_number: 3, output_index: 0, item },
          { type: 'response.completed', sequence_number: 4, response: { ...upstreamResponse([item]), output_text: 'done' } },
        ]);
      }
      expect(body).toMatchObject({
        model: 'qwen',
        stream: true,
        input: [{ type: 'function_call_output', call_id: 'prior_call', output: 'done' }],
        tools: [{ type: 'function', name: 'apply_patch' }],
      });
      const output = [
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [],
          content: [{ type: 'reasoning_text', text: 'Inspect first.' }],
        },
        { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'ok' }] },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'apply_patch',
          arguments: '{"input":"*** Begin Patch"}',
          status: 'completed',
        },
      ];
      return sseResponse([
        { type: 'response.created', sequence_number: 0, response: { ...upstreamResponse([]), status: 'in_progress' } },
        { type: 'response.in_progress', sequence_number: 1, response: { ...upstreamResponse([]), status: 'in_progress' } },
        { type: 'response.output_item.added', sequence_number: 2, output_index: 0, item: output[0] },
        { type: 'response.reasoning_text.delta', sequence_number: 3, output_index: 0, item_id: 'rs_1', delta: 'Inspect' },
        { type: 'response.output_item.done', sequence_number: 4, output_index: 0, item: output[0] },
        { type: 'response.output_item.added', sequence_number: 5, output_index: 1, item: output[1] },
        { type: 'response.output_text.delta', sequence_number: 6, output_index: 1, item_id: 'msg_1', delta: 'ok' },
        { type: 'response.output_item.done', sequence_number: 7, output_index: 1, item: output[1] },
        {
          type: 'response.output_item.added',
          sequence_number: 8,
          output_index: 2,
          item: { ...output[2], arguments: '', status: 'in_progress' },
        },
        {
          type: 'response.function_call_arguments.delta',
          sequence_number: 9,
          output_index: 2,
          item_id: 'fc_1',
          delta: '{"input":"*** Begin Patch"}',
        },
        {
          type: 'response.function_call_arguments.done',
          sequence_number: 10,
          output_index: 2,
          item_id: 'fc_1',
          arguments: '{"input":"*** Begin Patch"}',
        },
        { type: 'response.output_item.done', sequence_number: 11, output_index: 2, item: output[2] },
        {
          type: 'response.completed',
          sequence_number: 12,
          response: { ...upstreamResponse(output), output_text: 'ok' },
        },
      ]);
    });

    const server = createServer(config);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const health = await requestServer(port, 'GET', '/health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.text)).toMatchObject({
        status: 'ready',
        protocol: 'native-responses',
        capabilities: { mcpProxy: true },
        config: {
          upstream: 'http://llama.invalid/v1',
          mcpProxy: `http://127.0.0.1:${String(mcpPort)}/servers`,
          maxRequestBodyBytes: 16777216,
          excludedMcpTools: [{ namespace: 'mcp__chrome_devtools', tools: ['take_screenshot'] }],
        },
      });

      const models = await requestServer(port, 'GET', '/v1/models');
      expect(models.status).toBe(200);
      expect(JSON.parse(models.text)).toMatchObject({ data: [{ id: 'qwen' }] });

      const mcp = await requestServer(port, 'POST', '/mcp/time', { jsonrpc: '2.0', method: 'ping' });
      expect(mcp.status, mcp.text).toBe(200);
      expect(JSON.parse(mcp.text)).toMatchObject({ jsonrpc: '2.0', result: {} });
      expect(mcpRequestUrl).toBe('/servers/time/mcp');
      expect(JSON.parse(mcpRequestBody)).toMatchObject({ jsonrpc: '2.0', method: 'ping' });

      const response = await requestServer(port, 'POST', '/v1/responses', {
        model: 'qwen',
        input: [{ type: 'function_call_output', call_id: 'prior_call', output: 'done' }],
        stream: true,
        tools: [{ type: 'custom', name: 'apply_patch' }],
      });
      expect(response.status).toBe(200);
      expect(response.text).toContain('event: response.created');
      expect(response.text).toContain('event: response.reasoning_text.delta');
      expect(response.text).toContain('event: response.output_text.delta');
      expect(response.text).toContain('event: response.completed');
      expect(response.text).toContain('"type":"message"');
      expect(response.text).toContain('"output_text":"ok"');
      expect(response.text).toContain('"type":"custom_tool_call"');
      expect(response.text).toContain('"input":"*** Begin Patch"');
      expect(response.text).toContain('"type":"summary_text"');
      expect(response.text).not.toContain('response.function_call_arguments.delta');

      const events = parseSseEvents(response.text);
      expect(events.filter((event) => event.type === 'response.created')).toHaveLength(1);
      expect(events.slice(0, 4).map((event) => event.type)).toEqual([
        'response.created',
        'response.in_progress',
        'response.output_item.added',
        'response.reasoning_text.delta',
      ]);
      expect(events.find((event) => event.type === 'response.reasoning_text.delta')).toMatchObject({ output_index: 0 });
      expect(
        events.find((event) => event.type === 'response.output_item.added' && (event.item as JsonObject | undefined)?.id === 'msg_1'),
      ).toMatchObject({ item: { phase: 'commentary' } });
      expect(
        events.find((event) => event.type === 'response.output_item.done' && (event.item as JsonObject | undefined)?.id === 'msg_1'),
      ).toMatchObject({ item: { phase: 'commentary' } });
      const completed = events.find((event) => event.type === 'response.completed');
      expect(completed).toMatchObject({ response: { id: 'resp_1' } });
      const completedResponse = completed?.response as JsonObject;
      expect((completedResponse.output as JsonObject[]).find((item) => item.id === 'msg_1')).toMatchObject({
        phase: 'commentary',
      });
      expect(response.text).not.toContain('msg_bridge_');

      const finalResponse = await requestServer(port, 'POST', '/v1/responses', {
        model: 'qwen',
        input: 'final',
        stream: true,
      });
      const finalEvents = parseSseEvents(finalResponse.text);
      expect(
        finalEvents.find(
          (event) => event.type === 'response.output_item.done' && (event.item as JsonObject | undefined)?.id === 'msg_final',
        ),
      ).toMatchObject({ item: { phase: 'final_answer' } });

      const delayedEvents = await requestServerSseEvents(port, {
        model: 'qwen',
        input: 'delayed-tool',
        stream: true,
      });
      const delayedMessageDone = delayedEvents.find(
        (event) => event.data.type === 'response.output_item.done' && (event.data.item as JsonObject | undefined)?.id === 'msg_delayed',
      );
      const delayedMessageAdded = delayedEvents.find(
        (event) => event.data.type === 'response.output_item.added' && (event.data.item as JsonObject | undefined)?.id === 'msg_delayed',
      );
      const delayedToolAdded = delayedEvents.find(
        (event) => event.data.type === 'response.output_item.added' && (event.data.item as JsonObject | undefined)?.id === 'fc_delayed',
      );
      expect(delayedMessageAdded?.data).toMatchObject({ item: { phase: 'commentary' } });
      expect(delayedMessageDone?.data).toMatchObject({
        item: {
          phase: 'commentary',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Checking.' }],
        },
      });
      expect(
        delayedEvents.filter(
          (event) => event.data.type === 'response.output_item.done' && (event.data.item as JsonObject | undefined)?.id === 'msg_delayed',
        ),
      ).toHaveLength(1);
      expect(delayedMessageAdded?.elapsedMs).toBeGreaterThanOrEqual(200);
      expect(delayedToolAdded?.elapsedMs).toBeGreaterThanOrEqual(delayedMessageDone?.elapsedMs ?? 0);
      expect(delayedMessageDone).toBeDefined();
      expect(delayedToolAdded).toBeDefined();
      if (delayedMessageDone === undefined || delayedToolAdded === undefined) {
        throw new Error('missing delayed message or tool event');
      }
      expect(delayedEvents.indexOf(delayedMessageDone)).toBeLessThan(delayedEvents.indexOf(delayedToolAdded));

      expect((await requestServer(port, 'GET', '/missing')).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
      await new Promise<void>((resolve) =>
        mcpServer.close(() => {
          resolve();
        }),
      );
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid exclusions and keeps streaming server alive after upstream failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-llama-bridge-'));
    const configPath = join(dir, 'config.json');
    await writeFile(configPath, JSON.stringify({ excludedMcpTools: [{ namespace: 'mcp__time', tools: [] }] }));
    await expect(loadConfig(configPath)).rejects.toThrow('must be a non-empty string array');
    await writeFile(configPath, JSON.stringify({ listen: { port: 70000 } }));
    await expect(loadConfig(configPath)).rejects.toThrow('listen.port must be an integer');
    await writeFile(configPath, JSON.stringify({ upstream: 'file:///tmp/llama.cpp' }));
    await expect(loadConfig(configPath)).rejects.toThrow('upstream must use http or https');
    await rm(dir, { recursive: true, force: true });

    mockFetch((url) => {
      if (url.pathname.endsWith('/models')) return Response.json({ object: 'list', data: [{ id: 'qwen' }] });
      throw new Error('upstream unavailable');
    });
    const server = createServer({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { baseUrl: 'http://llama.invalid/v1' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const failed = await requestServer(port, 'POST', '/v1/responses', { model: 'qwen', input: 'hi', stream: true });
      expect(failed.text).toContain('event: response.failed');
      expect(failed.text).toContain('upstream unavailable');
      expect((await requestServer(port, 'GET', '/v1/models')).status).toBe(200);
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });

  it('aborts upstream generation when the Codex client disconnects', async () => {
    let upstreamSignal: AbortSignal | undefined;
    let resolveUpstreamStarted: (() => void) | undefined;
    const upstreamStarted = new Promise<void>((resolve) => {
      resolveUpstreamStarted = resolve;
    });
    mockFetch((_url, _body, init) => {
      upstreamSignal = init?.signal ?? undefined;
      resolveUpstreamStarted?.();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'));
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const server = createServer({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: { baseUrl: 'http://llama.invalid/v1' },
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const request = http.request({
        host: '127.0.0.1',
        port,
        path: '/v1/responses',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      request.on('error', () => {
        // The intentional disconnect may surface as ECONNRESET on the client.
      });
      request.end(JSON.stringify({ model: 'qwen', input: 'keep working', stream: true }));
      await upstreamStarted;
      request.destroy();
      await vi.waitFor(() => {
        expect(upstreamSignal?.aborted).toBe(true);
      });
    } finally {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    }
  });
});
