# badgr-auto

Open-source local proxy that safely removes exact repeated structured context, optionally routes requests across models, and provides visibility into token savings—without changing your existing AI workflow.

Works with Cline, Continue, Aider, OpenClaw, Open WebUI, and any OpenAI-compatible tool.

[Docs](https://aibadgr.com/docs/badgr-auto) · [GitHub](https://github.com/michaelmanly/badgr-auto) · [AI Badgr](https://aibadgr.com)

**VS Code extension:** [extensions/vscode](extensions/vscode/README.md)

## Install

```bash
npm install -g badgr-auto
badgr-auto start
```

## One-time setup

Point any OpenAI-compatible tool at the local proxy:

```text
Base URL: http://localhost:51999/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

The setup wizard runs automatically on first start. Run `badgr-auto start --setup` to re-run it.

## What it does

| Feature | Default | Flag |
|---------|---------|------|
| Token optimization | on | `--no-optimize` |
| Smart routing | off | `--no-route` to keep off |
| Local models (Ollama / LM Studio) | off | enable in setup |
| Savings tracking | on | always on |

**Token optimization** deduplicates exact repeated blocks—code, diffs, logs, retrieved docs—and summarizes older messages above 12 K tokens. System messages, tool calls, function schemas, and git working-tree output are never touched.

**Smart routing** routes requests to the cheapest suitable model tier (local → OSS cloud → premium) based on task complexity and token count. Requires an AI Badgr account.

**Context health** warns at 60% ("compact soon") and 75% ("compact now") of the model's context window. Visible in `badgr-auto monitor` and per-request receipts.

**Passthrough mode** (both off): requests forward unchanged to your upstream. Zero transformation, zero overhead.

## Verified integrations

End-to-end tested and confirmed working:

- **[Cline](docs/setup-guides.md#cline)**
- **[Continue](docs/setup-guides.md#continue)**
- **[Aider](docs/setup-guides.md#aider)**
- **[OpenClaw](docs/setup-guides.md#openclaw)**
- **[Open WebUI](docs/setup-guides.md#open-webui)**
- **OpenAI SDK** — set `base_url` and `api_key`, any model name

Full setup instructions: **[docs/setup-guides.md](docs/setup-guides.md)**

## Commands

```bash
# Proxy lifecycle
badgr-auto start              # start the proxy (setup wizard on first run)
badgr-auto start --setup      # re-run the setup wizard
badgr-auto stop               # stop the proxy
badgr-auto restart            # restart with current config
badgr-auto status             # proxy status and routing config

# Observability
badgr-auto stats              # token savings summary (all time)
badgr-auto stats 1d           # last 24 hours
badgr-auto stats 7d           # last 7 days
badgr-auto monitor            # live request monitor
badgr-auto receipts           # per-request receipt list
badgr-auto receipts --failed  # errors only
badgr-auto receipts --fallback  # fallback requests only
badgr-auto receipt <id>       # routing diagnosis for one request
badgr-auto receipt <id> --export  # plain-text support bundle
badgr-auto dashboard          # open the AI Badgr cloud dashboard

# Auth
badgr-auto login              # interactive — paste API key from aibadgr.com
badgr-auto login --api-key <key>  # non-interactive
badgr-auto login --ci         # read BADGR_API_KEY from env (for CI/scripts)

# Models & routing
badgr-auto models             # list detected local models
badgr-auto select             # switch model tier interactively

# Eval (shadow mode)
badgr-auto eval               # list stored eval payloads
badgr-auto eval <id>          # replay original vs optimized, show safety verdict

# Context handoff
badgr-auto new-task           # interactive wizard — saves task-handoff-*.md
badgr-auto new-task --template  # print blank handoff template
```

## Shadow eval mode

Sample a fraction of requests to validate optimization safety. On each sampled request, both the original and optimized messages are replayed against your model. `badgr-auto eval <id>` shows a safe/unsafe verdict with per-check breakdown (tool calls, missing-context complaints, output similarity).

```bash
badgr-auto start --eval-sample 0.05   # sample 5% of requests
badgr-auto eval                        # list stored payloads
badgr-auto eval 42                     # show verdict for request #42
```

## CI / non-interactive login

```bash
# Save key directly
badgr-auto login --api-key sk-...

# Read from env (CI pipelines)
BADGR_API_KEY=sk-... badgr-auto login --ci
```

## Requirements

- Node.js 20.10.0 or newer
- Optional: `npm install -g tiktoken` for more accurate token counts

## Links

- **Docs:** [aibadgr.com/docs/badgr-auto](https://aibadgr.com/docs/badgr-auto)
- **Source:** [github.com/michaelmanly/badgr-auto](https://github.com/michaelmanly/badgr-auto)
- **Issues:** [github.com/michaelmanly/badgr-auto/issues](https://github.com/michaelmanly/badgr-auto/issues)

## License

[MIT](LICENSE)
