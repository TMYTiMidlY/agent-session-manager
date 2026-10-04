import type { SearchDiagnostic } from "../../core/search.js";

/** Bounded, payload-free summaries keep stdout machine-readable and stderr useful. */
export class SearchDiagnosticReporter {
  private skipped = 0;
  private omitted = 0;
  private examples: string[] = [];
  private warnings = new Map<string, { message: string; sessions: Set<string> }>();
  constructor(private quiet = false, private verbose = false) {}

  observe = (diagnostic: SearchDiagnostic): void => {
    if (this.quiet) return;
    const { kind, session, code, message } = diagnostic;
    if (kind === "notice" && !this.verbose) return;
    if (this.verbose) console.error(`${kind}: ${session.path}：${message}`);
    if (kind === "unreadable") {
      this.skipped++;
      if (this.examples.length < 3) this.examples.push(`${session.path}：${message}`);
    } else {
      const key = `${kind}:${code}:${message}`;
      const previous = this.warnings.get(key);
      if (previous) previous.sessions.add(session.path);
      else if (this.warnings.size < 50) this.warnings.set(key, { message, sessions: new Set([session.path]) });
      else this.omitted++;
    }
  };

  finish(): void {
    if (this.quiet) return;
    if (this.skipped) console.error(`跳过无法解析的会话：${this.skipped} 个。${this.examples.join("；")}（--verbose 查看逐条详情）`);
    for (const { message, sessions } of this.warnings.values()) console.error(`${sessions.size} 个会话：${message}`);
    if (this.omitted) console.error(`另有 ${this.omitted} 条诊断超出摘要上限；--verbose 查看逐条详情`);
  }
}
