<div align="right">

[简体中文](./README.md) | **English**

</div>

<div align="center">

# 🛡️ AI Relay Authenticity Detector

### One-click verification of Claude / OpenAI / Gemini relay endpoints

Counterfeit models, protocol tampering, capability downgrades, hidden prompt injection — exposed item by item, with evidence.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PHP](https://img.shields.io/badge/PHP-7.4%2B-777BB4.svg)](https://www.php.net/)
[![Frontend](https://img.shields.io/badge/Frontend-Vanilla%20JS%20(ESM)-f7df1e.svg)](#-tech-stack)
[![No Build](https://img.shields.io/badge/Build-Zero%20config-success.svg)](#-quick-start)

</div>

---

## 📖 What is this

Many people access Claude, OpenAI, and Gemini through "relay / mirror / API aggregator" endpoints — but it's hard to know whether what you're getting is:

- the **real model** or a **cheap small model in disguise** (e.g. GPT-3.5 pretending to be Claude Opus);
- subject to **protocol tampering** (tools stripped, thinking chains faked, system prompts swallowed);
- **cheating on token billing**;
- **secretly injecting hidden prompts** into your requests.

This project is a **non-profit, browser-local** detector: enter your relay endpoint, key, and model name, fire a full suite of probes with one click, cross-validate across multiple dimensions — **channel origin, cryptographic signatures, protocol structure, reasoning IQ, token billing** — and get a **weighted score + verdict + plain-language report**, with support for **shareable links / PNG images**.

> 🔒 **Privacy first**: all detection logic is **fully open-source and runs locally in your frontend**. We **never store your API key or detection data in the cloud** — request records live only in your local browser. The PHP backend only does one-time request forwarding to bypass the browser's CORS restriction, and **never persists anything**. Only when you **explicitly click "Share Report"** is the report uploaded to generate a short link.

---

## ✨ Key Features

| Feature | Description |
| --- | --- |
| 🎯 **All three providers** | Detect Claude (Anthropic) / OpenAI / Gemini protocols in one UI |
| ⭐ **Thinking signature check** | Verifies the **server-side cryptographic signature** of Claude's thinking chain (un-forgeable) — the strongest evidence |
| 🧬 **Protocol contamination** | If `claude_*`-style fields leak into an OpenAI response, it's flagged as a wrapper/counterfeit |
| 🧠 **Reasoning IQ bank** | 12 curated Chinese logic/trap questions distinguish a real flagship from a cheap small model |
| 💉 **Hidden prompt injection check** | Deliberately omits the system field to make the model reveal prompts secretly injected by the relay |
| 💰 **Token billing audit** | Compares token deltas across long/short requests; optionally cross-checks the official `count_tokens` |
| 📊 **Weighted score + hard veto** | Multi-dimensional weighted scoring; any CRITICAL anomaly caps the rating |
| 🛠️ **Auto / Manual modes** | Run the full probe suite automatically, or manually paste a response JSON for fingerprinting (a mini Apifox with built-in detection) |
| 🤖 **AI plain-language summary** | Optional Zhipu GLM integration for a concise verdict (falls back to local rules if unset) |
| 🔗 **One-click report sharing** | Generates short or static links; the report page can export a branded PNG |

---

## 🔬 How it works

The detector combines **active probing** with **passive response fingerprinting** to cross-validate responses across many dimensions:

| Dimension | Principle |
| --- | --- |
| **Channel identification** | Inspect the response `id` prefix: `msg_` = Anthropic direct, `msg_bdrk_` = AWS Bedrock, `msg_vrtx_` = Google Vertex (all real Claude); a `chatcmpl-` prefix = suspected OpenAI wrapper ⚠️ |
| **Thinking signature** (strongest) | A real Claude thinking chain carries a server-side cryptographic `signature` — long, valid base64, **impossible for a relay to forge** |
| **Protocol contamination** | If the OpenAI response `usage` contains `claude_*` / Gemini counting fields = wrapper counterfeit |
| **Structure & spec** | Validate that `id` / `type` / `stop_reason` / `usage` match the official schema, and tool IDs use the `toolu_` prefix |
| **Capability consistency** | Send the same request multiple times, comparing model-name stability and output-token variance (coefficient of variation) to detect "model round-robin" |
| **IQ & knowledge** | Logic-trap questions + Anthropic fact questions catch cheap small models impersonating flagships |
| **Billing authenticity** | Are token deltas between long/short prompts reasonable? Optionally cross-checked against the official `count_tokens` |
| **Streaming authenticity** | Validate SSE event ordering (`message_start` first, `message_stop` last) and stream/non-stream consistency |
| **Caching behavior** | Do two identical requests show the official "create → hit" prompt-caching behavior? |

> **Scoring logic**: each probe is weighted-averaged into a composite score, graded into four tiers — **Highly Trustworthy (≥85) / Basically Trustworthy (≥70) / Questionable (≥50) / Untrustworthy (<50)**. Once a **CRITICAL anomaly** is hit (e.g. wrapper id prefix, missing thinking signature, identity counterfeit, hidden prompt injection), the rating is **hard-capped at "Questionable"**.

---

## 🧪 Probe Catalog

### 🟠 Claude (Anthropic) — 23 probes

| Probe | Weight | Tier | Description |
| --- | :---: | :---: | --- |
| Channel identification | 5 | Q/S/F | Determine origin by `id` prefix |
| Identity check | 5 | Q/S/F | Ask "who are you" to catch rival identity or weak-model swap |
| **Thinking signature ⭐** | **25** | Q/S/F | Verify cryptographic signature of thinking chain (strongest, un-forgeable) |
| Message ID spec | 5 | Q/S/F | Whether `id` / `tool_use.id` match the official format |
| Protocol spec | 5 | Q/S/F | Whether response structure / new `usage` fields are valid |
| Consistency (model/stability) | 10 | Q/S/F | Stable model name and reasonable output variance across runs |
| Structured output (tool_use) | 12 | S/F | Forced tool call, validating structured result and `toolu_` id |
| Structured output (JSON Schema) | 10 | S/F | Output per a complex JSON Schema and validate field compliance |
| Tool + complex Schema + SSE | 10 | S/F | Tool call + complex Schema + streaming combined |
| Streaming event order | 6 | S/F | Validate the SSE event sequence and ordering |
| Behavioral fingerprint | 15 | S/F | Whether bold/list behaviors match the official model |
| Reasoning / IQ | 10 | S/F | 12 Chinese logic-trap questions |
| Knowledge accuracy | 10 | S/F | Anthropic-related fact questions |
| System prompt adherence | 8 | S/F | Whether the system instruction was swallowed by the relay |
| **Hidden prompt injection** | 12 | S/F | Detect prompts secretly injected by the relay layer |
| Multi-turn memory | 6 | S/F | Whether conversation history is faithfully passed through |
| Web search capability | 8 | S/F | Whether the official web_search structure is complete |
| Multimodal (PDF/image) | 8 | S/F | Whether it genuinely understands images |
| Stream / non-stream consistency | 5 | S/F | Whether both modes yield consistent results |
| Prompt caching behavior | 8 | S/F | Whether two requests "create → hit" the cache |
| Token billing | 10 | S/F | Whether token deltas between long/short requests are reasonable |
| Error-shape on bad params | 5 | S/F | Whether invalid params return the standard Anthropic error structure |
| Long-context authenticity | 15 | F | Needle-in-haystack recall (guards against context truncation) |

### 🔵 OpenAI — 6 probes

Basic availability · Model consistency (anti-adulteration) · **Protocol spec + contamination detection** · Function calling · Structured output · Token billing

### 🟢 Gemini — 6 probes

Basic availability · Model consistency · Protocol spec · Function calling · Structured output · Token billing

> Different depths run different numbers of probes: **Quick (Q)** runs only the core few, **Standard (S)** covers the vast majority, and **Full (F)** additionally runs costly checks like long-context authenticity. Deeper = more accurate, but consumes more tokens.

---

## 🏗️ Architecture & Layout

```
check/
├── index.html              # Main UI (Auto-detect / Manual-detect dual view)
├── report.html             # Shareable report page
├── assets/
│   ├── app.css             # Styles
│   ├── app.js              # Main runner: wires protocols / probes / UI / scoring / sharing
│   ├── core.js             # Core engine: proxy request / SSE parse / schema validate / scoring / export
│   ├── report.js           # Report page rendering
│   ├── icons/              # Per-protocol icons (svg)
│   └── protocols/
│       ├── anthropic.js    # Claude probe set (23)
│       ├── openai.js       # OpenAI probe set (6)
│       └── gemini.js       # Gemini probe set (6)
├── api/                    # Lightweight PHP backend (forward only, no persistence)
│   ├── _common.php         # ⚙️ All config lives here (keys / branding / timeout)
│   ├── probe.php           # Forward probe requests (bypass browser CORS)
│   ├── summary.php         # Call Zhipu GLM to generate plain-language summary
│   ├── share.php           # Save / read shareable report short links
│   └── count.php           # (Optional) official count_tokens cross-check
└── data/                   # Shared-report storage (needs write permission)
```

**Data flow**: browser frontend → `api/probe.php` (forward only, bypass CORS) → target relay → returned verbatim → frontend parses, scores, and renders locally. The key is used only once, between "your browser ↔ the forwarding proxy," and is never written to any database.

---

## 🛠️ Tech Stack

- **Frontend**: vanilla JavaScript (ES Modules) — **zero build, zero framework, zero dependencies**, runs directly in the browser.
- **Backend**: PHP 7.4+ (only `curl` forwarding and an optional GLM call) — deployable on any PHP-capable host / aaPanel.
- **Optional services**: Zhipu GLM (AI summary), Anthropic official `count_tokens` (exact billing check), html2canvas (PNG export).

---

## 🚀 Quick Start

### Option A: aaPanel (recommended, fully GUI)

1. **Create site**: aaPanel → **Website** → **Add site**, choose PHP **7.4+**, upload the entire `check/` directory to the site root.
2. **Install extensions**: **App Store** → your PHP → **Install Extension**, install **curl** (required) and **openssl**.
3. **Configure**: edit `api/_common.php` (see below).
4. **Grant write permission**: set the `data/` directory to **755** (owner-writable) for storing shared reports.
5. **Apply SSL**: **SSL** → **Let's Encrypt**, and enabling forced HTTPS is recommended (keys travel over the network).
6. **Open**: visit `https://your-domain/index.html` — a green dot in the top-right means the backend is healthy.

> See [`部署说明.md`](./部署说明.md) in the repo for detailed step-by-step instructions (Chinese).

### Option B: any PHP environment

Place the `check/` directory in any PHP 7.4+ site root, ensure the `curl` extension is enabled and `data/` is writable. HTTPS is optional for local use.

---

## ⚙️ Configuration

Open `api/_common.php` and edit the top constants:

```php
// Zhipu GLM — used for "Generate AI summary". Apply at https://open.bigmodel.cn/ (free tier available).
// Works even if left blank; the summary falls back to local rule-based text.
const GLM_KEY   = 'sk-xxx';
const GLM_MODEL = 'glm-4.7-flash';

// (Optional) Anthropic official count_tokens key, for exact billing-fraud cross-check; leave blank if none.
const OFFICIAL_COUNT_KEY = '';

// Branding slot — shown on the report page header, footer, and exported PNG watermark.
const SITE_NAME   = 'AI Detector';
const SITE_URL    = 'https://your-site.example.com';
const SITE_SLOGAN = 'One-click verification of Claude / OpenAI / Gemini relays';
```

> In addition, `REPO_URL` / `ISSUE_URL` at the top of `assets/app.js` can be replaced with your real repository URL (used for footer links and the "suggest a question" entry).

---

## 📋 Usage

1. Pick a protocol at the top (**Claude / OpenAI / Gemini**).
2. Enter the **endpoint, API key, and model name**, and choose a depth (**Quick / Standard / Full**).
3. Click "**🟢 Start Detection**" to fire the full probe suite and get per-item verdicts.
4. Each item shows **[Request body (editable) / Response body / Features / Diffs]** side by side.
5. Click "**🤖 Generate AI Summary**" for a plain-language report; click "**🔗 Share Report**" to generate a shareable link.
6. The report page can "**Export PNG**" (with branding watermark) in the top-right — ideal for sharing in chats.

> 🛠️ **Manual mode**: if you already have a response and don't want to send a request, switch to the "Manual" view and paste the response JSON for fingerprinting — equivalent to a mini Apifox with built-in detection.

---

## ❓ FAQ

<details>
<summary><b>The top-right dot shows "Backend not connected"?</b></summary>

The `api/` directory wasn't uploaded, or PHP doesn't have the `curl` extension. Visit `api/probe.php?action=ping` directly — it should return `{"service":"ai-detector","ok":true,...}`; or visit `api/probe.php?action=diag` for diagnostics.
</details>

<details>
<summary><b>A probe reports "failed to connect to target"?</b></summary>

The target relay may reject server-side proxying, the URL may be wrong, or it timed out. Try another endpoint.
</details>

<details>
<summary><b>AI summary says "not configured"?</b></summary>

`GLM_KEY` in `api/_common.php` is still `sk-xxx`. Fill in a real Zhipu GLM key.
</details>

<details>
<summary><b>Sharing falls back to a "static link"?</b></summary>

The `data/` directory isn't writable. Grant 755 per the deployment steps; it still works without that, just with a longer share URL (the report is packed into the URL hash).
</details>

<details>
<summary><b>Is my API key safe?</b></summary>

The key is used only between your local browser and the forwarding proxy, and is <b>never written to any database</b>. The proxy only does one-time forwarding to bypass the browser's CORS restriction. If you're concerned, use "Manual mode": no request is sent, only your pasted response is analyzed.
</details>

<details>
<summary><b>Can I add IQ / reasoning questions?</b></summary>

The question bank is maintained centrally and hard-coded (not user-extensible, to prevent targeted "gaming"). But **question suggestions are very welcome** — please open an Issue in the repo.
</details>

---

## 🔒 Transparency Statement

- All detection logic is **fully open-source and runs locally in the frontend**, and **never stores your key or detection data**.
- The PHP backend only does one-time request forwarding (to bypass CORS) and **never persists anything**.
- Only when you **explicitly click "Share Report"** is the report content uploaded to generate a short link.
- This is a non-profit project that **makes no guarantee** about its conclusions — for self-check reference only.

---

## 🙏 Acknowledgements

Inspired by and with thanks to the following open-source projects:

- [veridrop](https://github.com/canarybyte/veridrop) — probe weight and threshold design.
- [claude-detector](https://github.com/7836246/claude-detector) — prompt caching, streaming order, and hidden-prompt probes.

---

## 🤝 Contributing

Issues and Pull Requests are welcome: question suggestions, new probes, new protocol support, and UI/docs improvements are all appreciated.

---

## 📄 License

Released under the [MIT License](./LICENSE).
