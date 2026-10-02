import { Fragment } from "react";

/** Inline pieces of one line: **bold** and citation markers like [1], which become numbered chips linking to the source. */
function inline(text: string, markers: Set<string>, anchor: (marker: string) => string) {
  // A marker hugs the words it supports: the space the model puts before "[1]" is dropped.
  return text.split(/(\*\*[^*]+\*\*|[ \t]*\[\d{1,2}\])/g).map((part, i) => {
    const cite = /^[ \t]*\[(\d{1,2})\]$/.exec(part);
    if (cite && markers.has(cite[1]!)) {
      return <a key={i} href={`#${anchor(cite[1]!)}`} className="ms-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 align-text-top text-[10px] font-semibold text-primary no-underline hover:bg-primary/25" aria-label={`Source ${cite[1]}`}>{cite[1]}</a>;
    }
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={i}>{part.slice(2, -2)}</strong>;
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/;

/** The short markdown an answer uses: paragraphs, bullet lists, bold and citation chips. Anything else shows as plain text. */
export function AnswerText({ markdown, markers, anchor }: { markdown: string; markers: string[]; anchor: (marker: string) => string }) {
  const known = new Set(markers);
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const line of markdown.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim())) {
    const list = BULLET_RE.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === list && list) last.lines.push(line);
    else blocks.push({ list, lines: [line] });
  }
  return (
    <div className="space-y-2" dir="auto">
      {blocks.map((b, i) =>
        b.list
          ? <ul key={i} className="list-disc space-y-1 ps-5">{b.lines.map((l, j) => <li key={j}>{inline(l.replace(BULLET_RE, ""), known, anchor)}</li>)}</ul>
          : <p key={i}>{inline(b.lines[0]!.replace(/^#{1,6}\s+/, ""), known, anchor)}</p>,
      )}
    </div>
  );
}
