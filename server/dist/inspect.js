import { createHash } from 'node:crypto';
import { CATEGORY_LABEL } from './types.js';
/**
 * Looks at an API-format graph and guesses what it is: which base model it
 * runs on, whether it makes images or video, and a sensible default name.
 * Everything here is a suggestion the import dialog lets the user override.
 */
const isLink = (v) => Array.isArray(v) && v.length === 2 && (typeof v[0] === 'string' || typeof v[0] === 'number');
// Families recognised from the model file name, first match wins.
const FAMILIES = [
    [/wan[\W_]?2[\W_]?2/i, 'Wan 2.2'],
    [/wan[\W_]?2[\W_]?1/i, 'Wan 2.1'],
    [/\bwan/i, 'Wan'],
    [/hunyuan.?video|hunyuanvideo/i, 'HunyuanVideo'],
    [/hunyuan/i, 'Hunyuan'],
    [/ltx/i, 'LTX-Video'],
    [/mochi/i, 'Mochi'],
    [/cosmos/i, 'Cosmos'],
    [/\bsvd|stable.?video/i, 'SVD'],
    [/qwen.?image/i, 'Qwen-Image'],
    [/hidream/i, 'HiDream'],
    [/flux.?kontext|kontext/i, 'FLUX Kontext'],
    [/flux/i, 'FLUX'],
    [/chroma/i, 'Chroma'],
    [/sd3\.5|sd35/i, 'SD 3.5'],
    [/sd3/i, 'SD 3'],
    [/illustrious|noob/i, 'Illustrious'],
    [/pony/i, 'Pony'],
    [/sdxl|xl[_\-.]|[_\-]xl\b|juggernaut.?xl|realvisxl/i, 'SDXL'],
    [/v1-5|sd15|sd_?1\.5|\b1\.5\b/i, 'SD 1.5'],
    [/kolors/i, 'Kolors'],
    [/pixart/i, 'PixArt'],
    [/aura/i, 'AuraFlow'],
    [/lumina/i, 'Lumina'],
    [/omnigen/i, 'OmniGen'],
];
const MODEL_INPUTS = ['ckpt_name', 'unet_name', 'model_name', 'model', 'model_path'];
const VIDEO_OUTPUT = /video|webm|mp4|animated|gif|vhs_/i;
const VIDEO_LATENT = /video|wanimagetovideo|wan.*latent|ltxv|mochi|hunyuan.*latent|cosmos.*latent|svd/i;
export function familyOf(file) {
    if (!file)
        return '';
    for (const [re, name] of FAMILIES)
        if (re.test(file))
            return name;
    // fall back to a tidy stem: "dreamshaper_8.safetensors" → "dreamshaper_8"
    return file.split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|gguf|bin)$/i, '');
}
function modelFileOf(wf) {
    // prefer real model loaders over LoRA / VAE / CLIP / upscaler loaders
    const loaders = Object.values(wf).filter((n) => /loader/i.test(n.class_type) && !/lora|vae|clip|controlnet|upscale|ipadapter|image|style|embedding/i.test(n.class_type));
    for (const n of [...loaders, ...Object.values(wf)]) {
        for (const k of MODEL_INPUTS) {
            const v = n.inputs?.[k];
            if (typeof v === 'string' && /\.(safetensors|ckpt|pt|pth|gguf|bin)$/i.test(v))
                return v;
        }
    }
    return null;
}
function categoryOf(wf) {
    const nodes = Object.values(wf);
    const cls = nodes.map((n) => n.class_type);
    const hasSampler = cls.some((c) => /sampler/i.test(c));
    const loadsImage = cls.some((c) => /^LoadImage|LoadImageMask|ImageLoader/i.test(c));
    const video = cls.some((c) => VIDEO_LATENT.test(c)) || cls.some((c) => /save|combine|create/i.test(c) && VIDEO_OUTPUT.test(c));
    if (video)
        return loadsImage ? 'i2v' : 't2v';
    const upscales = cls.some((c) => /upscale/i.test(c));
    if (upscales && !hasSampler)
        return 'upscale';
    const encodes = cls.some((c) => /vaeencode|inpaint/i.test(c));
    if (loadsImage && (encodes || !hasSampler))
        return upscales ? 'upscale' : 'i2i';
    if (hasSampler)
        return 't2i';
    return 'other';
}
/** Key-order-independent JSON, so the same graph exported twice hashes the same. */
function stable(v) {
    if (Array.isArray(v))
        return `[${v.map(stable).join(',')}]`;
    if (v && typeof v === 'object') {
        return `{${Object.keys(v)
            .filter((k) => k !== '_meta')
            .sort()
            .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
            .join(',')}}`;
    }
    return JSON.stringify(v);
}
export const workflowHash = (wf) => createHash('sha1').update(stable(wf)).digest('hex');
/** Same nodes wired the same way, ignoring widget values — used to group legacy runs. */
export function structureKey(wf) {
    const shape = {};
    for (const [id, n] of Object.entries(wf)) {
        shape[id] = [n.class_type, Object.entries(n.inputs ?? {}).filter(([, v]) => isLink(v)).map(([k, v]) => [k, v])];
    }
    return createHash('sha1').update(stable(shape)).digest('hex');
}
export function inspectWorkflow(wf, fileName) {
    const modelFile = modelFileOf(wf);
    const baseModel = familyOf(modelFile);
    const category = categoryOf(wf);
    const outputs = Object.values(wf)
        .filter((n) => /save|preview|combine/i.test(n.class_type))
        .map((n) => n.class_type);
    const fromFile = fileName?.replace(/\.json$/i, '').replace(/[_-]+/g, ' ').trim();
    const suggestedName = fromFile || [baseModel, CATEGORY_LABEL[category]].filter(Boolean).join(' ') || '新工作流';
    return {
        nodeCount: Object.keys(wf).length,
        category,
        baseModel,
        modelFile,
        suggestedName,
        outputs,
        hash: workflowHash(wf),
    };
}
/** Validate shape; returns the graph (unwrapping {"prompt": …}) or an error message. */
export function asWorkflow(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return '工作流需要是一个 JSON 对象';
    let o = obj;
    if ('nodes' in o && 'links' in o)
        return '这是界面格式的工作流，请在 ComfyUI 里用「导出 (API)」';
    if (o.prompt && typeof o.prompt === 'object' && !o.prompt.class_type)
        o = o.prompt;
    const ids = Object.keys(o);
    if (!ids.length)
        return '工作流是空的';
    for (const id of ids) {
        const n = o[id];
        if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || typeof n.inputs !== 'object') {
            return `节点 ${id} 缺少 class_type 或 inputs，不是 API 格式`;
        }
    }
    return o;
}
