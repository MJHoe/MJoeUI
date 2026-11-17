import { toast } from 'sonner';

export function fmtDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return '<1s';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === today.toDateString()) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** "刚刚" / "5 分钟前" / "昨天" / "3 天前" / "11/2" */
export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '从未';
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  const days = Math.floor(s / 86400);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function fmtBytes(n?: number): string {
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

/** Same pieces the server uses for artifact folders / names. */
export const localDayStamp = (d: Date) => ({
  day: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
  time: `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`,
});

export function fmtNumber(v: number, step = 1): string {
  if (Number.isInteger(step) && Number.isInteger(v)) return String(v);
  const decimals = Math.min(4, Math.max(0, (String(step).split('.')[1] ?? '').length));
  return v.toFixed(decimals);
}

export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

/** `…/wf_x/2026-11-16/183205_42.png` → `wf_x/2026-11-16/183205_42.png` */
export const tailPath = (p: string, n = 3) => p.split(/[\\/]/).slice(-n).join('/');

export async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`${what}已复制`, { description: text.length > 80 ? `${text.slice(0, 80)}…` : text });
  } catch { /* clipboard denied */ }
}
