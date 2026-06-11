# Badgr Auto for VS Code

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/aibadgr.badgr-auto?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-auto)

VS Code companion for [badgr-auto](https://github.com/michaelmanly/badgr-auto): start the local proxy, configure Cline/Continue/Copilot and other tools, and inspect receipts without leaving the editor.

[Docs](https://aibadgr.com/docs/badgr-auto) · [CLI source](https://github.com/michaelmanly/badgr-auto) · [AI Badgr](https://aibadgr.com)

## Install

1. Install the CLI (required):

   ```bash
   npm install -g badgr-auto
   ```

2. Install the extension from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=aibadgr.badgr-auto).

3. Run **Badgr: Setup Wizard** from the Command Palette, or open the **Badgr Auto** sidebar.

## Commands

| Command | Description |
|---------|-------------|
| **Badgr: Setup Wizard** | First-run setup and routing options |
| **Badgr: Start Proxy** | Start the local proxy |
| **Badgr: Stop Proxy** | Stop the proxy |
| **Badgr: Open Monitor** | Open the terminal monitor |
| **Badgr: Show Receipts** | Open the receipts webview |
| **Badgr: Copy Base URL** | Copy `http://localhost:<port>/v1` |
| **Badgr: Configure Tool** | Point a supported tool at the proxy |
| **Badgr: Restore Tool Config from Backup** | Restore a backed-up tool config |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `badgr.port` | `8787` | Proxy port (falls back to `auto-config.json` when unset) |
| `badgr.autoStartProxy` | `false` | Start the proxy when VS Code opens |

## Requirements

- VS Code 1.85+
- Node.js 20.10+
- `badgr-auto` on PATH (`npm install -g badgr-auto`)

## Development

```bash
cd extensions/vscode
npm install
npm run compile
npm run test:unit
npm run package
```

## License

[MIT](LICENSE)
