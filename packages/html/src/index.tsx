import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import type { HighlighterCore, LanguageInput, ThemeInput } from "@shikijs/types";
import type { ParsedSession, TimelineEntry, ToolDetail, ToolResultKind } from "@agent-session-manager/core";
import { LOSSY_SOURCE_WARNING } from "@agent-session-manager/core";

const require = createRequire(import.meta.url);

/* ─────────────────────────────────────────────── syntax highlighting ── */

/**
 * Shiki-based syntax highlighting. Runs at SSR time — the emitted HTML is
 * fully self-contained (no client-side highlighter, no external CSS). Dual
 * theme (light + dark) so the theme toggle re-colours code without a
 * re-render. Mirrors dredge-up React's language set.
 */
const SHIKI_LANGS: Array<[string, () => Promise<{ default: unknown }>]> = [
  ["bash", () => import("@shikijs/langs/bash")],
  ["python", () => import("@shikijs/langs/python")],
  ["javascript", () => import("@shikijs/langs/javascript")],
  ["typescript", () => import("@shikijs/langs/typescript")],
  ["tsx", () => import("@shikijs/langs/tsx")],
  ["json", () => import("@shikijs/langs/json")],
  ["diff", () => import("@shikijs/langs/diff")],
  ["css", () => import("@shikijs/langs/css")],
  ["html", () => import("@shikijs/langs/html")],
  ["markdown", () => import("@shikijs/langs/markdown")],
  ["yaml", () => import("@shikijs/langs/yaml")],
  ["toml", () => import("@shikijs/langs/toml")],
  ["sql", () => import("@shikijs/langs/sql")],
  ["rust", () => import("@shikijs/langs/rust")],
  ["go", () => import("@shikijs/langs/go")],
];

const LANG_ALIAS: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash",
  py: "python",
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  rs: "rust",
  golang: "go",
};

let _highlighterPromise: Promise<HighlighterCore> | null = null;

async function initHighlighter(): Promise<HighlighterCore> {
  if (!_highlighterPromise) {
    _highlighterPromise = (async () => {
      const shiki = await import("shiki/core");
      const jsEngine = await import("shiki/engine/javascript");
      const [langModules, themeModules] = await Promise.all([
        Promise.all(SHIKI_LANGS.map(([, load]) => load())),
        Promise.all([
          import("@shikijs/themes/github-light"),
          import("@shikijs/themes/github-dark"),
        ]),
      ]);
      return shiki.createHighlighterCore({
        themes: themeModules.map((m) => m.default as ThemeInput),
        langs: langModules.map((m) => m.default as LanguageInput),
        engine: jsEngine.createJavaScriptRegexEngine(),
      });
    })();
  }
  return _highlighterPromise;
}

let _highlighter: HighlighterCore | null = null;

function highlight(code: string, lang: string | undefined): string {
  if (!_highlighter) return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  const raw = (lang ?? "").toLowerCase();
  const normalized = LANG_ALIAS[raw] ?? raw;
  const loaded = _highlighter.getLoadedLanguages();
  const useLang = normalized && loaded.includes(normalized) ? normalized : "text";
  return _highlighter.codeToHtml(code, {
    lang: useLang,
    themes: { light: "github-light", dark: "github-dark" },
    defaultColor: false,
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ─────────────────────────────────────────────── public api ───────────── */

export interface RenderHtmlOptions {
  /**
   * HTML fragment pinned to the top of the timeline as an "agent summary"
   * entry. Sanitization is the caller's responsibility — only pass content
   * you trust (typically agent-authored markup converted from Markdown).
   */
  summary?: string;
  /**
   * Optional data-source label. When set to anything other than
   * `"events.jsonl"` (the normal case) a warning pill appears in the
   * header, matching dredge-up's `⚠ 数据源回退到 db.turns` behaviour.
   */
  sourceLabel?: string;
}

export async function renderSessionHtml(
  session: ParsedSession,
  options: RenderHtmlOptions = {},
): Promise<string> {
  _highlighter = await initHighlighter();
  const markup = renderToStaticMarkup(
    <Report session={session} summary={options.summary} sourceLabel={options.sourceLabel} />,
  );
  return `<!doctype html>${markup}`;
}

/* ─────────────────────────────────────────────── filter taxonomy ──────── */

/**
 * Filter categories the UI exposes (one pill per category). They are derived
 * from `entry.role` plus a per-kind refinement for the `event` role.
 */
type FilterKey =
  | "summary"
  | "user"
  | "assistant"
  | "tool"
  | "reasoning"
  | "group"
  | "notification"
  | "handoff"
  | "compaction"
  | "task_complete"
  | "subagent"
  | "skill"
  | "plan"
  | "info"
  | "warning"
  | "error"
  | "system";
const PILL_ORDER: FilterKey[] = [
  "user", "assistant", "tool", "reasoning",
  "info", "warning", "error", "group", "notification", "handoff", "compaction", "task_complete",
  "summary", "subagent", "skill", "plan", "system",
];

interface PillDef {
  key: FilterKey;
  label: string;
  icon: string;
  accent: string;
}

const PILL_DEFS: Record<FilterKey, PillDef> = {
  summary:       { key: "summary",       label: "总结",     icon: "star",          accent: "amber" },
  user:          { key: "user",          label: "用户",     icon: "user",          accent: "blue" },
  assistant:     { key: "assistant",     label: "Copilot",  icon: "bot",           accent: "green" },
  tool:          { key: "tool",          label: "工具",     icon: "wrench",        accent: "violet" },
  reasoning:     { key: "reasoning",     label: "推理",     icon: "brain",         accent: "amber" },
  group:         { key: "group",         label: "分组",     icon: "layers",        accent: "violet" },
  notification:  { key: "notification",  label: "通知",     icon: "bell",          accent: "sky" },
  handoff:       { key: "handoff",       label: "交接",     icon: "shuffle",       accent: "sky" },
  compaction:    { key: "compaction",    label: "压缩",     icon: "circle-dashed", accent: "sky" },
  task_complete: { key: "task_complete", label: "任务完成", icon: "circle-check-big",accent: "emerald" },
  subagent:      { key: "subagent",      label: "子代理",   icon: "users",         accent: "violet" },
  skill:         { key: "skill",         label: "技能",     icon: "sparkles",      accent: "amber" },
  plan:          { key: "plan",          label: "计划",     icon: "list-checks",   accent: "green" },
  info:          { key: "info",          label: "信息",     icon: "info",          accent: "sky" },
  warning:       { key: "warning",       label: "警告",     icon: "alert-triangle",accent: "amber" },
  error:         { key: "error",         label: "错误",     icon: "x",             accent: "rose" },
  system:        { key: "system",        label: "系统",     icon: "info",          accent: "gray" },
};

function entryFilterKey(entry: TimelineEntry): FilterKey {
  if (entry.role === "user") return "user";
  if (entry.role === "assistant") return "assistant";
  if (entry.role === "reasoning") return "reasoning";
  if (entry.role === "tool") return "tool";
  if (entry.role === "system") return "system";
  // event role: split by kind
  if (entry.kind === "group") return "group";
  if (entry.kind === "notification") return "notification";
  if (entry.kind === "handoff") return "handoff";
  if (entry.kind === "compaction") return "compaction";
  if (entry.kind === "task_complete") return "task_complete";
  if (entry.kind === "subagent") return "subagent";
  if (entry.kind === "skill") return "skill";
  if (entry.kind === "plan") return "plan";
  if (entry.kind === "warning") return "warning";
  if (entry.kind === "error") return "error";
  return "info";
}

/* ─────────────────────────────────────────────── icons ────────────────── */

let _iconRoot: string | null = null;
function iconRoot(): string {
  if (_iconRoot) return _iconRoot;
  const pkg = require.resolve("lucide-static/package.json");
  _iconRoot = join(dirname(pkg), "icons");
  return _iconRoot;
}

const ICON_CACHE = new Map<string, string>();
function icon(name: string, size = 16): string {
  const key = `${name}@${size}`;
  if (ICON_CACHE.has(key)) return ICON_CACHE.get(key)!;
  let svg: string;
  try {
    svg = readFileSync(join(iconRoot(), `${name}.svg`), "utf8");
  } catch {
    svg = `<svg width="${size}" height="${size}"></svg>`;
  }
  svg = svg
    .replace(/<!--[^]*?-->/g, "")
    .replace(/\bwidth="\d+"/, `width="${size}"`)
    .replace(/\bheight="\d+"/, `height="${size}"`)
    .replace(/\s+/g, " ")
    .trim();
  ICON_CACHE.set(key, svg);
  return svg;
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return <span className="icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: icon(name, size) }} />;
}

/* ─────────────────────────────────────────────── report shell ─────────── */

function Report({ session, summary, sourceLabel }: { session: ParsedSession; summary?: string; sourceLabel?: string }) {
  const counts = countByFilter(session.entries, summary);
  const visiblePills = PILL_ORDER.filter((key) => counts[key] > 0);
  const title = reportTitle(session);
  const sessionStart = session.startedAt;
  const showFallbackWarning = sourceLabel && sourceLabel !== "events.jsonl";

  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <style dangerouslySetInnerHTML={{ __html: `${katexCss()}\n${css}` }} />
      </head>
      <body>
        <header className="topbar">
          <div className="title-row">
            <div>
              <h1>🌀 {title}</h1>
              <p>
                <code>{session.agent}</code> · <code>{session.id}</code>
              </p>
            </div>
            <div className="meta">
              {session.cwd && <span>{session.cwd}</span>}
              {sessionStart && <span>{formatStart(sessionStart)}</span>}
              {sessionStart && (
                <span>{elapsedStr(sessionStart, session.updatedAt)}</span>
              )}
              <span>{session.entries.length} entries</span>
              {showFallbackWarning && (
                <span className="fallback-warning" title="Data source is not the canonical events.jsonl">
                  ⚠ {LOSSY_SOURCE_WARNING}
                </span>
              )}
            </div>
          </div>

          <div className="controls">
            <label className="search">
              <Icon name="search" />
              <input id="search" placeholder="搜索(按 / 聚焦)" autoComplete="off" />
            </label>

            <div className="filters" aria-label="entry filters">
              {visiblePills.map((key) => {
                const def = PILL_DEFS[key];
                return (
                  <button key={key} type="button" className={`filter accent-${def.accent}`} data-filter={key} aria-pressed="true">
                    <Icon name={def.icon} />
                    <span>{def.label}</span>
                    <small>{counts[key]}</small>
                  </button>
                );
              })}
            </div>

            <div className="buttons">
              <button type="button" id="prev-user" title="上一条用户消息"><Icon name="chevron-up" /></button>
              <button type="button" id="next-user" title="下一条用户消息"><Icon name="chevron-down" /></button>
              <button type="button" id="collapse-all" title="全部折叠"><Icon name="fold-vertical" /></button>
              <button type="button" id="expand-all" title="全部展开"><Icon name="unfold-vertical" /></button>
              <button type="button" id="toggle-sidebar" title="切换侧栏" aria-pressed="true"><Icon name="rows-3" /></button>
              <button type="button" id="toggle-compact" title="切换显示密度" aria-label="切换显示密度" aria-pressed="false"><Icon name="rows-3" /></button>
              <button type="button" id="toggle-theme" title="当前为深色主题" aria-label="切换主题" aria-pressed="true">
                <span data-theme-icon="dark"><Icon name="moon" /></span>
                <span data-theme-icon="light" hidden><Icon name="sun" /></span>
              </button>
            </div>
          </div>
        </header>

        <div className="layout">
          <aside id="sidebar">
            <nav>
              {summary && (
                <a href="#entry-summary" data-nav-role="summary">
                  <span>★</span>
                  <strong>总结</strong>
                  <em>Agent summary</em>
                </a>
              )}
              {session.entries.map((entry) => {
                const key = entryFilterKey(entry);
                let text: string;
                if (entry.role === "tool" && entry.tool) {
                  const name = entry.tool.name ?? "(tool)";
                  text = entry.tool.intentionSummary
                    ? `${name} — ${entry.tool.intentionSummary}`
                    : name;
                } else {
                  text = firstLine(entry.title ?? entry.text);
                }
                return (
                  <a key={entry.index} href={`#entry-${entry.index}`} data-nav-role={key}>
                    <span>#{entry.index + 1}</span>
                    <strong>{PILL_DEFS[key].label}</strong>
                    <em>{text}</em>
                  </a>
                );
              })}
            </nav>
          </aside>

          <main>
            {summary && <SummaryCard html={summary} />}
            {session.entries.map((entry) => <Entry key={entry.index} entry={entry} sessionStart={sessionStart} />)}
            <footer>
              Generated by <strong>agent-session-manager</strong>. This file is self-contained and works offline.
            </footer>
          </main>
        </div>

        <script dangerouslySetInnerHTML={{ __html: clientScript }} />
      </body>
    </html>
  );
}

/* ─────────────────────────────────────────────── entry routing ────────── */

function Entry({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  if (entry.role === "tool") return <ToolCard entry={entry} sessionStart={sessionStart} />;
  if (entry.role === "event") return <EventCard entry={entry} sessionStart={sessionStart} />;
  if (entry.role === "user") return <SimpleEntry entry={entry} isMarkdown={false} icon="user" sessionStart={sessionStart} />;
  if (entry.role === "assistant") return <SimpleEntry entry={entry} isMarkdown icon="bot" sessionStart={sessionStart} />;
  if (entry.role === "reasoning") return <SimpleEntry entry={entry} isMarkdown={false} icon="brain" sessionStart={sessionStart} />;
  if (entry.role === "system") return <SimpleEntry entry={entry} isMarkdown={false} icon="info" sessionStart={sessionStart} />;
  return <SimpleEntry entry={entry} isMarkdown={false} icon="info" sessionStart={sessionStart} />;
}

/**
 * Default-open policy mirrors the Copilot bundle's own /share html except
 * that single-line info entries are expanded for immediate visibility.
 * Users can flip any card individually, or use the Collapse-all / Expand-all
 * buttons.
 */
function defaultOpen(entry: TimelineEntry): boolean {
  if (entry.role === "user" || entry.role === "assistant") return true;
  if (entry.role === "event" && entry.kind === "info" && !entry.text.includes("\n")) return true;
  if (entry.role === "event" && (entry.kind === "error" || entry.kind === "task_complete")) return true;
  return false;
}

function SimpleEntry({ entry, isMarkdown, icon: iconName, sessionStart }: { entry: TimelineEntry; isMarkdown: boolean; icon: string; sessionStart?: string }) {
  const key = entryFilterKey(entry);
  return (
    <details {...entryAttrs(entry, key)} open={defaultOpen(entry)}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name={iconName} />
        <span className="role">{PILL_DEFS[key].label}</span>
        <span className="snippet">{firstLine(entry.text)}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        {isMarkdown ? <Markdown text={entry.text} /> : <PreBlock text={entry.text} />}
      </div>
    </details>
  );
}

function ToolCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const tool = entry.tool ?? {};
  const result = tool.result;
  const resultType = (result?.type ?? "pending") as ToolResultKind;
  const args = renderArgsInline(tool.name, tool.arguments);
  return (
    <details {...entryAttrs(entry, "tool", `tool-${resultType}`)} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <span className={`tool-status status-${resultType}`} dangerouslySetInnerHTML={{ __html: icon(resultIcon(resultType)) }} />
        <Icon name="wrench" />
        <code className="tool-name">{tool.name ?? "(unnamed)"}</code>
        {args && <span className="tool-args">{args}</span>}
        {tool.intentionSummary && <span className="snippet">{tool.intentionSummary}</span>}
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        <ToolArgsBlock name={tool.name} args={tool.arguments} hadInline={Boolean(args)} />
        <ToolPartialOutput text={tool.partialOutput} />
        <ToolResult tool={tool} />
      </div>
    </details>
  );
}

function ToolArgsBlock({ name: _name, args, hadInline }: { name: string | undefined; args: unknown; hadInline: boolean }) {
  if (hadInline) return null;
  if (args == null) return null;
  let body: string;
  try { body = JSON.stringify(args, null, 2); }
  catch { body = String(args); }
  return (
    <details className="args-block" open={false}>
      <summary>Arguments</summary>
      <div dangerouslySetInnerHTML={{ __html: highlight(body, "json") }} />
    </details>
  );
}

function ToolResult({ tool }: { tool: ToolDetail }) {
  const result = tool.result;
  if (!result) return null;
  if (result.type === "rejected") return <p className="muted">_Rejected by user_</p>;
  if (result.type === "pending") return <p className="muted">_pending_</p>;
  const log = result.log ?? "";
  if (!log) return null;
  if (result.markdown) return <Markdown text={log} />;
  // Only run Shiki on diff-looking output — piping a huge `find` / `ls`
  // dump through the highlighter wraps every line in <span> pairs, ~2x
  // the raw size for no visual gain.
  if (isDiff(log)) {
    return <div dangerouslySetInnerHTML={{ __html: highlight(log, "diff") }} />;
  }
  return <pre className="plain">{log}</pre>;
}

function ToolPartialOutput({ text }: { text: string | undefined }) {
  if (!text) return null;
  return (
    <details className="args-block partial-output" open={false}>
      <summary>Partial Output</summary>
      <pre className="plain">{text}</pre>
    </details>
  );
}

function EventCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const kind = entry.kind;
  if (kind === "handoff") return <HandoffCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "compaction") return <CompactionCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "task_complete") return <TaskCompleteCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "group") return <GroupCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "subagent") return <SubagentCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "skill") return <SkillCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "plan") return <PlanCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "notification") return <NotificationCard entry={entry} sessionStart={sessionStart} />;
  if (kind === "warning") return <SimpleEntry entry={entry} isMarkdown={false} icon="alert-triangle" sessionStart={sessionStart} />;
  if (kind === "error") return <SimpleEntry entry={entry} isMarkdown={false} icon="x" sessionStart={sessionStart} />;
  return <SimpleEntry entry={entry} isMarkdown={false} icon="info" sessionStart={sessionStart} />;
}

function CompactionCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const data = entry.data ?? {};
  const success = data.success !== false;
  const stats = compactionStats(data);
  const label = success ? "压缩完成" : "压缩失败";
  return (
    <details
      {...entryAttrs(entry, "compaction", success ? "compaction-success" : "compaction-failure")}
      open={false}
    >
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name={success ? "circle-dashed" : "alert-triangle"} />
        <span className="role">{label}</span>
        <span className="snippet">{stats || firstLine(entry.text)}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        {stats && <p className="entry-stats">{stats}</p>}
        {entry.text && <div className="text-block">{entry.text}</div>}
      </div>
    </details>
  );
}

function TaskCompleteCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const failed = entry.data?.isError === true;
  const label = failed ? "任务失败" : "任务完成";
  return (
    <details
      {...entryAttrs(entry, "task_complete", failed ? "task-complete-error" : "task-complete-success")}
      open={defaultOpen(entry)}
    >
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name={failed ? "circle-x" : "circle-check-big"} />
        <span className="role">{label}</span>
        <span className="snippet">{firstLine(entry.text)}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        <Markdown text={entry.text} />
      </div>
    </details>
  );
}

function GroupCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const children = groupChildren(entry);
  const title = (entry.title ?? firstLine(entry.text)) || "Group";
  return (
    <details {...entryAttrs(entry, "group")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="layers" />
        <span className="role">分组</span>
        <span className="snippet">{title}{children.length > 0 ? ` · ${children.length} entries` : ""}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        {entry.text && entry.text !== title && <PreBlock text={entry.text} />}
        {children.length > 0 && (
          <div className="group-children">
            {children.map((child, index) => (
              <GroupChild key={`${child.index}-${index}`} entry={child} sessionStart={sessionStart} />
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function GroupChild({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const key = entryFilterKey(entry);
  const tool = entry.tool;
  const args = tool ? renderArgsInline(tool.name, tool.arguments) : null;
  const label = tool?.name ?? PILL_DEFS[key].label;
  return (
    <details className={`group-child group-child-${key}`} open={defaultOpen(entry)}>
      <summary>
        <Icon name={PILL_DEFS[key].icon} />
        <span className="role">{label}</span>
        {args && <span className="tool-args">{args}</span>}
        <span className="snippet">{tool?.intentionSummary ?? firstLine(entry.title ?? entry.text)}</span>
        {entry.timestamp && <time>{formatTime(entry.timestamp, sessionStart)}</time>}
      </summary>
      <div className="body">
        {tool ? (
          <>
            <ToolArgsBlock name={tool.name} args={tool.arguments} hadInline={Boolean(args)} />
            <ToolPartialOutput text={tool.partialOutput} />
            <ToolResult tool={tool} />
          </>
        ) : entry.role === "assistant" ? (
          <Markdown text={entry.text} />
        ) : (
          <PreBlock text={entry.text} />
        )}
      </div>
    </details>
  );
}

function SubagentCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const data = entry.data ?? {};
  const name = entry.title ?? "subagent";
  // Real subagent events only carry model (+ failed/error); no token/tool-call/duration stats.
  const model = typeof data.model === "string" ? data.model : undefined;
  const failed = data.failed === true;
  const error = typeof data.error === "string" ? data.error : undefined;
  const bits: string[] = [];
  if (model) bits.push(model);
  if (failed) bits.push("failed");
  const meta = bits.join(" · ");
  return (
    <details {...entryAttrs(entry, "subagent")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="users" />
        <span className="role">子代理</span>
        <span className="snippet">{meta ? `${name} — ${meta}` : name}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        {entry.text && <p>{entry.text}</p>}
        {model && <p className="muted">{model}</p>}
        {error && <p className="muted">Error: {error}</p>}
      </div>
    </details>
  );
}

function SkillCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const data = entry.data ?? {};
  const name = entry.title ?? "skill";
  const source = typeof data.source === "string" ? data.source : undefined;
  const trigger = typeof data.trigger === "string" ? data.trigger : undefined;
  return (
    <details {...entryAttrs(entry, "skill")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="sparkles" />
        <span className="role">技能</span>
        <span className="snippet">{source ? `${name} (${source})` : name}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        {entry.text && <p>{entry.text}</p>}
        {(source || trigger) && (
          <p className="entry-stats">
            {[source ? `Source: ${source}` : "", trigger ? `Trigger: ${trigger}` : ""].filter(Boolean).join(" · ")}
          </p>
        )}
      </div>
    </details>
  );
}

function PlanCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  return (
    <details {...entryAttrs(entry, "plan")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="list-checks" />
        <span className="role">计划</span>
        <span className="snippet">{firstLine(entry.text)}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        <PreBlock text={entry.text} />
      </div>
    </details>
  );
}

function HandoffCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const data = entry.data ?? {};
  const repo = (data.repository ?? {}) as { owner?: string; name?: string; branch?: string | null };
  const repoLabel = repo.owner && repo.name
    ? `${repo.owner}/${repo.name}${repo.branch ? ` (${repo.branch})` : ""}`
    : "(unknown)";
  return (
    <details {...entryAttrs(entry, "handoff")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="shuffle" />
        <span className="role">交接</span>
        <span className="snippet">{repoLabel}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        <p><strong>Repository:</strong> {repoLabel}</p>
        {typeof data.summary === "string" && data.summary && <p><strong>Summary:</strong> {data.summary}</p>}
      </div>
    </details>
  );
}

function NotificationCard({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  const kindPayload = entry.data?.kind;
  const detail = kindPayload && typeof kindPayload === "object"
    ? stringifyValue(kindPayload)
    : entry.detail;
  return (
    <details {...entryAttrs(entry, "notification")} open={false}>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">#{entry.index + 1}</span>
        <Icon name="bell" />
        <span className="role">通知</span>
        <span className="snippet">{firstLine(entry.text)}</span>
        <TimestampLink entry={entry} sessionStart={sessionStart} />
      </summary>
      <div className="body">
        <PreBlock text={entry.text} />
        {detail && (
          <details className="args-block" open={false}>
            <summary>Notification Detail</summary>
            <pre className="plain">{detail}</pre>
          </details>
        )}
      </div>
    </details>
  );
}

function SummaryCard({ html }: { html: string }) {
  return (
    <details id="entry-summary" className="entry summary" data-index="summary" data-filter="summary" data-text={`summary agent ${htmlToSearchText(html)}`.toLowerCase()} open>
      <summary>
        <span className="chevron">›</span>
        <span className="badge">★</span>
        <Icon name="star" />
        <span className="role">Agent 总结</span>
      </summary>
      <div className="body markdown" dangerouslySetInnerHTML={{ __html: html }} />
    </details>
  );
}

function TimestampLink({ entry, sessionStart }: { entry: TimelineEntry; sessionStart?: string }) {
  if (!entry.timestamp) return null;
  return (
    <a className="timestamp-link" href={`#entry-${entry.index}`} title="Permalink to this entry">
      <time dateTime={entry.timestamp}>{formatTime(entry.timestamp, sessionStart)}</time>
      <Icon name="link" size={12} />
    </a>
  );
}

/* ─────────────────────────────────────────────── helpers ──────────────── */

function entryAttrs(entry: TimelineEntry, key: FilterKey, extraClass = "") {
  return {
    id: `entry-${entry.index}`,
    className: `entry ${key} ${extraClass}`.trim(),
    "data-filter": key,
    "data-role": entry.role,
    "data-kind": entry.kind,
    "data-text": entrySearchText(entry),
  };
}

function entrySearchText(entry: TimelineEntry): string {
  const tool = entry.tool;
  return [
    entry.role,
    entry.kind,
    entry.rawType,
    entry.timestamp,
    entry.title,
    entry.text,
    entry.detail,
    stringifyValue(entry.data),
    tool?.callId,
    tool?.name,
    tool?.intentionSummary,
    stringifyValue(tool?.arguments),
    tool?.partialOutput,
    tool?.result?.type,
    tool?.result?.log,
  ].filter((value): value is string => Boolean(value)).join(" ").toLowerCase();
}

function stringifyValue(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function compactionStats(data: Record<string, unknown>): string {
  const bits: string[] = [];
  if (typeof data.preTokens === "number" && Number.isFinite(data.preTokens)) {
    bits.push(`${data.preTokens} tokens`);
  }
  if (typeof data.preMessages === "number" && Number.isFinite(data.preMessages)) {
    bits.push(`${data.preMessages} messages`);
  }
  if (typeof data.durationMs === "number" && Number.isFinite(data.durationMs)) {
    bits.push(`${(data.durationMs / 1000).toFixed(1)}s`);
  }
  if (typeof data.model === "string" && data.model) bits.push(data.model);
  if (typeof data.checkpointNumber === "number" && Number.isFinite(data.checkpointNumber)) {
    bits.push(`checkpoint #${data.checkpointNumber}`);
  }
  return bits.join(" · ");
}

function groupChildren(entry: TimelineEntry): TimelineEntry[] {
  const raw = entry.data?.children ?? entry.data?.entries;
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is TimelineEntry => {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<TimelineEntry>;
    return typeof candidate.index === "number"
      && typeof candidate.role === "string"
      && typeof candidate.kind === "string"
      && typeof candidate.text === "string";
  });
}

function renderArgsInline(name: string | undefined, args: unknown): string | null {
  if (!name || !args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (name === "grep" || name === "rg") {
    const parts = [`"${String(a.pattern ?? "")}"`];
    if (a.glob) parts.push(`in ${String(a.glob)}`);
    else if (a.type) parts.push(`in ${String(a.type)} files`);
    const p = pathsSummary(a);
    if (p) parts.push(`(${p})`);
    return parts.join(" ");
  }
  if (name === "glob") {
    const parts = [`"${String(a.pattern ?? "")}"`];
    const p = pathsSummary(a);
    if (p) parts.push(`in ${p}`);
    return parts.join(" ");
  }
  if (name === "bash" || name === "local_shell") return `$ ${String(a.command ?? "")}`;
  if (name === "view") {
    const path = String(a.path ?? "");
    const range = a.view_range;
    if (Array.isArray(range) && range.length === 2) {
      return `${path} (lines ${String(range[0])}-${String(range[1])})`;
    }
    return path;
  }
  if (name === "edit" || name === "create") return String(a.path ?? "");
  return null;
}

function pathsSummary(a: Record<string, unknown>): string | null {
  const raw = a.paths ?? a.path;
  if (!raw) return null;
  const items = (typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.map(String) : []).filter((x) => x && x !== ".");
  return items.length > 0 ? items.join(", ") : null;
}

function resultIcon(kind: ToolResultKind): string {
  if (kind === "success") return "check";
  if (kind === "failure") return "x";
  if (kind === "rejected") return "ban";
  if (kind === "denied") return "alert-triangle";
  return "hourglass";
}

function isDiff(text: string): boolean {
  return text.includes("diff --git") || (text.includes("@@") && (text.includes("+++") || text.includes("---")));
}

function htmlToSearchText(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: ({ children }) => <>{children}</>,
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || "");
            const code = String(children).replace(/\n$/u, "");
            if (match) {
              const rawLang = match[1]!.toLowerCase();
              const lang = LANG_ALIAS[rawLang] ?? rawLang;
              const isSupported = SHIKI_LANGS.some(([id]) => id === lang);
              if (isSupported) {
                return <div dangerouslySetInnerHTML={{ __html: highlight(code, lang) }} />;
              }
              // fall through to plain <pre> — no bloat for unknown languages
              return <pre className="plain"><code>{code}</code></pre>;
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function PreBlock({ text }: { text: string }) {
  return <pre className="plain">{text}</pre>;
}

function countByFilter(entries: TimelineEntry[], summary: string | undefined): Record<FilterKey, number> {
  const counts: Record<FilterKey, number> = Object.fromEntries(PILL_ORDER.map((k) => [k, 0])) as Record<FilterKey, number>;
  if (summary && summary.trim()) counts.summary = 1;
  for (const entry of entries) counts[entryFilterKey(entry)] += 1;
  return counts;
}

function reportTitle(session: ParsedSession): string {
  const explicit = session.title?.trim();
  if (explicit) return explicit;
  const firstUser = session.entries.find((entry) => entry.role === "user" && entry.text.trim());
  if (firstUser) return firstLine(firstUser.text);
  const repository = session.repository?.trim();
  if (repository) return repository;
  return `${session.agent} session`;
}

function firstLine(text: string): string {
  const line = (text ?? "").split("\n").find((item) => item.trim())?.trim() ?? "";
  return line.length > 100 ? `${line.slice(0, 100)}…` : line;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Header session-start format: 24-hour `YYYY-MM-DD HH:MM:SS` in local time.
 * We deliberately avoid `toLocaleString()` (default en-US, 12h AM/PM):
 * `"11:04:21 PM"` reads too easily as 11:04 morning when it means 23:04.
 */
function formatStart(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} `
    + `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * Per-entry timestamp: `HH:MM:SS` when on the same local date as the
 * session start; `MM-DD HH:MM:SS` when a session spans multiple days. If
 * `sessionStart` is missing (no `session.start` event), always fall back
 * to the compact same-day form.
 */
function formatTime(timestamp: string, sessionStart?: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (sessionStart) {
    const start = new Date(sessionStart);
    if (!Number.isNaN(start.getTime())
      && d.getFullYear() === start.getFullYear()
      && d.getMonth() === start.getMonth()
      && d.getDate() === start.getDate()
    ) {
      return time;
    }
  }
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${time}`;
}

/**
 * Elapsed pill in the header: `Ys` if under a minute, else `Xm Ys`.
 * `end` defaults to `now` — for a live-rendered report this shows time
 * since session start; for `updatedAt` we take the timestamp of the
 * last entry, so the pill reflects the session's actual span.
 */
function elapsedStr(start: string, end?: string): string {
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.max(0, Math.floor((e - s) / 1000));
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

let _katexCss: string | null = null;

function katexCss(): string {
  if (_katexCss !== null) return _katexCss;
  try {
    const cssPath = require.resolve("katex/dist/katex.min.css");
    const cssDir = dirname(cssPath);
    const raw = readFileSync(cssPath, "utf8");
    _katexCss = raw.replace(/src:([^}]*)/g, (_match, sources: string) => {
      const woff2 = sources.split(",").find((source) => source.includes(".woff2"));
      if (!woff2) return "";
      const embedded = woff2.replace(
        /url\((?:["']?)(fonts\/[^)"']+\.woff2)(?:["']?)\)/,
        (_url, relativePath: string) => {
          const base64 = readFileSync(join(cssDir, relativePath)).toString("base64");
          return `url(data:font/woff2;base64,${base64})`;
        },
      );
      return `src:${embedded}`;
    });
    return _katexCss;
  } catch {
    _katexCss = "";
    return _katexCss;
  }
}

/* ─────────────────────────────────────────────── client + css ─────────── */

const clientScript = String.raw`
(() => {
  const $ = (id) => document.getElementById(id);
  const entries = () => [...document.querySelectorAll('.entry')];
  const navLinks = () => [...document.querySelectorAll('#sidebar a')];
  let focusedEntry = null;
  let scrollFrame = 0;

  function clearHighlights() {
    document.querySelectorAll('mark.search-match').forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(document.createTextNode(mark.textContent || ''));
      parent?.normalize();
    });
  }

  function highlightText(node, query) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    if (!lower.includes(query)) return;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let match = lower.indexOf(query);
    while (match !== -1) {
      fragment.append(text.slice(cursor, match));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = text.slice(match, match + query.length);
      fragment.append(mark);
      cursor = match + query.length;
      match = lower.indexOf(query, cursor);
    }
    fragment.append(text.slice(cursor));
    node.replaceWith(fragment);
  }

  function highlightMatches(query) {
    clearHighlights();
    if (!query) return;
    entries().filter((entry) => !entry.hidden).forEach((entry) => {
      const walker = document.createTreeWalker(entry, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const parent = node.parentElement;
          if (!parent || parent.closest('script, style, mark.search-match, .icon')) {
            return NodeFilter.FILTER_REJECT;
          }
          return (node.nodeValue || '').toLowerCase().includes(query)
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      const nodes = [];
      while (walker.nextNode()) nodes.push(walker.currentNode);
      nodes.forEach((node) => highlightText(node, query));
    });
  }

  function setActiveNav(id) {
    navLinks().forEach((link) => {
      const active = link.getAttribute('href') === '#' + id;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
  }

  function syncActiveNav() {
    const visible = entries().filter((entry) => !entry.hidden);
    if (visible.length === 0) return;
    const y = window.scrollY + 150;
    const active = visible.filter((entry) => entry.offsetTop <= y).at(-1) || visible[0];
    if (active) setActiveNav(active.id);
  }

  function applyFilters() {
    const q = ($('search')?.value || '').trim().toLowerCase();
    const active = new Set([...document.querySelectorAll('.filter[aria-pressed="true"]')].map((b) => b.dataset.filter));
    entries().forEach((entry) => {
      const key = entry.dataset.filter || entry.dataset.role || '';
      const visible = active.has(key) && (!q || (entry.dataset.text || '').includes(q));
      entry.hidden = !visible;
    });
    navLinks().forEach((link) => {
      const target = document.querySelector(link.getAttribute('href'));
      link.hidden = !target || target.hidden;
    });
    if (focusedEntry?.hidden) {
      focusedEntry.classList.remove('keyboard-focus');
      focusedEntry = null;
    }
    highlightMatches(q);
    syncActiveNav();
  }

  function setAll(open) { entries().forEach((entry) => { if (!entry.hidden) entry.open = open; }); }

  function focusEntry(entry, scroll = true) {
    if (!entry || entry.hidden) return;
    focusedEntry?.classList.remove('keyboard-focus');
    focusedEntry = entry;
    entry.classList.add('keyboard-focus');
    entry.focus({ preventScroll: true });
    if (scroll) entry.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setActiveNav(entry.id);
  }

  function moveEntry(direction) {
    const visible = entries().filter((entry) => !entry.hidden);
    if (visible.length === 0) return;
    const current = focusedEntry ? visible.indexOf(focusedEntry) : -1;
    let next;
    if (current >= 0) {
      next = Math.max(0, Math.min(visible.length - 1, current + direction));
    } else {
      const y = window.scrollY + 150;
      const ahead = visible.findIndex((entry) => entry.offsetTop >= y);
      next = direction > 0
        ? (ahead < 0 ? visible.length - 1 : ahead)
        : Math.max(0, (ahead < 0 ? visible.length : ahead) - 1);
    }
    focusEntry(visible[next]);
  }

  function jumpUser(dir) {
    const users = entries().filter((entry) => entry.dataset.filter === 'user' && !entry.hidden);
    const y = window.scrollY + 160;
    const target = dir > 0
      ? users.find((entry) => entry.offsetTop > y)
      : users.filter((entry) => entry.offsetTop < y - 40).at(-1);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('search')?.addEventListener('input', applyFilters);
  document.addEventListener('keydown', (event) => {
    const activeTag = document.activeElement?.tagName || '';
    const isInteractive = ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(activeTag)
      || document.activeElement?.isContentEditable;
    if (event.key === '/' && !isInteractive) {
      event.preventDefault();
      $('search')?.focus();
      return;
    }
    if (event.key === 'Escape' && $('search')?.value) {
      event.preventDefault();
      $('search').value = '';
      applyFilters();
      return;
    }
    if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !isInteractive) {
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        moveEntry(event.key === 'j' ? 1 : -1);
      } else if (event.key === 'Enter' && focusedEntry) {
        event.preventDefault();
        focusedEntry.open = !focusedEntry.open;
      }
    }
  });
  document.querySelectorAll('.filter').forEach((button) => {
    button.addEventListener('click', () => {
      const next = button.getAttribute('aria-pressed') !== 'true';
      button.setAttribute('aria-pressed', String(next));
      applyFilters();
    });
  });
  $('collapse-all')?.addEventListener('click', () => setAll(false));
  $('expand-all')?.addEventListener('click', () => setAll(true));
  $('prev-user')?.addEventListener('click', () => jumpUser(-1));
  $('next-user')?.addEventListener('click', () => jumpUser(1));
  $('toggle-sidebar')?.addEventListener('click', () => {
    document.body.classList.toggle('no-sidebar');
    const el = $('toggle-sidebar');
    if (el) el.setAttribute('aria-pressed', String(!document.body.classList.contains('no-sidebar')));
  });
  $('toggle-compact')?.addEventListener('click', () => {
    const nextCompact = !document.body.classList.contains('compact');
    document.body.classList.toggle('compact', nextCompact);
    const el = $('toggle-compact');
    if (el) el.setAttribute('aria-pressed', String(nextCompact));
    localStorage.setItem('agent-session-manager-compact', nextCompact ? '1' : '0');
  });

  function syncThemeControl(isDark) {
    const button = $('toggle-theme');
    if (!button) return;
    button.setAttribute('aria-pressed', String(isDark));
    button.setAttribute('title', isDark ? '当前为深色主题' : '当前为浅色主题');
    const darkIcon = button.querySelector('[data-theme-icon="dark"]');
    const lightIcon = button.querySelector('[data-theme-icon="light"]');
    if (darkIcon) darkIcon.hidden = !isDark;
    if (lightIcon) lightIcon.hidden = isDark;
  }

  function setTheme(isDark) {
    document.documentElement.classList.toggle('dark', isDark);
    document.documentElement.classList.toggle('light', !isDark);
    syncThemeControl(isDark);
  }

  $('toggle-theme')?.addEventListener('click', () => {
    const nextDark = !document.documentElement.classList.contains('dark');
    setTheme(nextDark);
    localStorage.setItem('agent-session-manager-theme', nextDark ? 'dark' : 'light');
  });
  if (localStorage.getItem('agent-session-manager-compact') === '1') {
    document.body.classList.add('compact');
    $('toggle-compact')?.setAttribute('aria-pressed', 'true');
  }
  const savedTheme = localStorage.getItem('agent-session-manager-theme');
  setTheme(savedTheme !== 'light');

  entries().forEach((entry) => {
    entry.tabIndex = -1;
    entry.addEventListener('click', () => {
      if (!entry.hidden) focusEntry(entry, false);
    });
  });
  navLinks().forEach((link) => {
    link.addEventListener('click', () => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target?.matches('details.entry')) {
        target.open = true;
        focusEntry(target, false);
      }
    });
  });
  document.querySelectorAll('.timestamp-link').forEach((link) => {
    link.addEventListener('click', (event) => event.stopPropagation());
  });

  function expandHashTarget() {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (!id) return;
    const target = $(id);
    if (target?.matches('details.entry')) {
      target.open = true;
      focusEntry(target, false);
    }
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(() => syncActiveNav(), {
      rootMargin: '-120px 0px -65% 0px',
      threshold: [0, 1],
    });
    entries().forEach((entry) => observer.observe(entry));
  }
  window.addEventListener('scroll', () => {
    if (scrollFrame) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = 0;
      syncActiveNav();
    });
  }, { passive: true });
  window.addEventListener('hashchange', expandHashTarget);
  applyFilters();
  expandHashTarget();
})();
`;

const css = `
:root {
  color-scheme: light;
  --bg:#ffffff; --panel:#f6f8fa; --panel2:#eef1f4; --text:#1f2328; --muted:#59636e;
  --border:#d8dee4; --code:#f6f8fa;
  --blue:#0969da; --green:#1a7f37; --violet:#8250df;
  --amber:#9a6700; --red:#cf222e; --gray:#6e7781; --sky:#0969da; --emerald:#1a7f37; --rose:#cf222e;
}
.dark {
  color-scheme: dark;
  --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --text:#e6edf3; --muted:#9aa3b2;
  --border:#30363d; --code:#0b0f17;
  --blue:#58a6ff; --green:#3fb950; --violet:#a371f7;
  --amber:#d29922; --red:#ff7b72; --gray:#8b949e; --sky:#79c0ff; --emerald:#3fb950; --rose:#ff7b72;
}
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.65 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
.icon { display:inline-flex; align-items:center; justify-content:center; }
.icon svg { vertical-align:-3px; }
.topbar { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--bg) 90%, transparent); border-bottom:1px solid var(--border); backdrop-filter:blur(10px); }
.title-row { max-width:1280px; margin:0 auto; display:flex; justify-content:space-between; gap:24px; padding:14px 20px 8px; }
h1 { margin:0; font-size:19px; }
p { margin:4px 0 0; color:var(--muted); }
code { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.meta { display:flex; flex-direction:column; align-items:flex-end; gap:2px; color:var(--muted); font-size:12px; }
.controls { max-width:1280px; margin:0 auto; display:flex; align-items:center; flex-wrap:wrap; gap:8px; padding:0 20px 12px; }
.search { display:flex; align-items:center; gap:6px; height:34px; padding:0 10px; border:1px solid var(--border); border-radius:10px; background:var(--panel); }
.search input { width:240px; border:0; outline:0; background:transparent; color:var(--text); font:inherit; }
.filters { display:flex; flex-wrap:wrap; gap:5px; }
button { border:1px solid var(--border); background:var(--panel); color:var(--text); border-radius:999px; padding:6px 10px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; font:inherit; }
button:hover { background:var(--panel2); }
.filter[aria-pressed="false"] { opacity:.45; }
.buttons button[aria-pressed="true"] { border-color:color-mix(in srgb, var(--blue) 55%, var(--border)); color:var(--blue); }
.filter small { color:var(--muted); }
.filter.accent-blue { color:var(--blue); } .filter.accent-green { color:var(--green); }
.filter.accent-violet { color:var(--violet); } .filter.accent-amber { color:var(--amber); }
.filter.accent-sky { color:var(--sky); } .filter.accent-emerald { color:var(--emerald); }
.filter.accent-rose { color:var(--rose); } .filter.accent-gray { color:var(--gray); }
.buttons { margin-left:auto; display:flex; flex-wrap:wrap; gap:5px; }
.layout { max-width:1280px; margin:0 auto; display:grid; grid-template-columns:260px minmax(0, 1fr); gap:20px; padding:20px; }
body.no-sidebar .layout { grid-template-columns:1fr; } body.no-sidebar #sidebar { display:none; }
#sidebar { position:sticky; top:116px; align-self:start; max-height:calc(100vh - 132px); overflow:auto; }
#sidebar nav { display:flex; flex-direction:column; gap:4px; }
#sidebar a { display:grid; grid-template-columns:auto auto minmax(0, 1fr); gap:6px; padding:5px 8px; color:var(--muted); text-decoration:none; border-radius:8px; font-size:13px; }
#sidebar a:hover { background:var(--panel); color:var(--text); }
#sidebar a.active { background:var(--panel2); color:var(--text); }
#sidebar em { overflow:hidden; white-space:nowrap; text-overflow:ellipsis; font-style:normal; }
main { min-width:0; }
.entry { scroll-margin-top:130px; margin:0 0 12px; background:var(--panel); border:1px solid var(--border); border-left-width:3px; border-radius:12px; overflow:hidden; }
.entry.keyboard-focus { outline:2px solid color-mix(in srgb, var(--blue) 70%, transparent); outline-offset:3px; }
.entry.user { border-left-color:var(--blue); }
.entry.assistant { border-left-color:var(--green); }
.entry.reasoning { border-left-color:var(--amber); }
.entry.tool { border-left-color:var(--violet); }
.entry.tool.tool-success { border-left-color:var(--green); }
.entry.tool.tool-failure { border-left-color:var(--red); }
.entry.tool.tool-rejected { border-left-color:var(--gray); }
.entry.tool.tool-denied { border-left-color:var(--amber); }
.entry.tool.tool-pending { border-left-color:var(--blue); }
.entry.group { border-left-color:var(--violet); }
.entry.notification { border-left-color:var(--sky); }
.entry.handoff { border-left-color:var(--sky); }
.entry.compaction { border-left-color:var(--gray); }
.entry.compaction.compaction-failure { border-left-color:var(--red); }
.entry.task_complete { border-left-color:var(--emerald); }
.entry.task_complete.task-complete-error { border-left-color:var(--red); }
.entry.info { border-left-color:var(--sky); }
.entry.warning { border-left-color:var(--amber); }
.entry.error { border-left-color:var(--rose); }
.entry.system { border-left-color:var(--gray); }
.entry.summary { border-left-color:var(--amber); }
.entry summary { display:flex; align-items:center; gap:9px; padding:10px 13px; cursor:pointer; list-style:none; }
.entry summary::-webkit-details-marker { display:none; }
.entry[open] .chevron { transform:rotate(90deg); }
.chevron { color:var(--muted); transition:transform .15s ease; font-size:18px; }
.badge { border:1px solid var(--border); border-radius:7px; padding:1px 7px; color:var(--muted); font-size:12px; font-weight:700; }
.role { font-weight:700; }
.entry.user .role { color:var(--blue); } .entry.assistant .role { color:var(--green); }
.entry.reasoning .role { color:var(--amber); } .entry.notification .role { color:var(--sky); }
.entry.group .role { color:var(--violet); } .entry.handoff .role { color:var(--sky); }
.entry.task_complete .role { color:var(--emerald); } .entry.task_complete.task-complete-error .role { color:var(--red); }
.entry.compaction.compaction-failure .role { color:var(--red); }
.entry.summary .role { color:var(--amber); }
.tool-name { color:var(--violet); font-weight:600; padding:0 4px; border:1px solid var(--border); border-radius:6px; background:var(--code); font-size:13px; }
.tool-status { display:inline-flex; align-items:center; justify-content:center; width:18px; }
.tool-status.status-success { color:var(--green); }
.tool-status.status-failure { color:var(--red); }
.tool-status.status-rejected { color:var(--gray); }
.tool-status.status-denied { color:var(--amber); }
.tool-status.status-pending { color:var(--blue); }
.tool-args { color:var(--muted); font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:520px; }
.snippet { min-width:0; flex:1; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; color:var(--muted); font-size:13px; }
time { color:var(--muted); font-size:12px; }
.timestamp-link { display:inline-flex; align-items:center; gap:4px; color:var(--muted); text-decoration:none; }
.timestamp-link .icon { opacity:0; transition:opacity .15s ease; }
.timestamp-link:hover .icon, .timestamp-link:focus-visible .icon { opacity:1; }
.body { border-top:1px solid var(--border); padding:13px; }
.plain, .markdown pre { margin:0; white-space:pre-wrap; word-break:break-word; overflow:auto; border:1px solid var(--border); border-radius:10px; background:var(--code); padding:12px; font:13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.text-block { white-space:pre-wrap; overflow-wrap:anywhere; border:1px solid var(--border); border-radius:10px; background:var(--code); padding:12px; }
.entry-stats { margin:0 0 10px; color:var(--muted); font-size:13px; }
.partial-output + .plain, .partial-output + .markdown { margin-top:10px; }
.group-children { display:flex; flex-direction:column; gap:9px; }
.group-child { border:1px solid var(--border); border-radius:10px; background:var(--bg); overflow:hidden; }
.group-child > summary { display:flex; align-items:center; gap:8px; padding:8px 10px; cursor:pointer; list-style:none; }
.group-child > summary::-webkit-details-marker { display:none; }
.group-child > .body { padding:10px; }
mark.search-match { background:#f8e16c; color:#111; border-radius:2px; padding:0 .08em; }
/* Shiki-highlighted blocks: keep the border + radius our other pres have, and swap fg/bg with the CSS variables the theme toggle drives. */
.shiki { margin:0; border:1px solid var(--border); border-radius:10px; padding:12px; font:13px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow:auto; }
html:not(.dark) .shiki { background-color: var(--shiki-light-bg, #ffffff); color: var(--shiki-light, inherit); }
html.dark .shiki { background-color: var(--shiki-dark-bg, #0d1117); color: var(--shiki-dark, inherit); }
html:not(.dark) .shiki span { color: var(--shiki-light, inherit); }
html.dark .shiki span { color: var(--shiki-dark, inherit); }
.muted { color:var(--muted); font-style:italic; }
.fallback-warning { color:var(--amber); font-weight:600; }
.args-block { margin:0 0 10px; }
.args-block > summary { cursor:pointer; color:var(--muted); font-size:13px; padding:4px 0; }
.markdown > *:first-child { margin-top:0; } .markdown > *:last-child { margin-bottom:0; }
.markdown h1, .markdown h2, .markdown h3 { line-height:1.3; margin:1em 0 .4em; }
.markdown p, .markdown ul, .markdown ol { margin:.55em 0; }
.markdown ul, .markdown ol { padding-left:1.5em; }
.markdown blockquote { margin:.7em 0; padding-left:1em; border-left:3px solid var(--border); color:var(--muted); }
.markdown table { border-collapse:collapse; display:block; overflow:auto; margin:.8em 0; }
.markdown th, .markdown td { border:1px solid var(--border); padding:6px 10px; }
.markdown th { background:var(--panel2); }
.markdown :not(pre) > code { background:var(--panel2); border:1px solid var(--border); border-radius:5px; padding:.1em .35em; }
.katex-display { overflow-x:auto; overflow-y:hidden; padding:.2em 0; }
footer { color:var(--muted); text-align:center; font-size:12px; padding:18px 0; }
.compact { font-size:14px; }
.compact .entry { margin-bottom:7px; }
.compact .entry summary { padding:7px 10px; }
.compact .body { padding:9px; }
.compact .plain, .compact .markdown pre { font-size:12px; padding:9px; }
@media (max-width: 860px) {
  .layout { grid-template-columns:1fr; } #sidebar { display:none; }
  .title-row { flex-direction:column; } .meta { align-items:flex-start; } .buttons { margin-left:0; }
  .tool-args { max-width:240px; }
}
`;
