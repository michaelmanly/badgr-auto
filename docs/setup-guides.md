# badgr-auto — Setup Guides

Setup instructions for every major OpenAI-compatible tool.

**The same three values work everywhere:**

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

For cloud-only use (no local proxy) replace the Base URL with `https://aibadgr.com/v1`.

---

## Table of contents

- [Cline](#cline)
- [Continue](#continue)
- [Aider](#aider)
- [OpenClaw](#openclaw)
- [Open WebUI](#open-webui)
- [LibreChat](#librechat)
- [Cursor](#cursor)
- [Zed](#zed)
- [Roo Code](#roo-code)
- [Kilo Code](#kilo-code)
- [SillyTavern](#sillytavern)
- [AnythingLLM](#anythingllm)
- [Dify](#dify)
- [Flowise](#flowise)
- [LangChain](#langchain)
- [LlamaIndex](#llamaindex)
- [n8n](#n8n)
- [CrewAI](#crewai)
- [AutoGen](#autogen)
- [Custom tools and internal SaaS](#custom-tools-and-internal-saas)

---

## Cline

In Cline's settings, choose **OpenAI Compatible** as the API provider and enter:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model ID: badgr-auto
```

Provider keys (OpenAI, Anthropic, etc.) are managed in the [AI Badgr dashboard](https://aibadgr.com/dashboard), not in Cline.

---

## Continue

Add an OpenAI-compatible model to `~/.continue/config.yaml`:

```yaml
models:
  - name: AI Badgr Auto
    provider: openai
    model: badgr-auto
    apiBase: http://localhost:8787/v1
    apiKey: <YOUR_BADGR_API_KEY>
```

Versions before v1.0 use `~/.continue/config.json` with the same fields.

---

## Aider

Aider uses `OPENAI_*` env vars for OpenAI-compatible providers:

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
aider --model badgr-auto
```

---

## OpenClaw

Add a custom provider in OpenClaw's config, or set env vars before launching:

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
```

Or set **Base URL** and **API Key** directly in the OpenClaw custom provider UI with model `badgr-auto`.

---

## Open WebUI

1. Go to **Admin Settings → Connections → OpenAI**.
2. Click **Add Connection**.
3. Set the URL to `http://localhost:8787/v1` and paste your AI Badgr API key.
4. Save. `badgr-auto` will appear in the model selector.

> If Open WebUI runs in Docker and badgr-auto runs on your host, use `http://host.docker.internal:8787/v1` instead of `localhost`.

---

## LibreChat

Add a custom endpoint to `librechat.yaml`:

```yaml
endpoints:
  custom:
    - name: "AI Badgr Auto"
      apiKey: "${BADGR_API_KEY}"
      baseURL: "http://localhost:8787/v1"
      models:
        default: ["badgr-auto"]
      titleConvo: true
      titleModel: "badgr-auto"
```

Add `BADGR_API_KEY=<YOUR_BADGR_API_KEY>` to your `.env` file, then restart LibreChat.

---

## Cursor

1. Open **Settings** (`Cmd+,` / `Ctrl+,`) and go to **Models**.
2. In the **Override OpenAI Base URL** field enter `http://localhost:8787/v1`.
3. Enter your AI Badgr API key in the **OpenAI API Key** field.
4. Click **+ Add Model** and type `badgr-auto`.
5. Click **Verify** to confirm the connection.

> Note: Cursor's inline edit and autocomplete are locked to Cursor's own backend. The custom endpoint applies to the chat/plan panel only.

---

## Zed

Add to your Zed `settings.json`:

```json
{
  "language_models": {
    "openai": {
      "api_url": "http://localhost:8787/v1",
      "available_models": [
        {
          "name": "badgr-auto",
          "display_name": "AI Badgr Auto",
          "max_tokens": 128000
        }
      ]
    }
  }
}
```

Enter your API key when Zed prompts for it, or set it through the Agent Panel.

---

## Roo Code

In the Roo Code settings panel, choose **OpenAI Compatible** as the API provider:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

---

## Kilo Code

In the Kilo Code settings panel, choose **OpenAI Compatible** as the API provider:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

---

## SillyTavern

1. Open **API Connections** and select **Chat Completion**.
2. Set the **Custom Endpoint** to `http://localhost:8787/v1`.
3. Enter your AI Badgr API key.
4. Set the model name to `badgr-auto`.

Do not append `/chat/completions` — SillyTavern adds that automatically.

---

## AnythingLLM

1. Go to **Settings → LLM Preference**.
2. Choose **Generic OpenAI** as the provider.
3. Set **Base URL** to `http://localhost:8787/v1`.
4. Enter your AI Badgr API key and set the model name to `badgr-auto`.
5. Set the context window size to match your chosen upstream model.

All workspace features — chat, RAG, and agents — work with this configuration.

---

## Dify

1. Go to **Settings → Model Provider → OpenAI-Compatible**.
2. Set the API endpoint to `http://localhost:8787/v1`.
3. Enter your AI Badgr API key and add `badgr-auto` as a model.

You can override the model per app in the Dify app editor.

---

## Flowise

In any **ChatOpenAI** node, expand **Additional Parameters** and set:

```text
Base Path: http://localhost:8787/v1
```

Enter your AI Badgr API key in the node's API key field and use `badgr-auto` as the model name.

---

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="badgr-auto",
    openai_api_key="<YOUR_BADGR_API_KEY>",
    openai_api_base="http://localhost:8787/v1",
)
```

Or use environment variables:

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
```

---

## LlamaIndex

```python
from llama_index.llms.openai_like import OpenAILike

llm = OpenAILike(
    model="badgr-auto",
    api_base="http://localhost:8787/v1",
    api_key="<YOUR_BADGR_API_KEY>",
    is_chat_model=True,
    context_window=128000,
)
```

---

## n8n

1. In your workflow add an **OpenAI** node (or HTTP Request node for full control).
2. Create a credential with **Base URL** set to `http://localhost:8787/v1` and your AI Badgr API key.
3. Set the model to `badgr-auto`.

All n8n AI Agent nodes that accept an OpenAI-compatible credential work the same way.

---

## CrewAI

```python
from crewai import LLM

llm = LLM(
    model="openai/badgr-auto",
    base_url="http://localhost:8787/v1",
    api_key="<YOUR_BADGR_API_KEY>",
)
```

Or use environment variables:

```bash
export OPENAI_API_BASE=http://localhost:8787/v1
export OPENAI_API_KEY=<YOUR_BADGR_API_KEY>
```

---

## AutoGen

**AutoGen 0.2:**

```python
config_list = [
    {
        "model": "badgr-auto",
        "api_key": "<YOUR_BADGR_API_KEY>",
        "base_url": "http://localhost:8787/v1",
    }
]
```

**AutoGen 0.4+:**

```python
from autogen_ext.models.openai import OpenAIChatCompletionClient

client = OpenAIChatCompletionClient(
    model="badgr-auto",
    api_key="<YOUR_BADGR_API_KEY>",
    base_url="http://localhost:8787/v1",
)
```

---

## Custom tools and internal SaaS

Any tool or service that accepts an OpenAI-compatible base URL works with badgr-auto:

```text
Base URL: http://localhost:8787/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

For cloud-only routing without the local proxy:

```text
Base URL: https://aibadgr.com/v1
API Key:  <YOUR_BADGR_API_KEY>
Model:    badgr-auto
```

---

## How keys work

`badgr-auto` uses one key — your **AI Badgr API key**.

| What | Where you set it |
|------|-----------------|
| AI Badgr API key | `badgr-auto login`, or your tool's API key field |
| OpenAI / Anthropic / other provider keys | [AI Badgr dashboard](https://aibadgr.com/dashboard) → Provider Keys (BYOK) |

You never paste raw OpenAI or Anthropic keys into your coding tool or into badgr-auto config.
