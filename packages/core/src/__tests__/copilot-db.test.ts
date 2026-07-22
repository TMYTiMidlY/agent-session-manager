import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCopilot, parseCopilot } from "../adapters/copilot.js";
import { searchRefs } from "../index.js";

const scratchDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Copilot session-store.db fallback", () => {
  it("unions DB-only sessions, prefers events, and parses lossy turns with provenance", async () => {
    const scratch = await mkdtemp(join(process.cwd(), ".core-copilot-db-"));
    scratchDirectories.push(scratch);
    const eventsRoot = join(scratch, "session-state");
    const dbPath = join(scratch, "session-store.db");

    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        repository TEXT,
        branch TEXT,
        summary TEXT
      );
      CREATE TABLE turns (
        session_id TEXT,
        turn_index INTEGER,
        user_message TEXT,
        assistant_response TEXT
      );
      INSERT INTO sessions VALUES
        ('event-session', '/workspace/event', 'owner/event', 'event-branch', 'Event summary'),
        ('db-only-session', '/workspace/db-only', 'owner/db-only', 'db-branch', 'DB-only summary');
      INSERT INTO turns VALUES
        ('db-only-session', 1, 'first DB question', 'first DB answer'),
        ('db-only-session', 2, 'second DB question', 'needle-in-db-response');
    `);
    db.close();

    const eventDirectory = join(eventsRoot, "event-session");
    await mkdir(eventDirectory, { recursive: true });
    await writeFile(join(eventDirectory, "events.jsonl"), [
      JSON.stringify({
        type: "session.start",
        data: {
          sessionId: "event-session",
          startTime: "2026-07-22T00:00:00.000Z",
          context: { cwd: "/workspace/event", repository: "owner/event" },
        },
        timestamp: "2026-07-22T00:00:00.000Z",
      }),
      JSON.stringify({
        type: "user.message",
        data: { content: "event-backed content" },
        timestamp: "2026-07-22T00:00:01.000Z",
      }),
      "",
    ].join("\n"));

    const refs = await discoverCopilot(eventsRoot, dbPath);
    expect(refs.map((ref) => ref.id)).toEqual(["db-only-session", "event-session"]);

    const eventRef = refs.find((ref) => ref.id === "event-session");
    expect(eventRef?.path).toBe(join(eventDirectory, "events.jsonl"));
    expect(eventRef?.source).toEqual({ kind: "events", path: eventRef?.path, lossy: false });
    const eventSession = await parseCopilot(eventRef!);
    expect(eventSession.source).toEqual({ kind: "events", path: eventRef?.path, lossy: false });
    expect(eventSession.branch).toBe("event-branch");

    const dbRef = refs.find((ref) => ref.id === "db-only-session");
    const session = await parseCopilot(dbRef!);
    expect(session.title).toBe("DB-only summary");
    expect(session.cwd).toBe("/workspace/db-only");
    expect(session.repository).toBe("owner/db-only");
    expect(session.branch).toBe("db-branch");
    expect(session.source).toEqual({ kind: "db-turns", path: dbPath, lossy: true });
    expect(session.entries.map((entry) => [entry.role, entry.text])).toEqual([
      ["user", "first DB question"],
      ["assistant", "first DB answer"],
      ["user", "second DB question"],
      ["assistant", "needle-in-db-response"],
    ]);

    const hits = await searchRefs(refs, "needle-in-db-response");
    expect(hits[0]?.session.id).toBe("db-only-session");
    expect(hits[0]?.session.source?.kind).toBe("db-turns");

    const eventsWithoutDb = await discoverCopilot(eventsRoot, join(scratch, "missing.db"));
    expect(eventsWithoutDb.map((ref) => ref.id)).toEqual(["event-session"]);
  });
});
