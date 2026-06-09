# badgr-auto

Local AI proxy for Cline, Continue, Aider, and any OpenAI-compatible tool. Reduces token usage, compresses long sessions, and routes requests to the cheapest suitable model.

[Docs](https://aibadgr.com/docs/badgr-auto) · [GitHub](https://github.com/michaelmanly/badgr-auto) · [AI Badgr](https://aibadgr.com)

## Install

```bash
npm install -g badgr-auto
badgr-auto start
```

Use `-g` so `badgr-auto` is on your PATH. Without it, run `npx badgr-auto start`.

## Connect your tool

Point any OpenAI-compatible client at the local proxy:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

For cloud-only use (no local proxy), point directly at `https://aibadgr.com/v1` with the same key.

## Setup guides

Step-by-step setup for Cline, Continue, Aider, Cursor, Zed, Roo Code, Kilo Code, Open WebUI, LibreChat, SillyTavern, AnythingLLM, Dify, Flowise, LangChain, LlamaIndex, n8n, CrewAI, AutoGen, and more:

→ **[docs/setup-guides.md](docs/setup-guides.md)** — in this repo  
→ **[aibadgr.com/docs/badgr-auto](https://aibadgr.com/docs/badgr-auto)** — full docs site

## Commands

```bash
badgr-auto start    # start the proxy (runs setup on first run)
badgr-auto stop     # stop the proxy
badgr-auto restart  # restart with current config
badgr-auto status   # show proxy status and routing config
badgr-auto stats    # show token savings (1d / 7d / all)
badgr-auto login    # save or update your AI Badgr API key
badgr-auto models   # list detected local models
```

## Requirements

- Node.js 20.10.0 or newer
- Optional: `npm install -g tiktoken` for more accurate token counts

## Links

- **Docs:** [aibadgr.com/docs/badgr-auto](https://aibadgr.com/docs/badgr-auto)
- **Source:** [github.com/michaelmanly/badgr-auto](https://github.com/michaelmanly/badgr-auto)
- **Issues:** [github.com/michaelmanly/badgr-auto/issues](https://github.com/michaelmanly/badgr-auto/issues)

## License

MIT
