import { pathToFileURL } from "node:url";
import { expandHome, pathExists } from "../fs.js";

type SQLiteModule = typeof import("node:sqlite");
type SQLiteDatabase = InstanceType<SQLiteModule["DatabaseSync"]>;

export interface CopilotDbSession {
  id: string;
  cwd?: string;
  repository?: string;
  branch?: string;
  summary?: string;
}

export interface CopilotDbTurn {
  turnIndex: number;
  userMessage?: string;
  assistantResponse?: string;
}

export interface CopilotDbSessionWithTurns {
  session: CopilotDbSession;
  turns: CopilotDbTurn[];
}

export async function listCopilotDbSessions(path: string): Promise<CopilotDbSession[]> {
  return withReadOnlyDatabase(path, [], (db) => {
    const rows = db.prepare(`
      SELECT id, cwd, repository, branch, summary
      FROM sessions
      ORDER BY id
    `).all();
    return rows.flatMap((row) => {
      const id = optionalString(row.id);
      if (!id) return [];
      return [{
        id,
        cwd: optionalString(row.cwd),
        repository: optionalString(row.repository),
        branch: optionalString(row.branch),
        summary: optionalString(row.summary),
      }];
    });
  });
}

export async function readCopilotDbSession(path: string, id: string): Promise<CopilotDbSessionWithTurns | undefined> {
  return withReadOnlyDatabase(path, undefined, (db) => {
    const row = db.prepare(`
      SELECT id, cwd, repository, branch, summary
      FROM sessions
      WHERE id = ?
    `).get(id);
    const sessionId = optionalString(row?.id);
    if (!row || !sessionId) return undefined;

    const turns = db.prepare(`
      SELECT turn_index, user_message, assistant_response
      FROM turns
      WHERE session_id = ?
      ORDER BY turn_index
    `).all(id).map((turn) => ({
      turnIndex: typeof turn.turn_index === "number" ? turn.turn_index : Number(turn.turn_index),
      userMessage: optionalString(turn.user_message),
      assistantResponse: optionalString(turn.assistant_response),
    }));

    return {
      session: {
        id: sessionId,
        cwd: optionalString(row.cwd),
        repository: optionalString(row.repository),
        branch: optionalString(row.branch),
        summary: optionalString(row.summary),
      },
      turns,
    };
  });
}

async function withReadOnlyDatabase<T>(
  path: string,
  fallback: T,
  query: (db: SQLiteDatabase) => T,
): Promise<T> {
  const resolved = expandHome(path);
  if (!(await pathExists(resolved))) return fallback;

  let db: SQLiteDatabase | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const uri = `${pathToFileURL(resolved).href}?mode=ro`;
    db = new DatabaseSync(uri, { readOnly: true });
    return query(db);
  } catch {
    return fallback;
  } finally {
    try {
      db?.close();
    } catch {
      // A failed/opening connection has nothing useful left to close.
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
