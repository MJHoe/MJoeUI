import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Config } from './config.js';
import type { Workflow } from './types.js';

export type ComfyEvent = { type: string; data: any };

export type ComfyPreview = {
  promptId?: string;
  nodeId?: string;
  mime: string;
  data: Buffer;
};

export type SubmitResp = {
  prompt_id: string;
  number: number;
  node_errors: Record<string, unknown>;
};

export type ComfyFileRef = { filename: string; subfolder: string; type: string };

export type HistoryEntry = {
  prompt: unknown;
  outputs: Record<string, Record<string, unknown>>;
  status?: { completed: boolean; status_str: 'success' | 'error'; messages: unknown[] };
};

/** Ping cadence, and how long without any frame before the socket is
 *  presumed dead (half-open behind a proxy) and replaced. */
const PING_MS = 15_000;
const DEAD_MS = 45_000;

/** Binary websocket frame types, see comfy/server.py BinaryEventTypes. */
const BIN_PREVIEW_IMAGE = 1;
const BIN_PREVIEW_IMAGE_WITH_METADATA = 4;

/**
 * Talks to one ComfyUI instance. Holds a single persistent websocket that
 * reconnects on drop, and stops cleanly when `stop()` is called (so swapping
 * the BASE URL never leaves a zombie socket reconnecting in the background).
 *
 * The client id is per process, never persisted. ComfyUI keeps one socket per
 * client id and, when a socket closes, drops whatever is registered under that
 * id — so two processes sharing an id (a watch-mode restart, a second copy)
 * leave the survivor connected but deaf: no progress, no completion.
 */
export class ComfyClient {
  private ws?: WebSocket;
  private stopped = true;
  private retry?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private readonly id = randomUUID();
  /** Last time anything (event, preview, pong) arrived from ComfyUI. */
  lastSeenAt = 0;
  /** Last time a JSON event arrived — pongs don't count. */
  lastEventAt = 0;
  private eventHandlers = new Set<(ev: ComfyEvent) => void>();
  private previewHandlers = new Set<(p: ComfyPreview) => void>();
  private openHandlers = new Set<(open: boolean) => void>();

  constructor(private readonly config: Config) {}

  get clientId() { return this.id; }
  get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }

  onEvent(h: (ev: ComfyEvent) => void) { this.eventHandlers.add(h); }
  onPreview(h: (p: ComfyPreview) => void) { this.previewHandlers.add(h); }
  onSocket(h: (open: boolean) => void) { this.openHandlers.add(h); }

  private url(p: string) { return `${this.config.baseUrl}${p}`; }

  async submit(workflow: Workflow): Promise<SubmitResp> {
    const r = await fetch(this.url('/prompt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: workflow,
        client_id: this.clientId,
        extra_data: { preview_method: 'auto' },
      }),
    });
    const body = await r.text();
    if (!r.ok) throw new Error(describeSubmitError(r.status, body));
    const parsed = JSON.parse(body) as SubmitResp;
    if (parsed.node_errors && Object.keys(parsed.node_errors).length > 0) {
      throw new Error(describeSubmitError(400, body));
    }
    return parsed;
  }

  /** null = ComfyUI answered and has no such prompt; throws when it couldn't
   *  be asked (network, 5xx), so callers don't mistake a blip for "gone". */
  async history(promptId: string): Promise<HistoryEntry | null> {
    const r = await fetch(this.url(`/history/${promptId}`), { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`comfy /history ${r.status}`);
    const obj = (await r.json()) as Record<string, HistoryEntry>;
    return obj[promptId] ?? null;
  }

  async queue(): Promise<{ running: string[]; pending: string[] }> {
    const r = await fetch(this.url('/queue'), { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`comfy /queue ${r.status}`);
    const q = (await r.json()) as { queue_running: any[][]; queue_pending: any[][] };
    return {
      running: (q.queue_running ?? []).map((e) => String(e[1])),
      pending: (q.queue_pending ?? []).map((e) => String(e[1])),
    };
  }

  async interrupt(promptId: string) {
    await fetch(this.url('/interrupt'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt_id: promptId }),
    });
  }

  async dequeue(promptId: string) {
    await fetch(this.url('/queue'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delete: [promptId] }),
    });
  }

  async view(ref: ComfyFileRef): Promise<Buffer> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    const r = await fetch(this.url(`/view?${q}`));
    if (!r.ok) throw new Error(`comfy /view ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  /** Same as view(), but keeps the content type — used to proxy input images to the browser. */
  async viewRaw(ref: ComfyFileRef): Promise<{ data: Buffer; mime: string }> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
    const r = await fetch(this.url(`/view?${q}`));
    if (!r.ok) throw new Error(`comfy /view ${r.status}`);
    return { data: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') ?? 'application/octet-stream' };
  }

  /** POST /upload/image — puts a file into ComfyUI's input folder (images and videos alike). */
  async upload(data: Buffer, filename: string, mime: string): Promise<{ name: string; subfolder: string; type: string }> {
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(data)], { type: mime }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'false');
    const r = await fetch(this.url('/upload/image'), { method: 'POST', body: form });
    if (!r.ok) throw new Error(`ComfyUI 拒绝了上传（${r.status}）：${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as { name: string; subfolder: string; type: string };
  }

  /** POST /free — unload models and release cached memory. */
  async free() {
    const r = await fetch(this.url('/free'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
    });
    if (!r.ok) throw new Error(`comfy /free ${r.status}`);
  }

  async objectInfo(className: string): Promise<unknown | null> {
    const r = await fetch(this.url(`/object_info/${encodeURIComponent(className)}`), {
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return null;
    const obj = (await r.json()) as Record<string, unknown>;
    return obj[className] ?? null;
  }

  async systemStats(): Promise<unknown> {
    const r = await fetch(this.url('/system_stats'), { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`comfy /system_stats ${r.status}`);
    return r.json();
  }

  start() {
    this.stopped = false;
    this.open();
  }

  /** Replace the socket (gracefully, so ComfyUI unregisters the old one
   *  before the new one registers). Used when events stop arriving. */
  reconnect() {
    const ws = this.ws;
    if (!ws || this.stopped) return;
    if (ws.readyState === WebSocket.OPEN) ws.close();
    else ws.terminate();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.heartbeat);
    const ws = this.ws;
    this.ws = undefined;
    ws?.removeAllListeners();
    ws?.on('error', () => {});
    ws?.close();
    for (const h of this.openHandlers) h(false);
  }

  private open() {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.config.wsOrigin}/ws?clientId=${this.clientId}`);
    } catch {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.on('open', () => {
      this.lastSeenAt = this.lastEventAt = Date.now();
      // ask for preview frames tagged with prompt_id / node_id
      ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws) return;
        // nothing at all for a while, not even pongs: the link is dead
        if (Date.now() - this.lastSeenAt > DEAD_MS) { ws.terminate(); return; }
        try { ws.ping(); } catch { /* close handler takes over */ }
      }, PING_MS);
      this.heartbeat.unref();
      for (const h of this.openHandlers) h(true);
    });
    ws.on('pong', () => { this.lastSeenAt = Date.now(); });
    ws.on('message', (raw, isBinary) => {
      this.lastSeenAt = Date.now();
      if (!isBinary) this.lastEventAt = this.lastSeenAt;
      if (isBinary) {
        const p = parsePreview(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        if (p) for (const h of this.previewHandlers) h(p);
        return;
      }
      let ev: ComfyEvent;
      try { ev = JSON.parse(raw.toString()); } catch { return; }
      for (const h of this.eventHandlers) {
        try { h(ev); } catch (e) { console.error('[comfy] handler failed', e); }
      }
    });
    ws.on('close', () => {
      if (this.ws !== ws) return;
      clearInterval(this.heartbeat);
      for (const h of this.openHandlers) h(false);
      this.scheduleRetry();
    });
    ws.on('error', () => { /* close handler retries */ });
  }

  private scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.open(), 2000);
  }
}

function parsePreview(buf: Buffer): ComfyPreview | null {
  if (buf.length < 8) return null;
  const kind = buf.readUInt32BE(0);
  if (kind === BIN_PREVIEW_IMAGE) {
    const fmt = buf.readUInt32BE(4);
    return { mime: fmt === 2 ? 'image/png' : 'image/jpeg', data: buf.subarray(8) };
  }
  if (kind === BIN_PREVIEW_IMAGE_WITH_METADATA) {
    const len = buf.readUInt32BE(4);
    try {
      const meta = JSON.parse(buf.subarray(8, 8 + len).toString('utf8'));
      return {
        promptId: meta.prompt_id,
        nodeId: meta.node_id,
        mime: meta.image_type || 'image/jpeg',
        data: buf.subarray(8 + len),
      };
    } catch {
      return null;
    }
  }
  return null;
}

/** Turn ComfyUI's validation payload into something a person can act on. */
function describeSubmitError(status: number, body: string): string {
  try {
    const obj = JSON.parse(body);
    const parts: string[] = [];
    if (obj.error?.message) parts.push(obj.error.message);
    for (const [nodeId, ne] of Object.entries<any>(obj.node_errors ?? {})) {
      for (const err of ne.errors ?? []) {
        const why = [err.message, err.details].filter(Boolean).join(' · ');
        parts.push(`#${nodeId} ${ne.class_type ?? ''}：${why}`);
      }
    }
    if (parts.length) return parts.join('\n');
  } catch { /* not json */ }
  return `ComfyUI 返回 ${status}：${body.slice(0, 400)}`;
}
