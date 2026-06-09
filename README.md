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
Coding tool
→ badgr-auto local proxy
→ remove repeated context safely
→ compress older context when needed
→ classify request
→ choose local, OSS cloud, or premium route
→ stream response back
→ log estimated savings
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

### 1. Create an AI Badgr account

Go to:

```text
https://aibadgr.com/login
```

Sign in and copy your AI Badgr API key from the dashboard.

### 2. Install badgr-auto

From npm:

```bash
npm install -g badgr-auto
```

Or from source: [github.com/michaelmanly/badgr-auto](https://github.com/michaelmanly/badgr-auto)

### 3. Connect your AI Badgr account

```bash
badgr-auto login
```

Paste your AI Badgr API key when prompted.

Your key is validated and stored locally in:

```text
~/.badgr/config.json
```

### 4. Start the local proxy

```bash
badgr-auto start
```

After login, the proxy routes through your saved AI Badgr endpoint (`https://aibadgr.com/v1`) automatically.

You should see:

```text
✓ Badgr Auto running at http://localhost:8787/v1
```

To use a different upstream instead, pass `--upstream`:

```bash
badgr-auto start --upstream https://api.openai.com/v1
```

### 5. Connect your coding tool

Use:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

The proxy uses the API key saved by `badgr-auto login` for upstream authentication. Your coding tool still needs an API key field filled in — use the same AI Badgr key.

Then use your coding tool normally.

---

## Cline setup

In Cline, choose an OpenAI-compatible provider and enter:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model ID: badgr-auto
```

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

---

## Aider setup

Set the OpenAI-compatible API base URL:

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
```

Then use:

```bash
aider --model badgr-auto
```

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

Async GPU execution is planned for a later release. The current alpha focuses on edge, mid-tier, and premium routing.

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
Token savings — Last 7 days

Requests:          1,234
Original tokens:   4,890,120
Optimized tokens:  2,912,450
Tokens saved:      1,977,670
Average reduction: 40.4%
Estimated saved:   $12.34
Local requests:    38%
OSS cloud:         52%
Premium:           10%
Avg latency:       312ms
```

Savings estimates are informational. Actual provider pricing may vary.

When logged in, savings are also sent to your AI Badgr account in the background (fire-and-forget; never blocks responses).

---

## Commands

```bash
badgr-auto login
```

Connect your local proxy to your AI Badgr account.

```bash
badgr-auto start
```

Start the local OpenAI-compatible proxy.

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

Use the localhost endpoint only when you want local optimization, token savings, and optional local-model routing.

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

## Alpha status

`badgr-auto` is currently an alpha release (v0.1.0).

The alpha focuses on:

* OpenAI-compatible local proxy support
* token deduplication
* long-context compression
* SSE streaming passthrough
* edge, OSS, and premium routing
* local savings statistics

Planned improvements include:

* async GPU-job execution
* dashboard savings widgets
* more routing controls
* easier setup integrations
* additional local-model providers

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

Run:

```bash
badgr-auto login
```

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
