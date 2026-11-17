const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');
/** Kahn's algorithm over input links — a good approximation of ComfyUI's execution order. */
export function topoNodes(wf) {
    const ids = Object.keys(wf);
    const indeg = new Map(ids.map((id) => [id, 0]));
    const out = new Map(ids.map((id) => [id, []]));
    for (const id of ids) {
        for (const v of Object.values(wf[id].inputs ?? {})) {
            if (isLink(v) && wf[String(v[0])]) {
                const src = String(v[0]);
                out.get(src).push(id);
                indeg.set(id, (indeg.get(id) ?? 0) + 1);
            }
        }
    }
    const byNum = (a, b) => (Number(a) - Number(b)) || a.localeCompare(b);
    const ready = ids.filter((id) => indeg.get(id) === 0).sort(byNum);
    const order = [];
    while (ready.length) {
        const id = ready.shift();
        order.push(id);
        for (const nxt of out.get(id)) {
            indeg.set(nxt, indeg.get(nxt) - 1);
            if (indeg.get(nxt) === 0) {
                ready.push(nxt);
                ready.sort(byNum);
            }
        }
    }
    for (const id of ids)
        if (!order.includes(id))
            order.push(id); // cycles, just in case
    return order.map((id) => ({
        id,
        className: wf[id].class_type,
        title: wf[id]._meta?.title || wf[id].class_type,
    }));
}
/** Follow conditioning links upstream until a node that holds the prompt text. */
function textOf(wf, id, depth = 0) {
    const n = wf[id];
    if (!n || depth > 6)
        return undefined;
    for (const k of ['text', 'prompt', 'text_g', 'positive_prompt']) {
        const v = n.inputs?.[k];
        if (typeof v === 'string')
            return v;
    }
    for (const k of ['conditioning', 'positive', 'conditioning_1', 'conditioning_to', 'clip_text']) {
        const v = n.inputs?.[k];
        if (isLink(v)) {
            const hit = textOf(wf, String(v[0]), depth + 1);
            if (hit !== undefined)
                return hit;
        }
    }
    return undefined;
}
/** Pull the handful of values worth showing next to a result. */
export function deriveMeta(wf) {
    const meta = {};
    let positiveId;
    let negativeId;
    for (const node of Object.values(wf)) {
        const i = node.inputs ?? {};
        if (meta.width == null && typeof i.width === 'number' && typeof i.height === 'number') {
            meta.width = i.width;
            meta.height = i.height;
        }
        const seed = typeof i.seed === 'number' ? i.seed : typeof i.noise_seed === 'number' ? i.noise_seed : undefined;
        if (meta.seed == null && seed != null)
            meta.seed = seed;
        if (meta.steps == null && typeof i.steps === 'number')
            meta.steps = i.steps;
        if (meta.cfg == null && typeof i.cfg === 'number')
            meta.cfg = i.cfg;
        if (meta.sampler == null && typeof i.sampler_name === 'string')
            meta.sampler = i.sampler_name;
        if (meta.scheduler == null && typeof i.scheduler === 'string')
            meta.scheduler = i.scheduler;
        const model = i.ckpt_name ?? i.unet_name ?? i.model_name;
        if (meta.model == null && typeof model === 'string')
            meta.model = model;
        if (!positiveId && isLink(i.positive))
            positiveId = String(i.positive[0]);
        if (!negativeId && isLink(i.negative))
            negativeId = String(i.negative[0]);
    }
    const posText = positiveId ? textOf(wf, positiveId) : undefined;
    const negText = negativeId ? textOf(wf, negativeId) : undefined;
    if (negText)
        meta.negative = negText;
    if (posText)
        meta.prompt = posText;
    else {
        for (const node of Object.values(wf)) {
            const t = node.inputs?.text;
            if (typeof t === 'string' && t.trim()) {
                meta.prompt = t;
                break;
            }
        }
    }
    return meta;
}
export function deriveLabel(meta, fallback) {
    const clean = meta.prompt?.trim().replace(/\s+/g, ' ');
    if (!clean)
        return fallback;
    return clean.length > 40 ? clean.slice(0, 40) + '…' : clean;
}
/**
 * Rough relative cost per node so the percentage tracks wall time: samplers
 * dominate a run, decoders are noticeable, everything else is near-instant.
 */
function weightOf(className) {
    if (/sampler/i.test(className))
        return 12;
    if (/decode|upscale|encode.*vae|vae.*encode/i.test(className))
        return 2;
    return 1;
}
/** Recompute progress + ETA from node bookkeeping. Mutates the task. */
export function recompute(t) {
    const total = Math.max(1, t.nodesTotal);
    const done = new Set(t.doneNodes ?? []);
    t.nodesDone = Math.min(total, done.size || t.nodesDone);
    const cur = t.currentNode?.progress;
    const frac = cur && cur.max > 0 ? cur.value / cur.max : 0;
    if (t.nodes?.length) {
        let sum = 0, got = 0;
        for (const n of t.nodes) {
            const w = weightOf(n.className);
            sum += w;
            if (done.has(n.id))
                got += w;
            else if (n.id === t.currentNode?.id)
                got += w * frac;
        }
        t.progress = Math.min(0.995, got / Math.max(1, sum));
    }
    else {
        t.progress = Math.min(0.995, (t.nodesDone + frac) / total);
    }
    const now = Date.now();
    if (cur && cur.max > 1 && cur.value > 0 && t.currentNode?.startedAt) {
        // a stepping node (sampler) dominates runtime: extrapolate its own pace
        const perStep = (now - t.currentNode.startedAt) / cur.value;
        t.etaMs = Math.max(0, perStep * (cur.max - cur.value));
    }
    else if (t.startedAt && t.progress > 0.05) {
        const elapsed = now - t.startedAt;
        t.etaMs = Math.max(0, elapsed / t.progress - elapsed);
    }
    else {
        t.etaMs = undefined;
    }
}
export function markDone(t, nodeId) {
    t.doneNodes ??= [];
    if (!t.doneNodes.includes(nodeId))
        t.doneNodes.push(nodeId);
}
