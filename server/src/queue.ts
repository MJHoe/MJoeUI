import pc from 'picocolors';
import type { ComfyClient } from './comfy.js';
import type { Task, Workflow } from './types.js';

/**
 * A single FIFO in front of ComfyUI. Every submission lands here first with
 * status 'queued'; the scheduler submits them one at a time in order, and
 * never hands a second one to ComfyUI while the previous task is still live.
 *
 * It's deliberately simple: in-memory queue, no persistence. If the server
 * restarts, tasks still waiting here are failed at startup; ones already
 * handed to ComfyUI are kept and settled by index.ts `reconcile()`.
 */
export class Scheduler {
  private queue: string[] = [];      // task ids waiting to be submitted
  private current: string | null = null; // task id currently handed to ComfyUI
  private pumping = false;

  constructor(
    private readonly comfy: ComfyClient,
    private readonly getTask: (id: string) => Task | undefined,
    private readonly getSnapshot: (id: string) => Workflow | null,
    private readonly onSubmitted: (id: string, promptId: string) => void,
    private readonly onFail: (id: string, err: string) => void,
  ) {}

  enqueue(id: string) {
    if (this.queue.includes(id) || this.current === id) return;
    this.queue.push(id);
    void this.pump();
  }

  /** Index.ts calls this from `finalize()` when the live task reaches a
   *  terminal state. Safe to call for non-current ids. */
  notifyDone(id: string) {
    if (this.current === id) {
      this.current = null;
      void this.pump();
    }
  }

  /** Remove a queued task before it reaches ComfyUI. Returns true if it was
   *  still waiting (so the caller knows to mark it cancelled itself). */
  remove(id: string): boolean {
    const i = this.queue.indexOf(id);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    return true;
  }

  /** The id of the task we're currently waiting on ComfyUI for, or null. */
  get currentId() { return this.current; }
  /** Task ids still waiting in our FIFO, in submission order. */
  get waiting() { return [...this.queue]; }

  private async pump() {
    if (this.pumping || this.current || !this.queue.length) return;
    this.pumping = true;
    try {
      while (!this.current && this.queue.length) {
        const id = this.queue.shift()!;
        const task = this.getTask(id);
        if (!task || task.status !== 'queued') continue; // cancelled or gone
        const wf = this.getSnapshot(id);
        if (!wf) { this.onFail(id, '找不到工作流快照，没法提交给 ComfyUI'); continue; }
        this.current = id;
        try {
          const { prompt_id } = await this.comfy.submit(wf);
          this.onSubmitted(id, prompt_id);
          // keep this.current set — notifyDone() clears it after the run ends
          return;
        } catch (e: any) {
          console.error(pc.red('[queue] submit failed'), id, e?.message || e);
          this.current = null;
          this.onFail(id, e?.message || String(e));
          // keep pumping; one broken task shouldn't block the rest
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
