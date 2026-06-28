import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ParsedSession, TimelineEntry } from "@session-recall/core";

export function renderSessionHtml(session: ParsedSession): string {
  const markup = renderToStaticMarkup(<Report session={session} />);
  return `<!doctype html>${markup}`;
}

function Report({ session }: { session: ParsedSession }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{`${session.agent} session ${session.id}`}</title>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        <header>
          <div>
            <h1>{session.title ?? session.id}</h1>
            <p>{session.agent} · {session.id}</p>
          </div>
          <div className="meta">
            {session.cwd && <span>{session.cwd}</span>}
            {session.startedAt && <span>{session.startedAt}</span>}
          </div>
        </header>
        <main>
          <aside>
            {session.entries.map((entry) => (
              <a key={entry.index} href={`#e${entry.index}`}>{entry.index + 1}. {entry.role}</a>
            ))}
          </aside>
          <section>
            {session.entries.map((entry) => <Entry key={entry.index} entry={entry} />)}
          </section>
        </main>
      </body>
    </html>
  );
}

function Entry({ entry }: { entry: TimelineEntry }) {
  return (
    <article id={`e${entry.index}`} className={`entry ${entry.role}`}>
      <div className="entry-head">
        <span className="pill">{entry.role}</span>
        <strong>{entry.kind}{entry.title ? ` · ${entry.title}` : ""}</strong>
        {entry.timestamp && <time>{entry.timestamp}</time>}
      </div>
      <pre>{entry.text}</pre>
    </article>
  );
}

const css = `
:root { color-scheme: dark; --bg:#0d1117; --panel:#161b22; --text:#e6edf3; --muted:#8b949e; --border:#30363d; --accent:#2f81f7; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif; }
header { position:sticky; top:0; z-index:2; display:flex; justify-content:space-between; gap:24px; padding:16px 24px; background:rgba(13,17,23,.94); border-bottom:1px solid var(--border); backdrop-filter: blur(10px); }
h1 { margin:0; font-size:18px; }
p { margin:4px 0 0; color:var(--muted); }
.meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; color:var(--muted); font-size:12px; }
main { display:grid; grid-template-columns:240px minmax(0, 1fr); gap:20px; max-width:1400px; margin:0 auto; padding:20px; }
aside { position:sticky; top:82px; align-self:start; max-height:calc(100vh - 100px); overflow:auto; display:flex; flex-direction:column; gap:6px; }
aside a { color:var(--muted); text-decoration:none; padding:4px 8px; border-radius:6px; }
aside a:hover { background:var(--panel); color:var(--text); }
.entry { background:var(--panel); border:1px solid var(--border); border-radius:10px; margin:0 0 14px; overflow:hidden; }
.entry-head { display:flex; align-items:center; gap:10px; padding:10px 12px; border-bottom:1px solid var(--border); }
.pill { border:1px solid var(--border); border-radius:999px; padding:2px 8px; color:#fff; background:var(--accent); font-size:12px; }
time { margin-left:auto; color:var(--muted); font-size:12px; }
pre { margin:0; padding:12px; white-space:pre-wrap; word-break:break-word; font:13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; }
.user .pill { background:#1f6feb; }
.assistant .pill { background:#238636; }
.tool .pill { background:#8957e5; }
.reasoning .pill { background:#9e6a03; }
.system .pill, .event .pill { background:#6e7681; }
@media (max-width: 800px) { main { grid-template-columns:1fr; } aside { display:none; } header { flex-direction:column; } .meta { align-items:flex-start; } }
`;
