import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { JsonObject, McpToolExclusion, ResponsesRequest } from '../../src/types.js';

const require = createRequire(import.meta.url);
const codexEntry = require.resolve('@openai/codex/bin/codex.js');
const bridgeEntry = fileURLToPath(new URL('../../dist/cli.mjs', import.meta.url));

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as JsonObject;
}

async function readRequest(req: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}

function message(id: string, text = id): JsonObject {
  return { type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
}

function respond(res: ServerResponse, output: JsonObject[], turn: number): void {
  const response = {
    id: `resp_${String(turn)}`,
    object: 'response',
    model: 'qwen',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    output,
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  };
  const events: JsonObject[] = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } }];
  for (const [output_index, item] of output.entries()) {
    events.push({
      type: 'response.output_item.added',
      output_index,
      item: item.type === 'message' ? { ...item, status: 'in_progress', content: [] } : { ...item, status: 'in_progress', arguments: '' },
    });
    if (item.type === 'message') {
      const content = item.content as JsonObject[];
      for (const [content_index, part] of content.entries()) {
        const fields = { output_index, item_id: item.id, content_index };
        events.push(
          { type: 'response.content_part.added', ...fields, part: { ...part, text: '' } },
          { type: 'response.output_text.delta', ...fields, delta: part.text },
          { type: 'response.output_text.done', ...fields, text: part.text },
          { type: 'response.content_part.done', ...fields, part },
        );
      }
    } else if (item.type === 'function_call') {
      events.push(
        { type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments },
        { type: 'response.function_call_arguments.done', output_index, item_id: item.id, arguments: item.arguments },
      );
    }
    events.push({ type: 'response.output_item.done', output_index, item });
  }
  events.push({ type: 'response.completed', response });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(
    events
      .map((event, sequence_number) => `event: ${String(event.type)}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`)
      .join(''),
  );
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
  }, 2000);
  child.kill('SIGTERM');
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

interface CodexResult {
  code: string | number;
  stdout: string;
  stderr: string;
  events: JsonObject[];
}

async function fixture(
  handler: (body: ResponsesRequest, res: ServerResponse, turn: number) => void,
  mapWebSearch = true,
  excludedMcpTools: McpToolExclusion[] = [],
) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'bridge-codex-e2e-')));
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const requests: ResponsesRequest[] = [];
  const mcpCalls: JsonObject[] = [];
  const errors: unknown[] = [];
  const children: ChildProcess[] = [];
  const servers: http.Server[] = [];
  onTestFinished(async () => {
    await Promise.all(children.map(stop));
    await Promise.all(
      servers.map(async (server) => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) reject(error);
            else resolve();
          });
        });
      }),
    );
    await rm(root, { recursive: true, force: true });
    expect(errors, 'Local E2E fixture errors').toEqual([]);
  });
  await Promise.all([mkdir(home), mkdir(workspace)]);
  await writeFile(path.join(home, 'config.toml'), await readFile(new URL('../../examples/codex.config.toml', import.meta.url)));
  const modelCatalog = path.join(root, 'models.json');
  await writeFile(
    modelCatalog,
    JSON.stringify({
      models: [
        {
          slug: 'qwen',
          display_name: 'Bridge E2E fixture',
          supported_reasoning_levels: [],
          shell_type: 'unified_exec',
          visibility: 'list',
          supported_in_api: true,
          priority: 0,
          base_instructions: 'Execute the synthetic tool calls supplied by the local test server.',
          support_verbosity: false,
          apply_patch_tool_type: 'freeform',
          truncation_policy: { mode: 'bytes', limit: 10000 },
          experimental_supported_tools: [],
          input_modalities: ['text'],
        },
      ],
    }),
  );

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const body = await readRequest(req);
    if (req.url === '/v1/responses') {
      const request = body as ResponsesRequest;
      requests.push(request);
      handler(request, res, requests.length);
      return;
    }
    if (req.url !== '/servers/search/mcp') throw new Error(`Unexpected fixture route: ${String(req.url)}`);
    if (body.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: JsonObject;
    switch (body.method) {
      case 'initialize':
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'bridge-search-fixture', version: '1.0.0' },
        };
        break;
      case 'tools/list':
        result = {
          tools: ['search', 'mcp__search__search', 'hidden'].map((name) => ({
            name,
            description: 'Return a synthetic search result without network access.',
            annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
          })),
        };
        break;
      case 'tools/call': {
        const params = object(body.params);
        mcpCalls.push(params);
        result = { content: [{ type: 'text', text: `fixture:${String(params.name)}` }], isError: false };
        break;
      }
      case 'ping':
        result = {};
        break;
      default:
        throw new Error(`Unexpected MCP method: ${String(body.method)}`);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  };
  const upstream = http.createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      errors.push(error);
      if (res.headersSent) res.destroy(error instanceof Error ? error : undefined);
      else res.writeHead(500).end(String(error));
    });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  servers.push(upstream);
  const upstreamUrl = `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
  const configPath = path.join(root, 'bridge.json');
  await writeFile(
    configPath,
    JSON.stringify({
      listen: { host: '127.0.0.1', port: 0 },
      upstream: `${upstreamUrl}/v1`,
      mcpProxy: `${upstreamUrl}/servers`,
      excludedMcpTools,
      ...(mapWebSearch ? { webSearchTool: { namespace: 'mcp__search', tool: 'search' } } : {}),
    }),
  );
  const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: home, TMPDIR: root, LANG: 'en_US.UTF-8' };
  const bridge = spawn(process.execPath, [bridgeEntry, configPath], { cwd: workspace, env, stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(bridge);
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => {
      reject(new Error(`Bridge startup timed out: ${stderr}`));
    }, 5000);
    bridge.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    bridge.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited (${String(code)}): ${stderr}`));
    });
    bridge.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
      const url = /listening on (http:\/\/127\.0\.0\.1:\d+\/v1)/.exec(stderr)?.[1];
      if (url) {
        clearTimeout(timer);
        resolve(url);
      }
    });
  });
  const health = await fetch(new URL('/health', baseUrl));
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: 'ready', protocol: 'native-responses' });

  const run = async (overrides: string[] = []): Promise<CodexResult> => {
    const config = [
      'model="qwen"',
      `model_catalog_json=${JSON.stringify(modelCatalog)}`,
      'approval_policy="never"',
      `model_providers.llama_cpp_bridge.base_url=${JSON.stringify(baseUrl)}`,
      'model_providers.llama_cpp_bridge.request_max_retries=0',
      'model_providers.llama_cpp_bridge.stream_max_retries=0',
      `mcp_servers.search.url=${JSON.stringify(new URL('/mcp/search', baseUrl).href)}`,
      ...overrides,
    ];
    return new Promise((resolve, reject) => {
      const child = execFile(
        process.execPath,
        [
          codexEntry,
          'exec',
          '--ephemeral',
          '--ignore-rules',
          '--strict-config',
          '--skip-git-repo-check',
          '--sandbox',
          'workspace-write',
          '--json',
          '-C',
          workspace,
          ...config.flatMap((value) => ['-c', value]),
          'Offline bridge interoperability test. Follow the supplied responses.',
        ],
        { cwd: workspace, env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 },
        (error, stdout, stderr) => {
          try {
            resolve({
              code: error ? (error.code ?? error.signal ?? 'execution_failed') : 0,
              stdout,
              stderr,
              events: stdout
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => object(JSON.parse(line))),
            });
          } catch (parseError) {
            reject(new Error(`Invalid Codex JSONL output: ${stdout}\n${stderr}`, { cause: parseError }));
          }
        },
      );
      children.push(child);
      child.stdin?.end();
    });
  };
  return { run, requests, mcpCalls, baseUrl, workspace };
}

function inputItems(request: ResponsesRequest | undefined): JsonObject[] {
  if (!request || !Array.isArray(request.input)) throw new Error('Expected follow-up Responses input');
  return request.input.map(object);
}

function messages(result: CodexResult): unknown[] {
  return result.events
    .filter((event) => event.type === 'item.completed')
    .map((event) => object(event.item))
    .filter((item) => item.type === 'agent_message')
    .map((item) => item.text);
}

function toolDiagnostics(requests: ResponsesRequest[], result: CodexResult): string {
  return JSON.stringify(
    {
      stdout: result.stdout,
      stderr: result.stderr,
      tools: requests[0]?.tools?.map((tool) => ({ type: tool.type, name: tool.name })),
      outputs: inputItems(requests[1]).filter((item) => item.type === 'function_call_output'),
    },
    null,
    2,
  );
}

describe('real Codex CLI through the built bridge', () => {
  it.each([undefined, 'commentary'])('preserves message text interleaved with a real MCP call (phase=%s)', async (phase) => {
    const context = await fixture((_body, res, turn) => {
      if (turn > 1) {
        respond(res, [message('interleaving-finished')], turn);
        return;
      }
      const item = { ...message('before', 'Before after.'), ...(phase ? { phase } : {}) };
      const call = {
        type: 'function_call',
        id: 'search',
        call_id: 'search',
        name: 'mcp__search__search',
        arguments: '{"query":"synthetic"}',
        status: 'completed',
      };
      const response = { id: 'response', object: 'response', model: 'qwen', status: 'completed', output: [item, call] };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } },
        {
          type: 'response.content_part.added',
          output_index: 0,
          item_id: 'before',
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'before', content_index: 0, delta: 'Before ' },
        { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '', status: 'in_progress' } },
        { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'search', delta: call.arguments },
        { type: 'response.output_text.delta', output_index: 0, item_id: 'before', content_index: 0, delta: 'after.' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.output_item.done', output_index: 1, item: call },
        { type: 'response.completed', response },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(
        events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
      );
    });
    const result = await context.run();
    expect(result.code, result.stderr).toBe(0);
    expect(context.requests).toHaveLength(2);
    expect(context.mcpCalls.map((call) => call.name)).toEqual(['search']);
    expect(messages(result)).toEqual(['Before after.', 'interleaving-finished']);
    expect(JSON.stringify(inputItems(context.requests[1]))).toContain('Before after.');
  });

  it('preserves multiple assistant messages with the shipped Codex config', async () => {
    const context = await fixture((_body, res, turn) => {
      respond(res, [message('first-message'), message('second-message')], turn);
    });
    const result = await context.run();
    expect(result.code, result.stderr).toBe(0);
    expect(context.requests).toHaveLength(1);
    expect(messages(result)).toEqual(['first-message', 'second-message']);
  });

  it('executes custom apply_patch and round-trips its call and result', async () => {
    const patch = '*** Begin Patch\n*** Add File: bridge-e2e.txt\n+bridge-e2e-ok\n*** End Patch\n';
    const context = await fixture((_body, res, turn) => {
      if (turn === 1) {
        respond(
          res,
          [
            {
              type: 'function_call',
              id: 'fc_patch',
              call_id: 'call_patch',
              name: 'apply_patch',
              arguments: JSON.stringify({ input: patch }),
              status: 'completed',
            },
          ],
          turn,
        );
      } else {
        respond(res, [message('patch-finished')], turn);
      }
    });
    const result = await context.run();
    expect(result.code, result.stderr).toBe(0);
    expect(context.requests).toHaveLength(2);
    expect(
      context.requests[0]?.tools?.find((tool) => tool.name === 'apply_patch'),
      toolDiagnostics(context.requests, result),
    ).toMatchObject({
      type: 'function',
      parameters: { required: ['input'] },
    });
    const outputs = inputItems(context.requests[1]).filter((item) => item.type === 'function_call_output');
    expect(JSON.stringify(outputs), toolDiagnostics(context.requests, result)).toContain('bridge-e2e.txt');
    expect(await readFile(path.join(context.workspace, 'bridge-e2e.txt'), 'utf8')).toBe('bridge-e2e-ok\n');
    const history = inputItems(context.requests[1]);
    expect(history.find((item) => item.call_id === 'call_patch' && item.type === 'function_call')).toMatchObject({
      name: 'apply_patch',
      arguments: JSON.stringify({ input: patch }),
    });
    expect(JSON.stringify(history.find((item) => item.type === 'function_call_output'))).toContain('bridge-e2e.txt');
    expect(messages(result)).toEqual(['patch-finished']);
  });

  it('executes MCP search tools through the relay and preserves their history names', async () => {
    const names = ['mcp__search__search', 'mcp__search__mcp__search__search'];
    const context = await fixture((_body, res, turn) => {
      respond(
        res,
        turn === 1
          ? names.map((name, index) => ({
              type: 'function_call',
              id: `fc_${String(index)}`,
              call_id: `call_${String(index)}`,
              name,
              arguments: '{"query":"synthetic"}',
              status: 'completed',
            }))
          : [message('search-finished')],
        turn,
      );
    });
    const result = await context.run([`mcp_servers.search.url=${JSON.stringify(new URL('/mcp/search', context.baseUrl).href)}`]);
    expect(result.code, result.stderr).toBe(0);
    expect(context.requests).toHaveLength(2);
    expect(context.mcpCalls.map((call) => call.name).sort(), toolDiagnostics(context.requests, result)).toEqual([
      'mcp__search__search',
      'search',
    ]);
    expect(
      context.requests[0]?.tools
        ?.filter((tool) => names.includes(tool.name ?? ''))
        .map((tool) => tool.name)
        .sort(),
    ).toEqual([...names].sort());
    const history = inputItems(context.requests[1]);
    expect(
      history
        .filter((item) => item.type === 'function_call')
        .map((item) => item.name)
        .sort(),
    ).toEqual([...names].sort());
    expect(JSON.stringify(history.filter((item) => item.type === 'function_call_output'))).toContain('fixture:search');
    expect(messages(result)).toEqual(['search-finished']);
  });

  it('reports an unconfigured hosted-search mapping instead of returning an unexecutable tool call', async () => {
    const context = await fixture(() => {
      throw new Error('Hosted search must not reach upstream');
    }, false);
    const result = await context.run(['web_search="live"']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Hosted web search requires a webSearchTool mapping');
    expect(context.requests).toHaveLength(0);
  });

  it('excludes an advertised MCP tool while keeping mapped search executable', async () => {
    const context = await fixture(
      (_body, res, turn) => {
        respond(
          res,
          turn === 1
            ? [
                {
                  type: 'function_call',
                  id: 'search',
                  call_id: 'search',
                  name: 'mcp__search__search',
                  arguments: '{"query":"synthetic"}',
                  status: 'completed',
                },
              ]
            : [message('filtered-search-finished')],
          turn,
        );
      },
      true,
      [{ namespace: 'mcp__search', tools: ['hidden'] }],
    );
    const result = await context.run();
    expect(result.code, result.stderr).toBe(0);
    expect(context.requests).toHaveLength(2);
    for (const request of context.requests) {
      const toolNames = request.tools?.map((tool) => tool.name);
      expect(toolNames).toContain('mcp__search__search');
      expect(toolNames).not.toContain('mcp__search__hidden');
    }
    expect(context.mcpCalls.map((call) => call.name)).toEqual(['search']);
    expect(messages(result)).toEqual(['filtered-search-finished']);
  });

  it('reports malformed SSE to Codex and closes the unfinished upstream connection', async () => {
    let closed = false;
    const context = await fixture((_body, res) => {
      res.on('close', () => {
        closed = true;
      });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.created\ndata: {invalid}\n\n');
    });
    const result = await context.run();
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('invalid JSON in an SSE event');
    expect(context.requests).toHaveLength(1);
    await vi.waitFor(() => {
      expect(closed).toBe(true);
    });
  });

  it('rejects a configured search mapping when its MCP server is disabled in Codex', async () => {
    const context = await fixture(() => {
      throw new Error('An unavailable search target must not reach upstream');
    });
    const result = await context.run(['mcp_servers.search.enabled=false']);
    expect(result.code).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Hosted web search requires a webSearchTool mapping');
    expect(context.requests).toHaveLength(0);
  });
});
