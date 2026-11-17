import pc from 'picocolors';
/**
 * A single FIFO in front of ComfyUI. Every submission lands here first with
 * status 'queued'; the scheduler submits them one at a time in order, and
 * never hands a second one to ComfyUI while the previous task is still live.
 *
 * It's deliberately simple: in-memory queue, no persistence. If the server
 * restarts, the index.ts startup sanitizer fails any non-terminal rows.
 */
export class Scheduler {
    comfy;
    getTask;
    getSnapshot;
    onSubmitted;
    onFail;
    queue = []; // task ids waiting to be submitted
    current = null; // task id currently handed to ComfyUI
    pumping = false;
    constructor(comfy, getTask, getSnapshot, onSubmitted, onFail) {
        this.comfy = comfy;
        this.getTask = getTask;
        this.getSnapshot = getSnapshot;
        this.onSubmitted = onSubmitted;
        this.onFail = onFail;
    }
    enqueue(id) {
        if (this.queue.includes(id) || this.current === id)
            return;
        this.queue.push(id);
        void this.pump();
    }
    /** Index.ts calls this from `finalize()` when the live task reaches a
     *  terminal state. Safe to call for non-current ids. */
    notifyDone(id) {
        if (this.current === id) {
            this.current = null;
            void this.pump();
        }
    }
    /** Remove a queued task before it reaches ComfyUI. Returns true if it was
     *  still waiting (so the caller knows to mark it cancelled itself). */
    remove(id) {
        const i = this.queue.indexOf(id);
        if (i < 0)
            return false;
        this.queue.splice(i, 1);
        return true;
    }
    /** The id of the task we're currently waiting on ComfyUI for, or null. */
    get currentId() { return this.current; }
    /** Task ids still waiting in our FIFO, in submission order. */
    get waiting() { return [...this.queue]; }
    async pump() {
        if (this.pumping || this.current || !this.queue.length)
            return;
        this.pumping = true;
        try {
            while (!this.current && this.queue.length) {
                const id = this.queue.shift();
                const task = this.getTask(id);
                if (!task || task.status !== 'queued')
                    continue; // cancelled or gone
                const wf = this.getSnapshot(id);
                if (!wf) {
                    this.onFail(id, '找不到工作流快照，没法提交给 ComfyUI');
                    continue;
                }
                this.current = id;
                try {
                    const { prompt_id } = await this.comfy.submit(wf);
                    this.onSubmitted(id, prompt_id);
                    // keep this.current set — notifyDone() clears it after the run ends
                    return;
                }
                catch (e) {
                    console.error(pc.red('[queue] submit failed'), id, e?.message || e);
                    this.current = null;
                    this.onFail(id, e?.message || String(e));
                    // keep pumping; one broken task shouldn't block the rest
                }
            }
        }
        finally {
            this.pumping = false;
        }
    }
}
