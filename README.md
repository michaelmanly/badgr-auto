# badgr-auto

**Local AI proxy for Cline, Continue, Aider, Ollama, LM Studio, and OpenAI-compatible tools. Reduce repeated tokens, compress long sessions, preserve streaming, and route requests intelligently.**

[GitHub](https://github.com/michaelmanly/badgr-auto) · [Docs](https://aibadgr.com/docs/badgr-auto) · [AI Badgr](https://aibadgr.com)

`badgr-auto` is an optional local proxy for [AI Badgr](https://aibadgr.com).

It runs on your computer and gives coding tools a single OpenAI-compatible endpoint:

```text
http://localhost:8787/v1
```

Point Cline, Continue, Aider, or another OpenAI-compatible client at that URL. `badgr-auto` optimizes request context, tracks estimated token savings, and chooses the most suitable route for each task.

```text
Coding tool (one key: your AI Badgr API key)
→ badgr-auto local proxy (dedupe · compress · route)
→ AI Badgr cloud (https://aibadgr.com/v1) — Badgr-managed routing by default
→ optional BYOK from dashboard (OpenAI, Anthropic, etc.) when you add Provider Keys
→ stream response back · log savings
```

## Why use badgr-auto?

Long AI coding sessions often resend the same context repeatedly. That increases token usage, latency, and cost.

`badgr-auto` helps by:

* removing duplicated messages safely
* compressing older context when sessions become large
* preserving system prompts, tool calls, and recent messages
* streaming responses back as tokens arrive
* routing simple requests differently from complex requests
* logging estimated token savings locally
* working with OpenAI-compatible coding tools

## Requirements

* Node.js **20.10.0** or newer
* Optional: install `tiktoken` for more accurate token counts (`npm install -g tiktoken`)

## Quick start

Install once, then let the CLI guide you — **no account required to try local routing**.

```bash
npm install -g badgr-auto
badgr-auto start
```

Use **`-g`** so `badgr-auto` is on your PATH. If you installed without `-g`, run `npx badgr-auto start` instead.

Or from source: [github.com/michaelmanly/badgr-auto](https://github.com/michaelmanly/badgr-auto)

### What `badgr-auto start` does (first run)

Runs only when you have **no saved AI Badgr API key** yet. If you already connected, `start` launches the proxy immediately.

1. **Choose routing mode** — Local only, or Local + cloud (recommended)
2. **Detect local models** — scans Ollama (`:11434`) and LM Studio (`:1234`)
3. **Run a local test** — only when Ollama or LM Studio is running; shows token savings before any signup
4. **Cloud escalation** — if you chose Local + cloud, prompts for your AI Badgr API key inline when cloud routing is needed
5. **Start the proxy** at `http://localhost:8787/v1`

**No local server?** Local-only mode exits with install hints. Local + cloud continues with **cloud-only routing** until you add Ollama or LM Studio.

You only need `badgr-auto login` separately if you skipped the key during setup, or to update your key later.

### Connect your coding tool

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

Use the same AI Badgr API key you copied from the dashboard. That is the **only** key your coding tool needs.

---

## How keys work (important)

`badgr-auto` does **not** ask for your OpenAI, Anthropic, or Claude API keys.

| What | Where you set it |
| ---- | ---------------- |
| **AI Badgr API key** | `badgr-auto login`, guided setup, or your tool's API key field |
| **OpenAI / Anthropic / other provider keys** | [AI Badgr dashboard](https://aibadgr.com/dashboard) → **Provider Keys** (BYOK passthrough) |

Flow:

1. Sign in at [aibadgr.com](https://aibadgr.com/login).
2. Add your provider keys in the dashboard (optional BYOK — routes through your own OpenAI/Anthropic accounts when configured).
3. Copy your **AI Badgr API key** from the dashboard.
4. Paste that key into `badgr-auto` (during `badgr-auto start` or `badgr-auto login`) and into Cline / Continue / Aider.

Cloud requests go: **your tool → badgr-auto → AI Badgr** (Badgr-managed by default). If you add **Provider Keys** in the dashboard, matching requests can use your own OpenAI/Anthropic accounts (optional BYOK). You never paste provider keys into the terminal or into `badgr-auto` config.

Local-only mode (Ollama / LM Studio) can run with **no AI Badgr account** — cloud routing and dashboard sync unlock when you connect your Badgr key.

---

## Cline setup

In Cline, choose an OpenAI-compatible provider and enter:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model ID: badgr-auto
```

Provider keys (OpenAI, Anthropic, etc.) are managed in the [AI Badgr dashboard](https://aibadgr.com/dashboard), not in Cline.

---

## Continue setup

Add an OpenAI-compatible model to your Continue configuration:

```yaml
models:
  - name: AI Badgr Auto
    provider: openai
    model: badgr-auto
    apiBase: http://localhost:8787/v1
    apiKey: <YOUR_BADGR_API_KEY>
```

Provider keys (OpenAI, Anthropic, etc.) are managed in the [AI Badgr dashboard](https://aibadgr.com/dashboard), not in Continue config.

---

## Aider setup

Aider uses env vars named `OPENAI_*` for compatibility — set them to the **proxy** and your **AI Badgr key** (not a raw OpenAI key):

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
aider --model badgr-auto
```

Add OpenAI/Anthropic keys in the [AI Badgr dashboard](https://aibadgr.com/dashboard) under Provider Keys if you use BYOK passthrough.

---

## How routing works

`badgr-auto` does not send every request to the most expensive model.

It evaluates each task and chooses the cheapest suitable route.

| Route            | Best for                  | Examples                                 |
| ---------------- | ------------------------- | ---------------------------------------- |
| **Edge**         | Simple, low-latency tasks | autocomplete, formatting, tiny edits     |
| **Mid-tier OSS** | Normal development work   | refactors, summaries, chat, RAG queries  |
| **Premium**      | Complex or critical tasks | deep debugging, reasoning, final outputs |
| **Async GPU**    | Background workloads      | embeddings, indexing, batch evals        |

Async GPU execution is planned for a later release. Current routing focuses on edge, mid-tier, and premium tiers.

If a preferred tier is not configured (for example, no local edge endpoint), `badgr-auto` falls back to the next available tier.

### Example routing

```text
"Complete this function"
→ edge or local model (when configured)

"Refactor this module"
→ mid-tier OSS model

"Review this architecture for security risks"
→ premium model
```

### Advanced routing configuration

Configure per-tier upstream URLs and models with environment variables:

```bash
export BADGR_AUTO_EDGE_BASE_URL=http://localhost:11434/v1
export BADGR_AUTO_MID_BASE_URL=https://aibadgr.com/v1
export BADGR_AUTO_PREMIUM_BASE_URL=https://aibadgr.com/v1

export BADGR_AUTO_EDGE_MODEL=badgr-auto
export BADGR_AUTO_MID_MODEL=badgr-auto
export BADGR_AUTO_PREMIUM_MODEL=badgr-auto
```

You can also pass flags when starting:

```bash
badgr-auto start --upstream https://aibadgr.com/v1 --threshold 12000 --recent 8
```

Change the listen port with `BADGR_AUTO_PORT` (default `8787`).

---

## Token optimization

Before forwarding a request, `badgr-auto` checks the conversation context.

### Always preserved

The proxy never modifies:

* system-role messages
* tool-role messages
* tool-call JSON
* function schemas
* messages containing `tool_calls`
* messages containing `tool_call_id`
* messages containing `function_call`
* the most recent non-system messages (default: last **8**)

### Deduplicated

Identical repeated messages are removed safely. The most recent copy is preserved.

### Compressed

When the request exceeds the configured token threshold, older non-protected context can be summarized into a smaller context block.

Recent messages remain untouched.

Default compression threshold:

```text
12,000 tokens
```

Each optimized response includes `x-badgr-*` headers with original tokens, optimized tokens, tokens saved, and the selected route tier.

---

## Streaming support

`badgr-auto` preserves OpenAI-compatible streaming responses.

For `stream: true` requests:

* tokens are forwarded as they arrive
* SSE chunks are preserved
* tool-call delta events pass through unchanged
* client disconnects cancel the upstream request
* upstream errors return a clean error response

This keeps Cline, Continue, and Aider responsive during longer requests.

---

## View token savings

Run:

```bash
badgr-auto stats
```

Available periods:

```bash
badgr-auto stats 1d
badgr-auto stats 7d
badgr-auto stats all
```

Example:

```text
Estimated savings — Last 7 days

Token optimisation

Requests:               1,234
Original tokens:        4,890,120
Optimized tokens:       2,912,450
Tokens removed:         1,977,670
Average context reduction: 40.4%

Routing savings

Actual cost:            $4.20

Cost using Claude Haiku:  $12.80
Cost using Claude Sonnet: $48.50

Saved vs Claude Haiku:  $8.60
Saved vs Claude Sonnet: $44.30

Requests routed:
  Local:            38%
  OSS cloud:        52%
  Premium:          10%

Avg latency:            312ms
```

Savings estimates are informational. Actual provider pricing may vary.

When logged in, savings are also sent to your AI Badgr account in the background (fire-and-forget; never blocks responses).

---

## Commands

```bash
badgr-auto start
```

Start the proxy. First run launches **guided setup** (routing mode, local models, optional Badgr key). If already running, shows a menu (instructions, re-run setup, restart, stop).

```bash
badgr-auto setup
```

Re-run the guided setup wizard.

```bash
badgr-auto restart
```

Restart the proxy with your current config.

```bash
badgr-auto login
```

Save or update your **AI Badgr API key** (not OpenAI/Claude keys — those go in the dashboard).

```bash
badgr-auto stop
```

Stop the proxy.

```bash
badgr-auto status
```

Show proxy status and routing configuration.

```bash
badgr-auto stats
badgr-auto stats 1d
badgr-auto stats 7d
```

Show local token-savings statistics.

```bash
badgr-auto models
```

List detected local models when Ollama or LM Studio is running.

```bash
badgr-auto select <model>
```

Save a preferred local model. You still need to point edge routing at your local server, for example:

```bash
export BADGR_AUTO_EDGE_BASE_URL=http://localhost:11434/v1
```

---

## Local models

`badgr-auto` can work with local model servers such as:

* Ollama
* LM Studio
* OpenAI-compatible local inference endpoints

Local models are optional.

When `BADGR_AUTO_EDGE_BASE_URL` is configured, simple requests can stay on your computer for lower latency and `$0` cloud usage.

Normal and complex requests can still move to AI Badgr cloud routes automatically.

---

## Cloud-only mode

You do not need the local proxy to use AI Badgr.

For cloud-only routing, point your app or tool directly at:

```text
Base URL: https://aibadgr.com/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

Same key model: one Badgr API key in your tool; OpenAI/Anthropic keys in the dashboard for BYOK.

Use the localhost endpoint when you want local optimization, token savings, and optional local-model routing.

| Mode                  | Base URL                         |
| --------------------- | -------------------------------- |
| Cloud-only AI Badgr   | `https://aibadgr.com/v1`         |
| Local optimized proxy | `http://localhost:8787/v1`       |

---

## Local logs

Request statistics are stored locally.

On **Node.js 22+**, `badgr-auto` uses:

```text
~/.badgr/auto-requests.sqlite
```

On **Node.js 20–21**, it falls back to:

```text
~/.badgr/auto-requests.jsonl
```

Logged fields may include:

* original token count
* optimized token count
* tokens saved
* selected route
* estimated savings
* latency
* timestamp

Sensitive conversation content is not stored in the savings log.

Proxy configuration is stored in `~/.badgr/auto-config.json`.

---

## Status

Current release (v0.1.x) includes:

* OpenAI-compatible local proxy
* token deduplication and long-context compression
* SSE streaming passthrough
* edge, OSS, and premium routing
* local savings statistics and dashboard sync

Planned: async GPU jobs, more routing controls, additional local-model providers.

---

## Troubleshooting

### Proxy is not running

Start it:

```bash
badgr-auto start
```

Check status:

```bash
badgr-auto status
```

### Cline or Continue cannot connect

Confirm the Base URL is:

```text
http://localhost:8787/v1
```

Confirm your model is:

```text
badgr-auto
```

### API key is missing

Run `badgr-auto login` and paste your **AI Badgr API key** from the [dashboard](https://aibadgr.com/dashboard).

### Cloud models fail or wrong provider

Check **Provider Keys** in the [AI Badgr dashboard](https://aibadgr.com/dashboard). Add or update your OpenAI, Anthropic, or other BYOK keys there — not in `badgr-auto`.

### Use AI Badgr without the proxy

Point your client directly at:

```text
https://aibadgr.com/v1
```

---

## Related AI Badgr products

`badgr-auto` is an optional add-on for AI API users.

AI Badgr also supports controlled GPU workload execution with separate tooling for:

* bounded GPU jobs
* model serving
* spend caps
* runtime limits
* fallback
* teardown
* receipts

Learn more at:

```text
https://aibadgr.com
```

---

## Links

* **Source:** [github.com/michaelmanly/badgr-auto](https://github.com/michaelmanly/badgr-auto)
* **Issues:** [github.com/michaelmanly/badgr-auto/issues](https://github.com/michaelmanly/badgr-auto/issues)
* **Docs:** [aibadgr.com/docs/badgr-auto](https://aibadgr.com/docs/badgr-auto)

## License

MIT

---

## Keywords

OpenAI-compatible proxy, AI coding proxy, Cline proxy, Continue proxy, Aider proxy, Ollama router, LM Studio proxy, local AI router, token optimization, token compression, AI token savings, context deduplication, LLM routing, Claude routing, OSS model routing, AI gateway, local LLM proxy, SSE streaming proxy.
