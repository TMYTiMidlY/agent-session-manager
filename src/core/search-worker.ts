import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { scanSession, type SearchOptions, type SessionScanResult } from "./search.js";
import type { SessionRef } from "./types.js";

const PROTOCOL = "asmgr-search-1";
export const isSearchWorker = !isMainThread && workerData?.protocol === PROTOCOL;
if (isSearchWorker) {
  parentPort!.on("message", async (ref: SessionRef) => {
    const result = await scanSession(ref, workerData.query, workerData.limit, workerData.options);
    parentPort!.postMessage(result);
  });
}

interface Slot {
  worker: Worker;
  busy: boolean;
  resolve?: (result: SessionScanResult) => void;
  reject?: (error: Error) => void;
}

/** Real CPU parallelism, unlike Promise concurrency around synchronous frame decoding. */
export class SearchWorkerPool {
  private slots: Slot[] = [];
  private failed = false;
  private closing = false;
  get backend(): string { return this.failed ? "in-process fallback" : `workers (${this.slots.length})`; }
  constructor(private count: number, private query: string, private limit: number,
    private options: Pick<SearchOptions, "role" | "cacheDir">) {}

  scan = async (ref: SessionRef): Promise<SessionScanResult> => {
    if (this.failed || this.closing) return scanSession(ref, this.query, this.limit, this.options);
    let slot = this.slots.find(candidate => !candidate.busy);
    try {
      if (!slot) {
        if (this.slots.length >= this.count) throw new Error("search pool exceeded bounded concurrency");
        // Source runs inherit tsx's loader; bundles load themselves; Bun compiled
        // bundles resolve their embedded entry. All modes exercise the same code.
        const worker = new Worker(new URL(import.meta.url), {
          workerData: { protocol: PROTOCOL, query: this.query, limit: this.limit, options: this.options },
        });
        slot = { worker, busy: false };
        const created = slot;
        worker.on("message", (result: SessionScanResult) => {
          created.resolve?.(result);
          created.resolve = undefined;
          created.reject = undefined;
          created.busy = false;
        });
        worker.on("error", error => {
          this.failed = true;
          created.reject?.(error);
          created.resolve = undefined;
          created.reject = undefined;
          created.busy = false;
        });
        worker.on("exit", code => {
          // An idle worker may die between batches. Never reuse its slot: a
          // postMessage to an already-exited worker can silently wait forever.
          if (!this.closing) this.failed = true;
          created.reject?.(new Error(`search worker exited (${code})`));
          created.reject = undefined;
          created.resolve = undefined;
          created.busy = false;
        });
        this.slots.push(slot);
      }
      const selected = slot;
      selected.busy = true;
      return await new Promise<SessionScanResult>((resolve, reject) => {
        selected.resolve = resolve;
        selected.reject = reject;
        selected.worker.postMessage(ref);
      });
    } catch {
      // A runtime lacking embedded worker support, or a worker crash, must not
      // be mistaken for an unreadable archive. Retry with the canonical reader.
      this.failed = true;
      return scanSession(ref, this.query, this.limit, this.options);
    }
  };

  async close(): Promise<void> {
    this.closing = true;
    await Promise.all(this.slots.map(slot => slot.worker.terminate()));
    this.slots = [];
  }
}
