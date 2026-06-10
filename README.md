# badgr-auto

Open-source local proxy that safely removes exact repeated structured context, optionally routes requests across models, and provides visibility into token savings—without changing your existing AI workflow.

Works with Cline, Continue, Aider, Open WebUI, and any OpenAI-compatible tool.

[Docs](https://aibadgr.com/docs/badgr-auto) · [GitHub](https://github.com/michaelmanly/badgr-auto) · [AI Badgr](https://aibadgr.com)

## Install

```bash
npm install -g badgr-auto
badgr-auto setup
```

## One-time setup

Point any OpenAI-compatible tool at the local proxy:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

The setup wizard walks through this. Run `badgr-auto setup` to re-run it at any time.

## What it does

| Feature | Default | Flag |
|---------|---------|------|
| Token optimization | on | `--no-optimize` |
| Smart routing | off | `--no-route` to keep off |
| Local models (Ollama / LM Studio) | off | enable in setup |
| Savings tracking | on | configure in setup |

**Token optimization** deduplicates exact repeated blocks—code, diffs, logs, retrieved docs—and summarizes older messages above 12 K tokens. System messages, tool calls, and function schemas are never touched.

**Smart routing** routes requests to the cheapest suitable model tier (local → standard → premium) based on task complexity and token count. Requires an AI Badgr account.

**Passthrough mode** (both off): requests forward unchanged to your upstream. Zero transformation, zero overhead.

## Verified integrations

End-to-end tested and confirmed working:

- **[Cline](docs/setup-guides.md#cline)**
- **[Continue](docs/setup-guides.md#continue)**
- **[Aider](docs/setup-guides.md#aider)**
- **[Open WebUI](docs/setup-guides.md#open-webui)**
- **OpenAI SDK** — set `base_url` and `api_key`, any model name

Full setup instructions: **[docs/setup-guides.md](docs/setup-guides.md)**

## Commands

```bash
badgr-auto setup     # run the setup wizard
badgr-auto start     # start the proxy (wizard on first run)
badgr-auto stop      # stop the proxy
badgr-auto restart   # restart with current config
badgr-auto status    # proxy status and routing config
badgr-auto stats     # token savings (1d / 7d / all)
badgr-auto login     # save or update your AI Badgr API key
badgr-auto monitor   # live request monitor
badgr-auto receipts  # per-request receipts
badgr-auto models    # list detected local models
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
