import { describe, expect, it, vi } from 'vitest';
import {
  completeResponses,
  mapUpstreamOutput,
  mapUpstreamResponse,
  responsesInputForUpstream,
  responsesRequestForUpstream,
  sanitizeToolName,
  transformResponsesTools,
} from '../src/bridge.js';
import type { ResponsesRequest, ResponsesResponse, ResponsesTool } from '../src/types.js';

describe('tool transformation boundaries', () => {
  it('sanitizes primitive names and falls back for unsupported values', () => {
    expect(sanitizeToolName('get.current time')).toBe('get_current_time');
    expect(sanitizeToolName(42)).toBe('42');
    expect(sanitizeToolName(false)).toBe('false');
    expect(sanitizeToolName(12n)).toBe('12');
    expect(sanitizeToolName(null, 'fallback')).toBe('fallback');
    expect(sanitizeToolName({}, 'fallback')).toBe('fallback');
    expect(sanitizeToolName('', 'fallback')).toBe('fallback');
  });

  it('restores original custom and MCP names after using sanitized upstream names', () => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'read.file' },
      { type: 'custom', name: 'apply.patch' },
      {
        type: 'namespace',
        name: 'mcp.time',
        tools: [{ type: 'function', name: 'get.current' }],
      },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);
    expect(responseTools.map((tool) => tool.name)).toEqual(['read_file', 'apply_patch', 'mcp_time__get_current']);

    expect(
      mapUpstreamOutput(
        [
          { type: 'function_call', name: 'read_file', arguments: '{}' },
          { type: 'function_call', name: 'apply_patch', arguments: '{"input":"patch"}' },
          { type: 'function_call', name: 'mcp_time__get_current', arguments: '{}' },
        ],
        registry,
      ),
    ).toMatchObject([
      { type: 'function_call', name: 'read.file' },
      { type: 'custom_tool_call', name: 'apply.patch', input: 'patch' },
      { type: 'function_call', name: 'get.current', namespace: 'mcp.time' },
    ]);

    expect(
      responsesInputForUpstream([
        { type: 'function_call', name: 'read.file', arguments: '{}' },
        { type: 'custom_tool_call', name: 'apply.patch', input: 'patch' },
        { type: 'function_call', name: 'get.current', namespace: 'mcp.time', arguments: '{}' },
      ]),
    ).toMatchObject([
      { type: 'function_call', name: 'read_file', arguments: '{}' },
      { type: 'function_call', name: 'apply_patch', arguments: '{"input":"patch"}' },
      { type: 'function_call', name: 'mcp_time__get_current', arguments: '{}' },
    ]);
  });

  it('rejects transformed-name collisions and unsupported tool types', () => {
    expect(() =>
      transformResponsesTools([
        { type: 'function', name: 'same.name' },
        { type: 'custom', name: 'same_name' },
      ]),
    ).toThrow('Transformed tool name collision: same_name');

    expect(() => transformResponsesTools([{ type: 'computer_use_preview', name: 'computer' }])).toThrow(
      'Unsupported Responses tool type: computer_use_preview',
    );
  });

  it.each(['take_screenshot', 'mcp__chrome_devtools__take_screenshot'])(
    'filters both MCP declaration shapes with exclusion %s',
    (excludedName) => {
      for (const flat of [false, true]) {
        const tools: ResponsesTool[] = [
          ...(flat
            ? [{ type: 'function', name: 'mcp__chrome_devtools__take_screenshot' }]
            : [{ type: 'namespace', name: 'mcp__chrome_devtools', tools: [{ name: 'take_screenshot' }] }]),
          { name: 'take_screenshot' },
          { name: 'mcp__other__take_screenshot' },
          { name: 'mcp__chrome_devtools_extra__take_screenshot' },
          { name: 'mcp__chrome_devtools__navigate' },
        ];
        const { responseTools } = transformResponsesTools(tools, {
          excludedMcpTools: [{ namespace: 'mcp__chrome_devtools', tools: [excludedName] }],
        });
        expect(responseTools.map((tool) => tool.name)).toEqual([
          'take_screenshot',
          'mcp__other__take_screenshot',
          'mcp__chrome_devtools_extra__take_screenshot',
          'mcp__chrome_devtools__navigate',
        ]);
      }
    },
  );

  it('uses the same sanitization for flat MCP tools and exclusions', () => {
    expect(
      transformResponsesTools([{ name: 'mcp.chrome__take.screenshot' }], {
        excludedMcpTools: [{ namespace: 'mcp.chrome', tools: ['take.screenshot'] }],
      }).responseTools,
    ).toEqual([]);
  });

  it('round-trips namespaced custom tools and translates every choice without aliasing names', () => {
    const custom: ResponsesTool = {
      type: 'custom',
      name: 'apply_patch',
      format: { type: 'grammar', syntax: 'lark', definition: 'start: "patch"' },
    };
    const tools: ResponsesTool[] = [
      custom,
      {
        type: 'namespace',
        name: 'editor.ns',
        description: 'Editor tools',
        tools: [custom, { type: 'custom', name: 'editor_ns__apply_patch' }, { name: 'status' }],
      },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);
    expect(responseTools.map((tool) => tool.name)).toEqual([
      'apply_patch',
      'editor_ns__apply_patch',
      'editor_ns__editor_ns__apply_patch',
      'editor_ns__status',
    ]);
    expect(responseTools[1]?.description).toContain('Editor tools');
    expect(responseTools[1]?.description).toContain('start: "patch"');
    expect(responseTools[1]?.description).toContain('*** Begin Patch');
    expect(responseTools[1]?.parameters).toMatchObject({ required: ['input'], additionalProperties: false });

    const choices = [
      { type: 'custom', name: 'apply_patch' },
      { type: 'custom', namespace: 'editor.ns', name: 'apply_patch' },
      { type: 'custom', namespace: 'editor.ns', name: 'editor_ns__apply_patch' },
    ];
    const output = choices.map((_choice, index) => ({
      type: 'function_call',
      id: `item_${String(index)}`,
      call_id: `call_${String(index)}`,
      name: responseTools[index]?.name,
      arguments: '{"input":"patch"}',
      status: 'completed',
    }));
    const mapped = mapUpstreamOutput(output, registry);
    expect(mapped).toMatchObject(choices.map((choice) => ({ ...choice, type: 'custom_tool_call', input: 'patch' })));
    expect(responsesInputForUpstream(mapped)).toEqual(output);
    const expectedChoices = output.map(({ name }) => ({ type: 'function', name }));
    for (const [index, choice] of choices.entries()) {
      expect(responsesRequestForUpstream({ model: 'qwen', tool_choice: choice }, responseTools, false, registry).tool_choice).toEqual(
        expectedChoices[index],
      );
    }
    for (const mode of ['auto', 'required']) {
      expect(
        responsesRequestForUpstream(
          { model: 'qwen', tool_choice: { type: 'allowed_tools', mode, tools: choices } },
          responseTools,
          true,
          registry,
        ).tool_choice,
      ).toEqual({ type: 'allowed_tools', mode, tools: expectedChoices });
    }
    expect(tools[1]?.tools?.[0]).toEqual(custom);
  });

  it.each(['web_search', 'web_search_preview'])('rejects hosted %s definitions and choices', (type) => {
    expect(() => transformResponsesTools([{ type }])).toThrow('Hosted web search requires a webSearchTool mapping');
    expect(() => responsesRequestForUpstream({ model: 'qwen', tool_choice: { type } }, [])).toThrow('an available Codex MCP search tool');
    expect(() =>
      responsesRequestForUpstream({ model: 'qwen', tool_choice: { type: 'allowed_tools', mode: 'auto', tools: [{ type }] } }, []),
    ).toThrow('Hosted web search requires a webSearchTool mapping');
  });

  it.each([false, true])('maps hosted search to an advertised MCP tool without inventing a client tool (flat=%s)', (flat) => {
    const searchTool: ResponsesTool = {
      type: 'function',
      name: flat ? 'mcp__search__find' : 'find',
      parameters: { type: 'object', properties: { search_terms: { type: 'string' } }, required: ['search_terms'] },
    };
    const tools: ResponsesTool[] = [
      { type: 'web_search' },
      flat ? searchTool : { type: 'namespace', name: 'mcp__search', tools: [searchTool] },
      { type: 'web_search_preview' },
    ];
    const { responseTools, registry, webSearchToolName } = transformResponsesTools(tools, {
      webSearchTool: { namespace: 'mcp__search', tool: 'find' },
    });
    expect(webSearchToolName).toBe('mcp__search__find');
    expect(responseTools).toHaveLength(1);
    expect(responseTools[0]).toMatchObject({ type: 'function', name: webSearchToolName, parameters: searchTool.parameters });
    for (const type of ['web_search', 'web_search_preview']) {
      expect(
        responsesRequestForUpstream({ model: 'qwen', tools, tool_choice: { type } }, responseTools, false, registry, webSearchToolName)
          .tool_choice,
      ).toEqual({ type: 'function', name: webSearchToolName });
      expect(
        responsesRequestForUpstream(
          { model: 'qwen', tools, tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type }] } },
          responseTools,
          true,
          registry,
          webSearchToolName,
        ).tool_choice,
      ).toEqual({ type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: webSearchToolName }] });
    }
    const call = { type: 'function_call', name: webSearchToolName, call_id: 'search', arguments: '{"search_terms":"test"}' };
    const mapped = mapUpstreamOutput([call], registry);
    expect(mapped[0]).toMatchObject(flat ? call : { ...call, name: 'find', namespace: 'mcp__search' });
    expect(responsesInputForUpstream(mapped)).toEqual([call]);
  });

  it.each([false, true])('rejects missing, mismatched, or excluded MCP search targets (flat=%s)', (flat) => {
    const tools: ResponsesTool[] = [
      flat ? { name: 'mcp__search__search' } : { type: 'namespace', name: 'mcp__search', tools: [{ name: 'search' }] },
      { type: 'web_search' },
    ];
    for (const options of [
      { webSearchTool: { namespace: 'mcp__missing', tool: 'search' } },
      { webSearchTool: { namespace: 'mcp__search', tool: 'missing' } },
      { webSearchTool: { namespace: 'mcp__search', tool: 'search' }, excludedMcpTools: [{ namespace: 'mcp__search', tools: ['search'] }] },
    ]) {
      expect(() => transformResponsesTools(tools, options)).toThrow('an available Codex MCP search tool');
    }
  });

  it('still permits client-executed functions named web_search', () => {
    const { responseTools, registry } = transformResponsesTools([{ type: 'function', name: 'web_search' }]);
    expect(responseTools).toMatchObject([{ type: 'function', name: 'web_search' }]);
    expect(mapUpstreamOutput([{ type: 'function_call', name: 'web_search', arguments: '{}' }], registry)).toEqual([
      { type: 'function_call', name: 'web_search', arguments: '{}' },
    ]);
  });

  it('rejects malformed and aliased selectors rather than selecting a different retained tool', () => {
    const tools: ResponsesTool[] = [
      { name: 'read.file' },
      { name: 'ordinary' },
      { type: 'custom', name: 'patch' },
      { type: 'namespace', name: 'ns', tools: [{ name: 'run' }] },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);
    for (const tool_choice of [
      null,
      [],
      true,
      42,
      'bogus',
      {},
      { type: 'function' },
      { type: 'function', name: ' ' },
      { type: 'function', name: 'read_file' },
      { type: 'function', name: 'ns__run' },
      { type: 'custom', name: 'ordinary' },
      { type: 'function', name: 'patch' },
      { type: 'function', name: 'ordinary', namespace: {} },
      { type: 'unknown', name: 'ordinary' },
    ]) {
      expect(
        () => responsesRequestForUpstream({ model: 'qwen', tools, tool_choice }, responseTools, false, registry),
        JSON.stringify(tool_choice),
      ).toThrow();
    }
    for (const tool_choice of ['auto', 'none', 'required']) {
      expect(responsesRequestForUpstream({ model: 'qwen', tools, tool_choice }, responseTools, false, registry).tool_choice).toBe(
        tool_choice,
      );
    }
    expect(() => responsesRequestForUpstream({ model: 'qwen', tools: [], tool_choice: 'required' }, [])).toThrow();
  });

  it('round-trips namespace tools whose original names include the namespace prefix', () => {
    const { responseTools, registry } = transformResponsesTools([
      { type: 'namespace', name: 'ns', tools: [{ name: 'run' }, { name: 'ns__run' }] },
    ]);
    const output = responseTools.map((tool, index) => ({
      type: 'function_call',
      name: tool.name,
      arguments: '{}',
      call_id: `call_${String(index)}`,
    }));
    expect(output.map((item) => item.name)).toEqual(['ns__run', 'ns__ns__run']);
    expect(responsesInputForUpstream(mapUpstreamOutput(output, registry))).toEqual(output);
  });

  it('keeps malformed custom arguments available as raw input', () => {
    const { registry } = transformResponsesTools([{ type: 'custom', name: 'apply_patch' }]);
    expect(mapUpstreamOutput([{ type: 'function_call', name: 'apply_patch', arguments: 'not-json' }], registry)).toMatchObject([
      { type: 'custom_tool_call', input: 'not-json' },
    ]);
    expect(mapUpstreamOutput([{ type: 'function_call', name: 'apply_patch', arguments: '"text"' }], registry)).toMatchObject([
      { type: 'custom_tool_call', input: '"text"' },
    ]);
  });

  it('derives output text only when upstream omitted it', () => {
    const response: ResponsesResponse = {
      id: 'response',
      object: 'response',
      model: 'qwen',
      status: 'completed',
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'one' }, null, { type: 'output_text', text: ' two' }] },
        { type: 'reasoning', content: [{ text: 'hidden' }] },
      ],
    };
    expect(mapUpstreamResponse(response, new Map()).output_text).toBe('one two');
    expect(mapUpstreamResponse({ ...response, output_text: 'provided' }, new Map()).output_text).toBe('provided');
  });

  it('preserves requests without tools and primitive input values', () => {
    const request: ResponsesRequest = { model: 'qwen', input: 0, metadata: { trace: true } };
    expect(responsesRequestForUpstream(request, [])).toEqual({ ...request, stream: false });
    expect(responsesInputForUpstream(null)).toBeNull();
    expect(responsesInputForUpstream([null, 'text', 1, { role: 'user', content: 'hello' }])).toEqual([
      null,
      'text',
      1,
      { role: 'user', content: 'hello' },
    ]);
  });

  it('maps forced tool choices to their transformed upstream names', () => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'read.file' },
      { type: 'custom', name: 'apply.patch' },
      {
        type: 'namespace',
        name: 'mcp.time',
        tools: [{ type: 'function', name: 'get.current' }],
      },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);

    expect(
      responsesRequestForUpstream(
        { model: 'qwen', tools, tool_choice: { type: 'function', name: 'read.file' } },
        responseTools,
        false,
        registry,
      ).tool_choice,
    ).toEqual({ type: 'function', name: 'read_file' });
    expect(
      responsesRequestForUpstream(
        { model: 'qwen', tools, tool_choice: { type: 'custom', name: 'apply.patch' } },
        responseTools,
        false,
        registry,
      ).tool_choice,
    ).toEqual({ type: 'function', name: 'apply_patch' });
    expect(
      responsesRequestForUpstream(
        {
          model: 'qwen',
          tools,
          tool_choice: { type: 'function', name: 'get.current', namespace: 'mcp.time' },
        },
        responseTools,
        false,
        registry,
      ).tool_choice,
    ).toEqual({ type: 'function', name: 'mcp_time__get_current' });
  });

  it.each(['auto', 'required'])('translates every allowed tool in %s mode', (mode) => {
    const tools: ResponsesTool[] = [
      { type: 'function', name: 'read.file' },
      { type: 'custom', name: 'apply_patch' },
      { type: 'namespace', name: 'mcp.time', tools: [{ name: 'now' }] },
    ];
    const { responseTools, registry } = transformResponsesTools(tools);
    const toolChoice = {
      type: 'allowed_tools',
      mode,
      tools: [
        { type: 'function', name: 'read.file' },
        { type: 'custom', name: 'apply_patch' },
        { type: 'function', namespace: 'mcp.time', name: 'now' },
      ],
    };
    for (const stream of [false, true]) {
      expect(
        responsesRequestForUpstream({ model: 'qwen', tools, tool_choice: toolChoice }, responseTools, stream, registry).tool_choice,
      ).toEqual({
        type: 'allowed_tools',
        mode,
        tools: [
          { type: 'function', name: 'read_file' },
          { type: 'function', name: 'apply_patch' },
          { type: 'function', name: 'mcp_time__now' },
        ],
      });
    }
    expect(toolChoice.tools[1]?.type).toBe('custom');
    expect(toolChoice.tools[2]?.namespace).toBe('mcp.time');
  });

  it.each([
    { mode: 'none', tools: [{ type: 'function', name: 'tool' }] },
    { mode: 'auto', tools: {} },
    { mode: 'auto', tools: [] },
    { mode: 'auto', tools: [null] },
    { mode: 'auto', tools: [[]] },
    { mode: 'auto', tools: [{ type: 'custom', name: '' }] },
    { mode: 'auto', tools: [{ type: 'function' }] },
    { mode: 'auto', tools: [{ type: 'unknown', name: 'tool' }] },
  ])('rejects invalid allowed-tools choices: $mode / $tools', (choice) => {
    expect(() => responsesRequestForUpstream({ model: 'qwen', tool_choice: { type: 'allowed_tools', ...choice } }, [])).toThrow();
  });

  it('uses default function schemas and combines namespace descriptions', () => {
    const { responseTools } = transformResponsesTools([
      {
        type: 'namespace',
        name: 'mcp__time',
        description: 'Server description',
        tools: [{ name: 'now', description: 'Tool description', strict: false }],
      },
    ]);
    expect(responseTools[0]).toMatchObject({
      type: 'function',
      name: 'mcp__time__now',
      description: 'Server description\n\nTool description',
      strict: false,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
    });
  });

  it.each([
    { response: new Response('not-json'), message: 'Upstream returned invalid JSON' },
    { response: Response.json({ status: 'completed' }), message: 'Upstream returned an invalid Responses object' },
  ])('rejects malformed non-streaming upstream responses', async ({ response, message }) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response);
    await expect(
      completeResponses(
        { model: 'qwen', input: 'hello' },
        { listen: { host: '127.0.0.1', port: 0 }, upstream: { baseUrl: 'http://llama.invalid/v1' } },
      ),
    ).rejects.toThrow(message);
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockRestore();
  });
});
