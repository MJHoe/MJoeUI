import { toast } from 'sonner';
import { api } from '../api';
import { useStore } from '../store';
import type { Artifact } from '../types';
import { diffPatches } from './workflow';

export async function revealArtifact(a: Artifact) {
  try {
    await api.revealArtifact(a.id);
  } catch (e: any) {
    toast.error('找不到这个文件', { description: e.message });
  }
}

export async function toggleStar(a: Artifact) {
  try {
    await api.starArtifact(a.id, !a.starred);
  } catch (e: any) {
    toast.error('没能更新收藏', { description: e.message });
  }
}

export async function deleteArtifact(a: Artifact, files: boolean) {
  try {
    const r = await api.deleteArtifact(a.id, files);
    toast(files && r.removedFiles ? '制品和文件都已删除' : '已从库中移除', {
      description: files ? a.filename : '磁盘上的文件还在。',
    });
    return true;
  } catch (e: any) {
    toast.error('删除失败', { description: e.message });
    return false;
  }
}

/**
 * Load the exact inputs a run used into the studio form: the snapshot is
 * diffed against the stored workflow and saved as that workflow's draft.
 */
export async function reuseRun(runId: string) {
  try {
    const { workflow: snapshot, workflowId } = await api.runSnapshot(runId);
    if (!workflowId) throw new Error('这次运行不属于任何工作流');
    const s = useStore.getState();
    const base = await s.ensureGraph(workflowId);
    if (!base) throw new Error('找不到对应的工作流');
    const { patches, skipped } = diffPatches(base, snapshot);
    s.setDraft(workflowId, patches);
    s.openApp(workflowId);
    s.focusRun(runId);
    const n = Object.values(patches).reduce((k, p) => k + Object.keys(p).length, 0);
    toast.success('已载入这次的参数', {
      description: n
        ? `${n} 处与工作流默认值不同，已标记在表单里。${skipped ? `另有 ${skipped} 个节点已不在当前工作流中。` : ''}`
        : '和工作流默认值完全一样。',
    });
  } catch (e: any) {
    toast.error('载入参数失败', { description: e.message });
  }
}
