import { useEffect, useState } from 'react';
import { api } from '../api';
import type { NodeInfo, Workflow } from '../types';

const cache = new Map<string, NodeInfo | null>();
const inflight = new Map<string, Promise<void>>();

/**
 * Fetch ComfyUI's input specs for every node class in the workflow, so the
 * form can render real dropdown options and numeric ranges. Falls back to
 * value-based inference while loading or when ComfyUI is offline.
 */
export function useObjectInfo(wf: Workflow | null, connected: boolean) {
  const [, bump] = useState(0);
  const classes = wf ? [...new Set(Object.values(wf).map((n) => n.class_type))] : [];
  const key = classes.sort().join(',');

  useEffect(() => {
    if (!key || !connected) return;
    const missing = key.split(',').filter((c) => !cache.has(c) && !inflight.has(c));
    if (!missing.length) return;
    const p = api
      .objectInfo(missing)
      .then((res) => { for (const c of missing) cache.set(c, res[c] ?? null); })
      .catch(() => { /* offline: keep inferring */ })
      .finally(() => { for (const c of missing) inflight.delete(c); bump((n) => n + 1); });
    for (const c of missing) inflight.set(c, p);
  }, [key, connected]);

  const out: Record<string, NodeInfo | null> = {};
  for (const c of classes) out[c] = cache.get(c) ?? null;
  return out;
}
