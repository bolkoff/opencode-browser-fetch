// Инструмент `browserfetch` для OpenCode: грузит страницу через настоящий
// Chrome вместо «голого» HTTP, который сайты с бот-защитой (Cloudflare и т.п.)
// отвечают 403. Приоритет: запущенный Chrome с DevTools-протоколом (CDP), по
// умолчанию http://127.0.0.1:9228; если он недоступен — headless `google-chrome`.
// Подключение: "plugins" в opencode.jsonc (локальный путь или npm-пакет).
// Адрес CDP переопределяется опцией плагина `cdpUrl` или переменной OPENCODE_BROWSER_CDP.
import { Plugin } from "@opencode/plugin"
import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const DEFAULT_CDP = "http://127.0.0.1:9228"
const CHROME_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]
const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36"
const MAX_CHARS = 400_000

type Extract = "html" | "text"

interface FetchInput {
  url?: string
  extract?: string
  wait?: number
  timeout?: number
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function clamp(n: unknown, min: number, max: number, dflt: number): number {
  const v = typeof n === "number" && Number.isFinite(n) ? n : dflt
  return Math.min(max, Math.max(min, Math.round(v)))
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

// --- Минимальный клиент CDP через WebSocket ---

class CdpError extends Error {}

class Cdp {
  private ws: WebSocket
  private seq = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private events = new Map<string, Array<(params: any) => void>>()

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener("message", (ev: any) => {
      let msg: any
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new CdpError(String(msg.error.message ?? "CDP error")))
        else p.resolve(msg.result)
        return
      }
      if (msg.method) {
        for (const fn of this.events.get(msg.method) ?? []) {
          try {
            fn(msg.params)
          } catch {}
        }
      }
    })
    ws.addEventListener("close", () => this.rejectAll(new CdpError("CDP connection closed")))
    ws.addEventListener("error", () => this.rejectAll(new CdpError("CDP connection failed")))
  }

  static connect(url: string, timeoutMs = 5000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (e) {
        reject(e)
        return
      }
      const timer = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        reject(new CdpError("CDP websocket timeout"))
      }, timeoutMs)
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer)
          resolve(new Cdp(ws))
        },
        { once: true },
      )
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer)
          reject(new CdpError("CDP websocket error"))
        },
        { once: true },
      )
    })
  }

  on(method: string, fn: (params: any) => void): void {
    const list = this.events.get(method) ?? []
    list.push(fn)
    this.events.set(method, list)
  }

  send(method: string, params?: object): Promise<any> {
    const id = this.seq++
    const payload = JSON.stringify({ id, method, params: params ?? {} })
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        this.ws.send(payload)
      } catch (e) {
        this.pending.delete(id)
        reject(e as Error)
      }
    })
  }

  close(): void {
    try {
      this.ws.close()
    } catch {}
    this.rejectAll(new CdpError("CDP connection closed"))
  }

  private rejectAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}

// --- CDP-маршрут: вкладка в уже запущенном Chrome ---

async function cdpAlive(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

async function openBlankTab(base: string): Promise<{ id: string; ws: string }> {
  let res = await fetch(`${base}/json/new`, { method: "PUT", signal: AbortSignal.timeout(5000) }).catch(() => null)
  if (!res || res.status === 405 || res.status === 404) {
    // старые Chrome принимают только GET
    res = await fetch(`${base}/json/new`, { signal: AbortSignal.timeout(5000) }).catch(() => null)
  }
  if (!res || !res.ok) {
    throw new Error(`CDP ${base}/json/new failed (HTTP ${res ? res.status : "no response"})`)
  }
  const tab: any = await res.json()
  if (!tab?.webSocketDebuggerUrl) throw new Error("CDP /json/new returned no webSocketDebuggerUrl")
  return { id: String(tab.id), ws: String(tab.webSocketDebuggerUrl) }
}

async function fetchViaCdp(
  base: string,
  url: string,
  extract: Extract,
  wait: number,
  timeout: number,
  onAbort: (fn: () => void) => void,
): Promise<{ body: string; title: string; finalUrl: string }> {
  const tab = await openBlankTab(base)
  let cdp: Cdp | undefined
  try {
    cdp = await withTimeout(Cdp.connect(tab.ws), 5000, "CDP connect")
    onAbort(() => cdp?.close())
    await cdp.send("Page.enable")
    await cdp.send("Page.navigate", { url })

    // ждём document.readyState === "complete" (на случай missed load event)
    const deadline = Date.now() + timeout
    for (;;) {
      const r: any = await cdp
        .send("Runtime.evaluate", { expression: "document.readyState", returnByValue: true, silent: true })
        .catch(() => null)
      const state = r?.result?.value
      if (state === "complete") break
      if (Date.now() > deadline) break // отдаём то, что успело отрендериться
      await sleep(300)
    }
    if (wait > 0) await sleep(wait)

    const expr =
      extract === "text"
        ? "JSON.stringify({title: document.title, url: location.href, body: document.body ? document.body.innerText : document.documentElement.textContent})"
        : "JSON.stringify({title: document.title, url: location.href, body: document.documentElement.outerHTML})"
    const res: any = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, silent: true })
    const parsed = JSON.parse(res?.result?.value ?? "{}")
    return {
      body: String(parsed.body ?? ""),
      title: String(parsed.title ?? ""),
      finalUrl: String(parsed.url || url),
    }
  } finally {
    try {
      await fetch(`${base}/json/close/${tab.id}`, { signal: AbortSignal.timeout(2000) }).catch(() => {})
    } catch {}
    cdp?.close()
  }
}

// --- Fallback: отдельный headless Chrome ---

function which(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("which", [bin], (err, stdout) => resolve(err || !stdout.trim() ? null : stdout.trim()))
  })
}

async function findChrome(): Promise<string | null> {
  for (const c of CHROME_CANDIDATES) {
    const p = await which(c)
    if (p) return p
  }
  return null
}

async function fetchViaHeadless(url: string, timeoutMs: number): Promise<string> {
  const bin = await findChrome()
  if (!bin) throw new Error("browserfetch: no CDP browser reachable and no Chrome binary in PATH")
  const dir = await mkdtemp(path.join(tmpdir(), "opencode-browserfetch-"))
  try {
    return await new Promise<string>((resolve, reject) => {
      execFile(
        bin,
        [
          "--headless=new",
          "--disable-gpu",
          "--no-first-run",
          "--disable-extensions",
          "--disable-blink-features=AutomationControlled",
          `--user-data-dir=${dir}`,
          `--window-size=1920,1080`,
          `--user-agent=${UA}`,
          `--timeout=${timeoutMs}`,
          "--dump-dom",
          url,
        ],
        { timeout: timeoutMs + 20_000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) return reject(err)
          resolve(stdout)
        },
      )
    })
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// --- Плагин ---

export default Plugin.define({
  id: "browser-fetch",
  async setup(ctx: any) {
    const base = String(
      ctx?.options?.cdpUrl ?? process.env.OPENCODE_BROWSER_CDP ?? DEFAULT_CDP,
    ).replace(/\/+$/, "")

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "browserfetch",
        description:
          "Fetch a web page through a real Chrome browser (opens a temporary tab and closes it right away). " +
          "Use it instead of webfetch when webfetch gets 403/blocked by bot protection or the page needs JavaScript rendering. " +
          "Prefers the running Chrome with DevTools protocol, falls back to a temporary headless Chrome.",
        input: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL of the page" },
            extract: {
              type: "string",
              enum: ["html", "text"],
              description: "Return rendered HTML (default) or visible text",
            },
            wait: {
              type: "number",
              description: "Extra milliseconds to wait after load for JS rendering (default 1200, max 15000)",
            },
            timeout: {
              type: "number",
              description: "Page load timeout in milliseconds (default 45000, max 120000)",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        execute: async (rawInput: unknown, context: any) => {
          const input = (rawInput ?? {}) as FetchInput
          const url = String(input.url ?? "").trim()
          if (!/^https?:\/\//i.test(url)) {
            throw new Error(`browserfetch: only http(s) URLs are supported, got: ${url}`)
          }
          const extract: Extract = input.extract === "text" ? "text" : "html"
          const wait = clamp(input.wait, 0, 15_000, 1_200)
          const timeout = clamp(input.timeout, 5_000, 120_000, 45_000)

          let via: string
          let body: string
          let title = ""
          let finalUrl = url

          if (await cdpAlive(base)) {
            const r = await fetchViaCdp(base, url, extract, wait, timeout, (fn) => {
              try {
                context?.signal?.addEventListener("abort", fn, { once: true })
              } catch {}
            })
            body = r.body
            title = r.title
            finalUrl = r.finalUrl
            via = `Chrome CDP (${base})`
          } else {
            body = await fetchViaHeadless(url, Math.min(timeout, 60_000))
            const m = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
            title = m ? m[1].trim() : ""
            via = "headless Chrome (CDP unavailable)"
          }

          if (!body.trim()) throw new Error(`browserfetch: empty page content for ${url}`)

          const truncated =
            body.length > MAX_CHARS
              ? body.slice(0, MAX_CHARS) + `\n… [truncated ${body.length - MAX_CHARS} chars]`
              : body
          const header = `fetched via ${via}\ntitle: ${title}\nurl: ${finalUrl}\nextract: ${extract}\n\n`
          return { content: header + truncated }
        },
      })
    })
  },
})
