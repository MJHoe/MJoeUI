import WebSocket from 'ws';
/** Binary websocket frame types, see comfy/server.py BinaryEventTypes. */
const BIN_PREVIEW_IMAGE = 1;
const BIN_PREVIEW_IMAGE_WITH_METADATA = 4;
/**
 * Talks to one ComfyUI instance. Holds a single persistent websocket that
 * reconnects on drop, and stops cleanly when `stop()` is called (so swapping
 * the BASE URL never leaves a zombie socket reconnecting in the background).
 */
export class ComfyClient {
    config;
    ws;
    stopped = true;
    retry;
    eventHandlers = new Set();
    previewHandlers = new Set();
    openHandlers = new Set();
    constructor(config) {
        this.config = config;
    }
    get clientId() { return this.config.clientId; }
    get isOpen() { return this.ws?.readyState === WebSocket.OPEN; }
    onEvent(h) { this.eventHandlers.add(h); }
    onPreview(h) { this.previewHandlers.add(h); }
    onSocket(h) { this.openHandlers.add(h); }
    url(p) { return `${this.config.baseUrl}${p}`; }
    async submit(workflow) {
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
        if (!r.ok)
            throw new Error(describeSubmitError(r.status, body));
        const parsed = JSON.parse(body);
        if (parsed.node_errors && Object.keys(parsed.node_errors).length > 0) {
            throw new Error(describeSubmitError(400, body));
        }
        return parsed;
    }
    async history(promptId) {
        const r = await fetch(this.url(`/history/${promptId}`));
        if (!r.ok)
            return null;
        const obj = (await r.json());
        return obj[promptId] ?? null;
    }
    async queue() {
        const r = await fetch(this.url('/queue'), { signal: AbortSignal.timeout(3000) });
        if (!r.ok)
            throw new Error(`comfy /queue ${r.status}`);
        const q = (await r.json());
        return {
            running: (q.queue_running ?? []).map((e) => String(e[1])),
            pending: (q.queue_pending ?? []).map((e) => String(e[1])),
        };
    }
    async interrupt(promptId) {
        await fetch(this.url('/interrupt'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt_id: promptId }),
        });
    }
    async dequeue(promptId) {
        await fetch(this.url('/queue'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ delete: [promptId] }),
        });
    }
    async view(ref) {
        const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
        const r = await fetch(this.url(`/view?${q}`));
        if (!r.ok)
            throw new Error(`comfy /view ${r.status}`);
        return Buffer.from(await r.arrayBuffer());
    }
    /** Same as view(), but keeps the content type — used to proxy input images to the browser. */
    async viewRaw(ref) {
        const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type });
        const r = await fetch(this.url(`/view?${q}`));
        if (!r.ok)
            throw new Error(`comfy /view ${r.status}`);
        return { data: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') ?? 'application/octet-stream' };
    }
    /** POST /upload/image — puts a file into ComfyUI's input folder (images and videos alike). */
    async upload(data, filename, mime) {
        const form = new FormData();
        form.append('image', new Blob([new Uint8Array(data)], { type: mime }), filename);
        form.append('type', 'input');
        form.append('overwrite', 'false');
        const r = await fetch(this.url('/upload/image'), { method: 'POST', body: form });
        if (!r.ok)
            throw new Error(`ComfyUI 拒绝了上传（${r.status}）：${(await r.text()).slice(0, 200)}`);
        return (await r.json());
    }
    /** POST /free — unload models and release cached memory. */
    async free() {
        const r = await fetch(this.url('/free'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unload_models: true, free_memory: true }),
        });
        if (!r.ok)
            throw new Error(`comfy /free ${r.status}`);
    }
    async objectInfo(className) {
        const r = await fetch(this.url(`/object_info/${encodeURIComponent(className)}`), {
            signal: AbortSignal.timeout(5000),
        });
        if (!r.ok)
            return null;
        const obj = (await r.json());
        return obj[className] ?? null;
    }
    async systemStats() {
        const r = await fetch(this.url('/system_stats'), { signal: AbortSignal.timeout(3000) });
        if (!r.ok)
            throw new Error(`comfy /system_stats ${r.status}`);
        return r.json();
    }
    start() {
        this.stopped = false;
        this.open();
    }
    stop() {
        this.stopped = true;
        clearTimeout(this.retry);
        const ws = this.ws;
        this.ws = undefined;
        ws?.removeAllListeners();
        ws?.on('error', () => { });
        ws?.close();
        for (const h of this.openHandlers)
            h(false);
    }
    open() {
        if (this.stopped)
            return;
        let ws;
        try {
            ws = new WebSocket(`${this.config.wsOrigin}/ws?clientId=${this.clientId}`);
        }
        catch {
            this.scheduleRetry();
            return;
        }
        this.ws = ws;
        ws.on('open', () => {
            // ask for preview frames tagged with prompt_id / node_id
            ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }));
            for (const h of this.openHandlers)
                h(true);
        });
        ws.on('message', (raw, isBinary) => {
            if (isBinary) {
                const p = parsePreview(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
                if (p)
                    for (const h of this.previewHandlers)
                        h(p);
                return;
            }
            let ev;
            try {
                ev = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            for (const h of this.eventHandlers) {
                try {
                    h(ev);
                }
                catch (e) {
                    console.error('[comfy] handler failed', e);
                }
            }
        });
        ws.on('close', () => {
            if (this.ws !== ws)
                return;
            for (const h of this.openHandlers)
                h(false);
            this.scheduleRetry();
        });
        ws.on('error', () => { });
    }
    scheduleRetry() {
        if (this.stopped)
            return;
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.open(), 2000);
    }
}
function parsePreview(buf) {
    if (buf.length < 8)
        return null;
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
        }
        catch {
            return null;
        }
    }
    return null;
}
/** Turn ComfyUI's validation payload into something a person can act on. */
function describeSubmitError(status, body) {
    try {
        const obj = JSON.parse(body);
        const parts = [];
        if (obj.error?.message)
            parts.push(obj.error.message);
        for (const [nodeId, ne] of Object.entries(obj.node_errors ?? {})) {
            for (const err of ne.errors ?? []) {
                const why = [err.message, err.details].filter(Boolean).join(' · ');
                parts.push(`#${nodeId} ${ne.class_type ?? ''}：${why}`);
            }
        }
        if (parts.length)
            return parts.join('\n');
    }
    catch { /* not json */ }
    return `ComfyUI 返回 ${status}：${body.slice(0, 400)}`;
}
