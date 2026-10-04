import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchWorkerPool } from "../search-worker.js";
import { scanSession } from "../search.js";
import type { SessionRef } from "../types.js";

const state = vi.hoisted(() => ({ workers: [] as any[], reply: true, failConstruction: false }));
vi.mock("../search.js", () => ({ scanSession: vi.fn(async () => ({ found: [], diagnostics: [] })) }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { isMainThread: true, parentPort: null, workerData: undefined, Worker: class extends EventEmitter {
    dead = false;
    constructor() { super(); if (state.failConstruction) throw new Error("unsupported worker"); state.workers.push(this); }
    postMessage() { if (!this.dead && state.reply) queueMicrotask(() => this.emit("message", { found: [], diagnostics: [] })); }
    async terminate() { this.dead = true; this.emit("exit", 0); return 0; }
  } };
});
const ref: SessionRef = { agent: "dsh", id: "synthetic", path: "/synthetic" };
beforeEach(() => { state.workers = []; state.reply = true; state.failConstruction = false; vi.mocked(scanSession).mockClear(); });

describe("worker pool lifecycle", () => {
  it("reuses a live slot and terminates it on close", async () => {
    const pool = new SearchWorkerPool(2, "needle", 20, {});
    await pool.scan(ref); await pool.scan(ref);
    expect(state.workers).toHaveLength(1);
    expect(scanSession).not.toHaveBeenCalled();
    await pool.close();
    expect(state.workers.every(worker => worker.dead)).toBe(true);
  });

  it("does not hang when an idle worker exits between batches", async () => {
    const pool = new SearchWorkerPool(1, "needle", 20, {});
    try {
      await pool.scan(ref);
      await state.workers[0].terminate();
      expect(pool.backend).toContain("fallback");
      await pool.scan(ref);
      expect(scanSession).toHaveBeenCalledTimes(1);
    } finally { await pool.close(); }
  });

  it("retries a task whose active worker exits, and tolerates unsupported runtimes", async () => {
    state.reply = false;
    const pool = new SearchWorkerPool(1, "needle", 20, {});
    const pending = pool.scan(ref);
    await state.workers[0].terminate();
    await pending;
    expect(scanSession).toHaveBeenCalledTimes(1);
    await pool.close();
    state.failConstruction = true;
    const unsupported = new SearchWorkerPool(1, "needle", 20, {});
    await unsupported.scan(ref);
    expect(scanSession).toHaveBeenCalledTimes(2);
    await unsupported.close();
  });
});
