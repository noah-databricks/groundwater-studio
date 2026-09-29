import type { ReactNode } from "react";

/** The markdown agents write: paragraphs, headings, nested lists, tables, fenced code, **bold**, *italic*, `code`
 *  and [links](url). Everything is rendered as React elements; nothing is injected as HTML. */
export function Markdown({ text }: { text: string }) {
  return <>{blocks(text.replace(/\r\n/g, "\n"))}</>;
}

function inline(s: string, k: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(((?:https?:\/\/|\/api\/volume-file\?)[^)\s]+)\)|(?<![*\w])\*[^*\n]+\*(?!\*))/g;
  let last = 0, m: RegExpExecArray | null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0], key = `${k}${i++}`;
    if (t.startsWith("**")) out.push(<b key={key}>{t.slice(2, -2)}</b>);
    else if (t.startsWith("`") && WS.test(t.slice(1, -1))) { const p = t.slice(1, -1); out.push(<a key={key} className="md-file" href={fileUrl(p)} target="_blank" rel="noreferrer">{p.split("/").pop()}</a>); }
    else if (t.startsWith("`")) out.push(<code key={key}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("[")) out.push(<a key={key} href={m[2]} target="_blank" rel="noreferrer">{t.slice(1, t.indexOf("]"))}</a>);
    else out.push(<i key={key}>{t.slice(1, -1)}</i>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const WS = /^\/Volumes\/[^\s`]+\/workspace\/[^\s`]+\.[a-z0-9]{2,5}$/i;
const fileUrl = (p: string) => `/api/volume-file?path=${encodeURIComponent(p)}`;

/** Files of the user's workspace a message refers to, by link or by path, in order and once each. */
export function filesIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\/api\/volume-file\?path=([^)\s&]+)|(\/Volumes\/[^\s`)"']+\/workspace\/[^\s`)"']+\.[a-z0-9]{2,5})/gi)) {
    const p = m[1] ? decodeURIComponent(m[1]) : m[2];
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
const numeric = (c: string) => /^[−+-]?[\d,.]+\s*(%|m|GL|ML|ha|pp|pp\/GL|s)?$/.test(c.replace(/\*\*/g, ""));

type Item = { text: string[]; kids: Item[]; ordered: boolean };

function blocks(src: string): ReactNode[] {
  const lines = src.split("\n"), out: ReactNode[] = [];
  let i = 0, n = 0;
  const key = () => `b${n++}`;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^\s*```/.test(l)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push(<pre key={key()}><code>{body.join("\n")}</code></pre>);
      continue;
    }
    if (l.trim().startsWith("|") && i + 1 < lines.length && SEP.test(lines[i + 1])) {
      const head = cells(l), rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      const num = head.map((_, c) => rows.length > 0 && rows.every((r) => !r[c] || numeric(r[c])));
      const k = key();
      out.push(
        <div key={k} className="md-table">
          <table>
            <thead><tr>{head.map((h, c) => <th key={c} className={num[c] ? "n" : ""}>{inline(h, `${k}h${c}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => <tr key={ri}>{head.map((_, c) => <td key={c} className={num[c] ? "n" : ""}>{inline(r[c] ?? "", `${k}${ri}.${c}`)}</td>)}</tr>)}</tbody>
          </table>
        </div>);
      continue;
    }
    const h = l.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) { const k = key(); out.push(<h4 key={k} className={`md-h${h[1].length}`}>{inline(h[2], k)}</h4>); i++; continue; }
    if (LIST.test(l)) {
      // one list, however the agent indents it: a bullet straight after a numbered item belongs to that item
      const top: Item[] = [];
      let base: number | null = null;
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (!m) {
          if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && top.length) { lastItem(top).text.push(lines[i].trim()); i++; continue; }
          break;
        }
        const indent = m[1].length, ordered = /\d/.test(m[2]);
        base ??= indent;
        const parent = top[top.length - 1];
        const nested = parent && (indent > base + 1 || (parent.ordered && !ordered && indent <= base));
        const item: Item = { text: [m[3]], kids: [], ordered };
        if (nested) parent.kids.push(item); else top.push(item);
        i++;
        if (i < lines.length && !lines[i].trim() && i + 1 < lines.length && LIST.test(lines[i + 1])) i++; // loose lists
      }
      out.push(list(top, key()));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !LIST.test(lines[i]) && !/^\s*(#{1,4}\s|```)/.test(lines[i])
      && !(lines[i].trim().startsWith("|") && i + 1 < lines.length && SEP.test(lines[i + 1]))) para.push(lines[i++]);
    const k = key();
    out.push(<p key={k}>{para.map((t, j) => <span key={j}>{j > 0 && <br />}{inline(t, `${k}${j}`)}</span>)}</p>);
  }
  return out;
}

function lastItem(items: Item[]): Item {
  const it = items[items.length - 1];
  return it.kids.length ? lastItem(it.kids) : it;
}

function list(items: Item[], k: string): ReactNode {
  const body = items.map((it, j) => (
    <li key={j}>
      {it.text.map((t, x) => <span key={x}>{x > 0 && <br />}{inline(t, `${k}${j}.${x}`)}</span>)}
      {it.kids.length > 0 && list(it.kids, `${k}${j}-`)}
    </li>));
  return items[0]?.ordered ? <ol key={k}>{body}</ol> : <ul key={k}>{body}</ul>;
}
