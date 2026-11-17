import { useMemo } from 'react';
import { useStore, usePatches } from '../store';
import type { Workflow } from '../types';
import { buildSections } from './workflow';
import { useObjectInfo } from './useObjectInfo';

export function useSections(workflow: Workflow, exposed?: string[] | null) {
  const connected = useStore((s) => s.connected);
  const patches = usePatches();
  const infos = useObjectInfo(workflow, connected);
  return useMemo(() => buildSections(workflow, infos, patches, exposed), [workflow, infos, patches, exposed]);
}
