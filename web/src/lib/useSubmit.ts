import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { api } from '../api';
import { EMPTY_PATCHES, useStore } from '../store';
import { patchWorkflow, randomSeed, seedFields } from './workflow';
import type { Patches } from '../types';

/**
 * Submit the open workflow `batch` times. Runs after the first always get
 * fresh seeds (identical prompts would just hit ComfyUI's cache); with
 * "randomize" on, the first run does too. The seeds actually used are written
 * back into the form so the panel always shows what was rendered last.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const s = useStore.getState();
    const id = s.currentId;
    const graph = id ? s.graphs[id] : undefined;
    if (!id || !graph || busy) return false;
    if (!s.connected) {
      toast.error('ComfyUI 未连接', { description: '到「设置」页检查地址后再试。' });
      return false;
    }
    setBusy(true);
    const patches = s.drafts[id] ?? EMPTY_PATCHES;
    const seeds = seedFields(graph.json);
    let lastPatches: Patches = patches;
    let sent = 0;
    try {
      for (let i = 0; i < s.batch; i++) {
        const run: Patches = structuredClone(patches);
        if (s.randomize || i > 0) {
          for (const f of seeds) (run[f.nodeId] ??= {})[f.name] = randomSeed();
        }
        await api.submitRun(id, patchWorkflow(graph.json, run));
        lastPatches = run;
        sent++;
      }
      s.focusRun(null);
      if (s.randomize || s.batch > 1) {
        for (const f of seeds) {
          const v = lastPatches[f.nodeId]?.[f.name];
          if (v !== undefined) useStore.getState().setPatch(f.nodeId, f.name, v);
        }
      }
      if (s.batch > 1) toast(`已提交 ${sent} 次`, { description: '每次使用不同的随机种子。' });
      return true;
    } catch (e: any) {
      toast.error(sent ? `提交了 ${sent} 次后出错` : '提交失败', { description: e.message, duration: 10000 });
      return false;
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return { submit, busy };
}
