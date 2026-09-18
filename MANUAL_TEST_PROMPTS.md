# Manual test prompts

Use these prompts with Codex configured to send Responses requests to the bridge. They cover the bridge-specific behavior that upstream llama.cpp should not need to implement directly.

## Simple response

```text
Reply with exactly: bridge-ok
```

Expected: no tool calls; `/v1/responses` returns a normal assistant message.

## Custom `apply_patch`

```text
Create a file named bridge-smoke.txt containing exactly "hello from bridge".

Important: this is a bridge smoke test for the custom apply_patch tool. Use apply_patch for the file creation. Do not use shell commands or command execution tools such as echo, printf, cat, tee, python, node, perl, sed, or touch.
```

Expected: Codex sends a custom `apply_patch` tool, the bridge exposes it to llama.cpp as a function with freeform patch instructions, and Codex applies the returned patch. In YOLO mode, Codex may otherwise choose a shell command for simple file creation, which does not exercise this bridge path.

## Web search through a mapped MCP tool

Configure a search MCP server in Codex and set `webSearchTool` in the bridge config to its namespace and tool name.
For the generated examples, the server is `search`, its namespace is `mcp__search`, and its tool is `search`.

```text
Search the web for the current llama.cpp GitHub repository description and summarize it in one sentence.
```

Expected: the hosted search declaration resolves to the configured MCP function, the model calls that function using its actual schema,
and Codex executes the search and follows up with the result. There should be no `unsupported call: web_search` result.

Remove the mapping or exclude its target and retry: expected HTTP 400 with guidance about the required `webSearchTool` mapping.

## Time MCP namespace

```text
Use the time MCP tool to tell me the current time in UTC.
```

Expected: Codex exposes the configured `time` MCP server, the bridge translates it to a function tool such as `mcp__time__get_current_time`, then maps the returned call back so Codex executes it.

## Fetch MCP namespace

```text
Fetch https://example.com with the fetch MCP tool and tell me the page title or main heading.
```

Expected: Codex executes the configured fetch MCP tool after the bridge maps the model's function call back to a Responses tool call.

## Chrome DevTools MCP namespace

```text
Use Chrome DevTools MCP to list the open pages, then evaluate document.title on the active page.
```

Expected: Codex routes calls to the configured `chrome_devtools` MCP server. When running in the container, ensure the DevTools target is reachable via the configured host/IP.

## Tool loop follow-up

```text
Search the web for one fact about Qwen models, then use that result to answer without calling any more tools.
```

Expected: Codex executes the first tool call, sends the result back through the bridge as Responses tool history, and the next upstream request can produce final text instead of looping on tool calls.

## Container connectivity smoke

```text
Check whether the bridge can answer a basic request and then create bridge-container-smoke.txt with "ok".

Use apply_patch for the file creation. Do not use shell commands or command execution tools.
```

Expected: verifies both bridge reachability from the Codex container and custom tool mapping.
