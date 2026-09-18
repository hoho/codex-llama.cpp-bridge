# codex-llama.cpp-bridge

Run OpenAI Codex against llama.cpp's native Responses endpoint.

The bridge exposes `/v1/responses` to Codex, translates Codex-specific Responses tool extensions to ordinary Responses function tools, and forwards model requests to upstream llama.cpp `/v1/responses`. Native reasoning deltas are forwarded as they arrive. Qwen can omit assistant message phases, so the bridge buffers message lifecycles and infers missing phases from their position relative to tool calls. If Qwen starts a tool before completing its preceding messages, the bridge retains all interleaved text and waits for the actual message completions before forwarding the tool. It does not synthesize early completions or discard later text. The resulting events let Codex restore `Working...` after commentary without injecting additional assistant messages. Custom-tool argument events are buffered until the completed call can be converted back to Codex's `custom_tool_call` shape. Codex remains responsible for executing MCP and custom tools, including searches routed to a configured MCP search tool.

## Requirements

- Node.js 22 or newer.
- OpenAI Codex CLI.
- A llama.cpp server whose native `/v1/responses` endpoint supports ordinary function tools.
- A Codex-configured MCP search server when using the web-search mapping in the generated examples.

## Install and run

Install the package globally with pnpm:

```sh
pnpm add --global codex-llama.cpp-bridge
```

Create editable bridge and Codex config examples in the current directory:

```sh
mkdir codex-llama.cpp
cd codex-llama.cpp
codex-llama.cpp-bridge --init
```

Edit `bridge.config.json` so `upstream` points to the llama.cpp `/v1` endpoint:

```json
{
  "listen": {
    "host": "127.0.0.1",
    "port": 10901
  },
  "maxRequestBodyBytes": 16777216,
  "upstream": "http://127.0.0.1:5656/v1",
  "webSearchTool": {
    "namespace": "mcp__search",
    "tool": "search"
  }
}
```

The examples expect an MCP server exposing a tool named `search`. Change the namespace/tool mapping and the MCP URL below to match
your search server. The bridge does not install or provide that search backend.

Start the bridge and leave it running:

```sh
codex-llama.cpp-bridge ./bridge.config.json
```

Verify it from another terminal:

```sh
curl --fail http://127.0.0.1:10901/health
```

Copy the generated `codex.config.toml` into `~/.codex/config.toml`, or merge its settings into your existing Codex config. Change `model` to the model ID reported by your llama.cpp server:

```toml
model = "Qwen/Qwen3.8-27B"
model_provider = "llama_cpp_bridge"
web_search = "live"

[model_providers.llama_cpp_bridge]
name = "llama.cpp through codex-llama.cpp-bridge"
base_url = "http://127.0.0.1:10901/v1"
wire_api = "responses"
requires_openai_auth = false

[mcp_servers.search]
url = "http://127.0.0.1:5657/mcp"
```

Run Codex normally:

```sh
codex
```

The package also installs `clb` command and `codex-llama-cpp-bridge` command as aliases. Pass `--help` for CLI usage or set `CODEX_LLAMA_CPP_BRIDGE_CONFIG` instead of passing the bridge config path.

The package is deployment-independent: it can run as a standalone host service, a sidecar, or in the same container as Codex.

### DuckDuckGo (`ddg-search`) setup and smoke test

For a concrete search backend, use `nickclyde/duckduckgo-mcp-server`. It exposes `search` with `query`, `max_results`, and optional
`region` arguments. This example uses stdio: Codex starts the Python MCP server directly, so neither a separate HTTP service nor
the bridge's `mcpProxy` setting is required.

Install Python 3.10 or newer and `uv` so `uvx` is on the same `PATH` as Codex. Prepare the MCP environment and check its CLI:

```sh
uvx --with "duckduckgo-mcp-server[browser]" duckduckgo-mcp-server --help
```

Use your configured Python package mirror when required, for example by setting `UV_INDEX_URL` before running `uvx`.
The optional `[browser]` dependency enables the search backend's Chrome TLS impersonation fallback; it does not launch or require
Chrome DevTools. Backend options are documented by the server itself:

```text
https://github.com/nickclyde/duckduckgo-mcp-server
```

In `bridge.config.json`, replace the generic `mcp__search` mapping from the example above:

```json
{
  "webSearchTool": {
    "namespace": "mcp__ddg_search",
    "tool": "search"
  }
}
```

In your active Codex `config.toml`, replace `[mcp_servers.search]` with the following block. Keep the bridge provider, model, and
`web_search = "live"` settings from the main example:

```toml
[mcp_servers.ddg-search]
command = "uvx"
args = ["--with", "duckduckgo-mcp-server[browser]", "duckduckgo-mcp-server"]
startup_timeout_sec = 60
tool_timeout_sec = 60
```

The server key is `ddg-search`, but Codex advertises it as namespace `mcp__ddg_search`. Keep that distinction in the bridge mapping.
For containerized Codex, install Python and `uvx` in the container and make any package-mirror settings available there as well.

Restart the bridge after changing its configuration, then check both configurations:

```sh
curl --fail --silent --show-error http://127.0.0.1:10901/health
codex mcp get ddg-search
```

Health must report `"webSearchTool":{"namespace":"mcp__ddg_search","tool":"search"}`. These checks confirm configuration only, not
successful search execution. Start a new Codex session and submit:

```text
Search the web for "llama.cpp repository", requesting at most 3 results. Verify that the returned results include the ggml-org/llama.cpp GitHub repository, then finish with DDG_SEARCH_OK. Do not use a shell, fetch webpages, or modify files. If the search fails or returns no results, report that failure instead of printing the success marker.
```

A pass requires a completed `ddg-search.search` call, actual returned repository results, and `DDG_SEARCH_OK` in the final answer.
The tool call should use arguments such as `{"query":"ggml-org llama.cpp repository","max_results":3}`. A configuration check or
a success marker without search results is not sufficient.

If search returns no results, retry a more specific query or wait before retrying. Verify that `[browser]` is installed; to force
that backend, append `"--search-backend", "curl"` to the MCP `args` array. For certificate failures behind a corporate proxy, configure
the server's `DDG_CA_CERTS` with the trusted CA bundle rather than disabling certificate verification.
An HTTP 400 mentioning `webSearchTool` instead indicates a missing mapping, an unavailable/disabled MCP target, or an excluded search
tool. There should never be an `unsupported call: web_search` result: Codex executes the mapped MCP tool, not a synthetic local
function named `web_search`.

If you already run this MCP server over Streamable HTTP, use its actual endpoint instead of `command` and `args`:

```toml
[mcp_servers.ddg-search]
url = "http://127.0.0.1:5657/mcp"
```

For example, that endpoint can be served by:

```sh
uvx --with "duckduckgo-mcp-server[browser]" duckduckgo-mcp-server \
  --transport streamable-http --host 127.0.0.1 --port 5657
```

Alternatively, an existing MCP aggregator can use the bridge's `/mcp/ddg-search` relay with `mcpProxy` configured as described below.
Use only one transport configuration for `ddg-search`; the namespace/tool mapping and acceptance criteria stay the same.

## Configuration

`listen` defaults to `127.0.0.1:10901`. `maxRequestBodyBytes` limits buffered Responses and MCP request bodies and defaults
to 16777216 bytes (16 MiB). Requests over the limit receive HTTP 413. `upstream` must be the llama.cpp API base URL ending in `/v1`.
URL settings accept either a string or an object with `baseUrl`. They must use HTTP or HTTPS and must not contain embedded
credentials, query strings, or fragments. Invalid configuration shapes fail at startup instead of silently falling back to defaults.

When `mcpProxy` is configured, `/mcp/<server>` forwards Streamable HTTP MCP traffic to `<mcpProxy>/<server>/mcp`. Network routing and any port forwarding remain deployment concerns outside this standalone package.

`webSearchTool` explicitly maps hosted `web_search` / `web_search_preview` declarations to a tool already exposed by Codex's MCP
configuration. Use the model-visible namespace and tool name that Codex advertises. For `[mcp_servers.search]`, the namespace is
`mcp__search`; a server key such as `ddg-search` becomes `mcp__ddg_search` because Codex normalizes punctuation before advertising tools.
The target must be available in the request and not excluded. Missing mappings or unavailable targets receive HTTP 400.
Both namespaced MCP definitions and already-flattened MCP function definitions are supported.

The bridge uses the target's actual name and parameter schema rather than inventing a local `web_search` function. Forced hosted-search
choices and hosted-search entries in `tool_choice.allowed_tools` select that same target. Codex executes the MCP call and sends its result
back as ordinary tool history. Search calls appear as MCP calls, not OpenAI-hosted `web_search_call` events.

This mapping opts into the MCP server's search behavior. It does not reproduce OpenAI's hosted cache, `cached`/`live` policy, citation
annotations, or hosted options such as location and domain filters; configure those capabilities through the MCP tool instead.
For deployments without search, omit the mapping and remove the hosted search tool from the Codex request.

`GET /health` reports the adapter protocol, whether the MCP relay is enabled, and the active upstream, MCP relay, request-size,
tool-exclusion, and web-search mapping configuration. Client disconnects abort active streaming and non-streaming llama.cpp generation
and MCP relay processes so abandoned turns do not retain model or process capacity. Rejected or malformed upstream streams are also aborted.

Manual smoke-test prompts live in [`MANUAL_TEST_PROMPTS.md`](./MANUAL_TEST_PROMPTS.md).

## Development

```sh
pnpm install
pnpm run ci
```

The package is TypeScript-first, built with tsdown, tested with Vitest coverage, formatted with Prettier, and linted with ESLint.
Coverage thresholds are enforced per source file: 94% statements, 80% branches, 100% functions, and 95% lines.

`pnpm test:e2e` builds the package and runs the real Codex CLI against the built bridge, a local synthetic Responses server, and a local
MCP search fixture. It covers multiple assistant messages, actual `apply_patch` file creation and history replay, MCP searches through
the relay, missing search mappings, and upstream stream cleanup. It also runs in `pnpm run ci`.

The E2E suite uses isolated temporary homes/workspaces and an explicit offline model catalog advertising custom-tool support.
It requires no API keys or live model/search services and does not measure llama.cpp model quality.

Codex is pinned as a development dependency, not a runtime dependency. Installation and version queries honor the registry configured
in `.npmrc`. To update it, inspect `pnpm view @openai/codex versions --json`, choose the newest cross-platform stable release, then run
`pnpm add -D -E @openai/codex@<version>` and CI. Do not blindly use `latest` if the configured registry resolves that tag to a
platform-specific build or prerelease.

Inspect exactly what will be published:

```sh
pnpm pack --dry-run
```

Publish the current version to the public npm registry:

```sh
pnpm run publish:npm
```

The publish script runs the complete CI check through `prepublishOnly`, and `prepack` rebuilds `dist`.

## Architecture contract

The bridge is intentionally the only place that knows about Codex-specific Responses extensions. Upstream llama.cpp remains a normal native Responses server.

Codex talks to the bridge:

```text
Codex /v1/responses
  -> codex-llama.cpp-bridge
  -> llama.cpp /v1/responses
```

Tool handling:

| Codex Responses tool                   | Bridge behavior                                                                                       | llama.cpp requirement      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| `custom` / `apply_patch`               | Convert to a function with an `input` string and map model calls back to `custom_tool_call` for Codex | Responses function calling |
| `namespace` with function/custom tools | Flatten names, then restore the original namespace, name, and function/custom call shape for Codex    | Responses function calling |
| `web_search` / `web_search_preview`    | Select the configured `webSearchTool` MCP function; Codex executes it                                 | Responses function calling |

`excludedMcpTools` removes selected MCP tools from both namespaced and already-flattened function declarations. The bridge still leaves MCP execution to Codex; filtering only prevents the model from choosing excluded options. Tool names in exclusions can be nested MCP names such as `take_screenshot` or flattened names such as `mcp__chrome_devtools__take_screenshot`:

```json
{
  "excludedMcpTools": [{ "namespace": "mcp__chrome_devtools", "tools": ["screenshot", "take_screenshot"] }]
}
```

Tool names are sanitized only for the upstream llama.cpp request and restored before calls return to Codex. If two client tools would
collapse to the same sanitized name, or Codex sends an unsupported Responses tool type, the bridge returns HTTP 400 rather than routing
the call ambiguously. Forced choices and `tool_choice.allowed_tools` entries receive the same name/type translation as tool definitions.
Selectors that reference unavailable or excluded tools receive HTTP 400 before contacting upstream; the bridge does not silently relax
the caller's tool restrictions.
History items with an explicit `namespace` contain the original tool name, even when that name itself begins with the namespace.
This also applies to namespaced custom tools: the bridge preserves their grammar and namespace through streaming/non-streaming
responses, forced/allowed choices, and follow-up history.

Tool declarations must be objects. Function, custom, and namespace tools require a non-empty string `name`; an omitted `type`
remains shorthand for `function`. Namespace `tools` must be an array of function/custom declarations. Malformed entries and unsupported
nested tool types receive HTTP 400 before any upstream request or streaming headers are sent.
Tool descriptions, schemas, strictness, and custom-format fields are checked for valid JSON field types. Selectors must match the
original tool identity and function/custom type, not another tool's sanitized alias.

Streaming preserves message content and authoritative completion events. When llama.cpp interleaves a tool with an unfinished message,
the bridge buffers those events until the message finishes, then delivers its complete lifecycle before starting the tool for Codex.
Explicit message phases are preserved; missing phases are inferred consistently across the lifecycle and terminal output.
The first `response.completed`, `response.failed`, or `response.incomplete` ends the response and releases the upstream connection;
trailing data cannot change that outcome. A stream that ends without a terminal event produces `response.failed`.

The optional MCP relay forwards end-to-end headers, including MCP session identifiers, but removes hop-by-hop headers and fields
named by `Connection` in both directions. Multiple `Set-Cookie` headers remain separate.

## llama.cpp requirements

The current Qwen 3.8 setup requires upstream llama.cpp to support:

1. `/v1/responses` with ordinary `function` tools.
2. Function-call output items in the native Responses shape.
3. Follow-up `function_call` and `function_call_output` input items.
4. The model/template combination can emit valid function calls for forced tool prompts.

Raw llama.cpp does not need to support Codex's `custom`, `namespace`, or `web_search` tool definitions. The bridge converts custom and
namespace tools and resolves configured web-search mappings while preserving native Responses reasoning, usage, and metadata.

## License

[MIT License](LICENSE).

Copyright (c) 2026 Marat Abdullin.
