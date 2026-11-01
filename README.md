# opencode-browser-fetch

[OpenCode](https://opencode.ai) plugin that adds a **`browserfetch`** tool: fetch a web
page through a **real Chrome browser** instead of plain HTTP.

Why: bot protection (Cloudflare and friends) often answers 403 to non-browser clients
— sometimes intermittently, by bot scoring — and some pages need JavaScript rendering
before any content exists.

## How it works

1. **Preferred:** opens a *temporary tab* in an already running Chrome with the
   DevTools protocol enabled (default endpoint `http://127.0.0.1:9228`). The page is
   loaded with your cookies and your real browser fingerprint, so what the tool sees
   is what you would see. The tab is closed immediately after reading. Waits for
   `document.readyState === "complete"` plus an extra settle delay for JS rendering,
   then returns `document.documentElement.outerHTML` or `document.body.innerText`.
2. **Fallback:** if no CDP browser is reachable, runs a separate headless
   `google-chrome` (or `chromium`) with a clean temporary profile and a normal
   (non-`HeadlessChrome`) user agent, and returns the dumped DOM.

## Install

Local directory (paths resolve against the config file):

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "../opencode-browser-fetch" }]
}
```

Or from npm once installed that way:

```jsonc
{ "plugins": ["opencode-browser-fetch"] }
```

Requirements:

- a running Chrome started with `--remote-debugging-port=9228` (or another port —
  see [Options](#options)), **and/or**
- `google-chrome` / `google-chrome-stable` / `chromium` / `chromium-browser` in `PATH`
  for the headless fallback.

## Tool: `browserfetch`

| Parameter  | Type               | Default | Description                                          |
| ---------- | ------------------ | ------- | ---------------------------------------------------- |
| `url`      | string (**req.**)  | —       | Absolute http(s) URL of the page                     |
| `extract`  | `"html" \| "text"` | `html`  | Rendered HTML or visible text                        |
| `wait`     | number (ms)        | 1200    | Extra wait after load for JS rendering (max 15000)   |
| `timeout`  | number (ms)        | 45000   | Page load timeout (max 120000)                       |

The result starts with a short header (`fetched via …`, `title`, final `url`) followed
by the page content; oversized results are truncated to 400 000 characters.

## Options

```jsonc title="opencode.jsonc"
{
  "plugins": [
    {
      "package": "opencode-browser-fetch",
      "options": { "cdpUrl": "http://127.0.0.1:9228" }
    }
  ]
}
```

- `cdpUrl` — DevTools endpoint of the running Chrome. Can also be set with the
  `OPENCODE_BROWSER_CDP` environment variable (plugin option wins).

## License

MIT
