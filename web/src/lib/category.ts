import { Clapperboard, Film, Images, Shapes, Sparkles, ZoomIn, type LucideIcon } from 'lucide-react';
import type { Category, MediaKind } from '../types';

export const CATEGORIES: Category[] = ['t2i', 'i2i', 't2v', 'i2v', 'upscale', 'other'];

export const CATEGORY: Record<Category, { label: string; hint: string; icon: LucideIcon; kind: MediaKind }> = {
  t2i: { label: '文生图', hint: '提示词 → 图片', icon: Sparkles, kind: 'image' },
  i2i: { label: '图生图', hint: '图片 + 提示词 → 图片', icon: Images, kind: 'image' },
  t2v: { label: '文生视频', hint: '提示词 → 视频', icon: Clapperboard, kind: 'video' },
  i2v: { label: '图生视频', hint: '首帧图片 → 视频', icon: Film, kind: 'video' },
  upscale: { label: '放大修复', hint: '放大、修脸、细化', icon: ZoomIn, kind: 'image' },
  other: { label: '其他', hint: '其余用途', icon: Shapes, kind: 'image' },
};

/** Families the server recognises; offered as suggestions in the base-model field. */
export const BASE_MODELS = [
  'SD 1.5', 'SDXL', 'Pony', 'Illustrious', 'SD 3.5', 'FLUX', 'FLUX Kontext', 'Chroma', 'Qwen-Image', 'HiDream',
  'Kolors', 'Wan 2.2', 'Wan 2.1', 'HunyuanVideo', 'LTX-Video', 'Mochi', 'Cosmos', 'SVD',
];

/** Stable small tilt per id so a sticker always sits the same way. */
export function tiltOf(id: string, range = 2.2): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const unit = ((h >>> 0) % 1000) / 999; // 0..1
  return +((unit * 2 - 1) * range).toFixed(2);
}
