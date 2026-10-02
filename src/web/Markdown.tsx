import { Fragment, memo, useEffect, useMemo, useState } from "react";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import Markdown, { RuleType, type MarkdownToJSX } from "markdown-to-jsx";

import { extractMath, PLACEHOLDER, type MathSpan } from "./math.js";
import { Math } from "./Math.js";
import { Button, ContextMenu, MenuItem } from "./ui.js";
import { t } from "./i18n.js";
import { highlightLines, type Token } from "./codeHighlight.js";
import { dedentBlocks } from "./codeIndent.js";
export { CodeBox };

/** Leading whitespace in columns, tabs at 2, for the wrapped rows' hanging indent. */
function indentCols(line: string) {
  let n = 0;
  for (const c of line) {
    if (c === " ") n++;
    else if (c === "\t") n += 2 - (n % 2);
    else break;
  }
  return n;
}

/**
 * One fenced code block with a copy-to-clipboard button, coloured like the
 * editor (Dark+, loaded on demand) when its language is known.
 *
 * It keeps to the reading column and soft-wraps like the editor: each
 * continuation row keeps its line's indent behind a dim `↳` (`.code-line`).
 */
function CodeBox({
  lang,
  text,
  className,
}: {
  lang?: string;
  text: string;
  className: string;
}) {
  const displayText = dedentBlocks([text.split("\n")])[0].join("\n");
  const [copied, setCopied] = useState(false);
  const [colored, setColored] = useState<{
    text: string;
    lines: Token[][];
  } | null>(null);

  useEffect(() => {
    if (!lang) return;
    let live = true;
    highlightLines(lang, displayText).then(
      (lines) => live && lines && setColored({ text: displayText, lines }),
      () => {}, // No colour is the fallback, not an error.
    );
    return () => {
      live = false;
    };
  }, [lang, displayText]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard API can be denied/unavailable; failing silently beats a crash.
    }
  };

  // Colour lags the text by one parse while streaming; plain until it catches up.
  const lines =
    colored?.text === displayText
      ? colored.lines
      : displayText.split("\n").map((l) => [{ text: l, cls: "" }]);

  return (
    <div className={`group relative ${className}`}>
      {lang && (
        <div className="absolute top-1.5 left-2 font-mono text-caption text-neutral-600 select-none">
          {lang}
        </div>
      )}
      <Button
        variant="subtle"
        size="sm"
        className="absolute top-1 right-1 opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
        onClick={copy}
      >
        {copied ? t("Copied") : t("Copy")}
      </Button>
      <pre className="chat-code rounded-sm bg-neutral-900 p-2 pt-7 whitespace-pre-wrap wrap-anywhere text-neutral-300 [tab-size:2]">
        <code>
          {lines.map((tokens, i) => (
            <span
              key={i}
              className="code-line"
              style={
                {
                  "--indent": `${indentCols(tokens.map((tk) => tk.text).join(""))}ch`,
                } as React.CSSProperties
              }
            >
              {tokens.map((tk, j) =>
                tk.cls ? (
                  <span key={j} className={tk.cls}>
                    {tk.text}
                  </span>
                ) : (
                  tk.text
                ),
              )}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

/**
 * The drawn SVG as a PNG on the clipboard, 1024px on its long side so it stays
 * sharp when pasted. Drawn from the <img> already on screen: a data-URL SVG
 * without foreignObject does not taint the canvas. The blob goes in as a
 * promise so the copy keeps the click's user activation.
 */
function copyPng(img: HTMLImageElement) {
  const scale = 1024 / globalThis.Math.max(img.clientWidth, img.clientHeight);
  const canvas = document.createElement("canvas");
  canvas.width = globalThis.Math.round(img.clientWidth * scale);
  canvas.height = globalThis.Math.round(img.clientHeight * scale);
  canvas.getContext("2d")?.drawImage(img, 0, 0, canvas.width, canvas.height);
  const png = new Promise<Blob>((ok, fail) =>
    canvas.toBlob(
      (b) => (b ? ok(b) : fail(new Error("PNG encode failed"))),
      "image/png",
    ),
  );
  return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

/**
 * A fenced block. A finished `svg` block is drawn as the image itself, with
 * its code folded under a disclosure; while it streams it is plain code.
 * Right-click the image to copy it as PNG or as SVG code.
 */
function CodeBlock({ lang, text }: { lang?: string; text: string }) {
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    img: HTMLImageElement;
  } | null>(null);
  if (!(lang?.toLowerCase() === "svg" && text.includes("</svg>")))
    return <CodeBox lang={lang} text={text} className="chat-measure my-3" />;
  // Clipboard can be denied/unavailable; failing silently beats a crash.
  const act = (copy: () => Promise<void>) => () => {
    copy().catch(() => {});
    setMenu(null);
  };
  return (
    <div className="chat-measure my-3">
      {/* Through <img>, so scripts and external loads in the SVG never run. */}
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`}
        alt={t("SVG preview")}
        aria-haspopup="menu"
        onContextMenu={(e) => {
          e.preventDefault();
          // A keyboard-raised menu reports (0,0); anchor it to the image.
          const box = e.currentTarget.getBoundingClientRect();
          setMenu({
            x: e.clientX || box.left + 16,
            y: e.clientY || box.bottom,
            img: e.currentTarget,
          });
        }}
        className="h-48 w-auto max-w-full border border-transparent hover:border-neutral-700"
      />
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          label={t("SVG preview")}
          onClose={() => setMenu(null)}
        >
          <MenuItem
            role="menuitem"
            autoFocus
            onClick={act(() => copyPng(menu.img))}
          >
            {t("Copy as PNG")}
          </MenuItem>
          <MenuItem
            role="menuitem"
            onClick={act(() => navigator.clipboard.writeText(text))}
          >
            {t("Copy as SVG")}
          </MenuItem>
        </ContextMenu>
      )}
      <button
        data-custom="transcript disclosure"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="mt-1 flex items-center gap-1 chat-code font-mono text-neutral-500 hover:text-neutral-300"
      >
        {open ? <CaretDown size={11} /> : <CaretRight size={11} />}
        {t("Code")}
      </button>
      {open && <CodeBox lang={lang} text={text} className="mt-1" />}
    </div>
  );
}

/**
 * A text node's placeholders turned back into rendered math.
 *
 * A text node is where they always land: a placeholder is inert text, so the
 * parser leaves it inside whatever it was written in — a paragraph, a list
 * item, a table cell, a heading — which is exactly why the math survived the
 * parse in the first place. One node can hold several, hence the loop.
 */
function withMath(
  text: string,
  math: MathSpan[],
  key: string | number | undefined,
) {
  const parts: React.ReactNode[] = [];
  let rest = text;
  let n = 0;
  for (let m = PLACEHOLDER.exec(rest); m; m = PLACEHOLDER.exec(rest)) {
    if (m.index > 0) parts.push(rest.slice(0, m.index));
    const span = math[Number(m[1])];
    // A placeholder with no expression behind it cannot happen from
    // extractMath, but it CAN arrive from prose that contains the
    // private-use codepoints itself. Left as the text it is.
    parts.push(span ? <Math key={`${key}-m${n++}`} span={span} /> : m[0]);
    rest = rest.slice(m.index + m[0].length);
  }
  if (parts.length === 0) return text;
  if (rest) parts.push(rest);
  return <span key={key}>{parts}</span>;
}

/**
 * Route codeBlock/codeInline through our own components instead of the
 * `code`/`pre` tag overrides, and math placeholders back into math.
 *
 * Why not overrides: markdown-to-jsx renders both node kinds through the
 * SAME `code` tag, and the only prop that could distinguish them —
 * `className` — is unreliable: it is present with value `undefined` on
 * BOTH an unlabeled fenced block and genuine inline code, verified against
 * the installed 9.10.2 by direct compiler output, not just reading the
 * (minified) source. `renderRule` sees the AST node directly — `codeBlock`
 * vs `codeInline` is the actual parser decision, not a derived prop — so
 * this is the only discriminator that cannot silently misroute.
 *
 * It is also the only hook markdown-to-jsx offers for a syntax it does not
 * have: there is no way to add an inline rule, so math cannot be parsed here
 * — it is extracted before the parse and substituted back in here.
 */
function makeRenderRule(math: MathSpan[]) {
  return function renderRule(
    next: () => React.ReactNode,
    node: MarkdownToJSX.ASTNode,
    _renderChildren: MarkdownToJSX.ASTRender,
    state: MarkdownToJSX.State,
  ) {
    if (node.type === RuleType.codeBlock)
      return <CodeBlock key={state.key} lang={node.lang} text={node.text} />;
    if (node.type === RuleType.codeInline)
      return (
        <code
          key={state.key}
          className="rounded-sm bg-neutral-800 px-1 py-0.5 text-code-inline text-neutral-300"
        >
          {node.text}
        </code>
      );
    if (node.type === RuleType.text && math.length > 0)
      return withMath(node.text, math, state.key);
    return next();
  };
}

/**
 * Markdown overrides in the app's own tokens, so they follow the theme. Kept
 * intentionally plain (no typography plugin) since this is the only place in
 * the app that needs anything beyond `whitespace-pre-wrap`.
 *
 * `chat-measure` is on the elements that are READ — paragraphs, lists,
 * headings, quotes — and on code blocks, which soft-wrap instead of running
 * past the chat. Tables keep the full width of the track: a table squeezed
 * into 66 characters is unreadable.
 */
const options: MarkdownToJSX.Options = {
  /*
   * Without this, a reply short enough to hold no block element — "done",
   * a single sentence — is rendered inline, gets no `<p>`, and therefore
   * none of the `chat-measure` below: it lands flush against the gutter
   * while every other row in the transcript starts at the reading
   * column's left edge. The shortest answers were the misaligned ones.
   */
  forceBlock: true,
  // No wrapper div: every block is a sibling of the tool lines and reasoning
  // around it, so their `my-3` margins collapse into one gap.
  wrapper: Fragment,
  overrides: {
    a: {
      component: ({
        children,
        ...props
      }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <a
          {...props}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-400 underline hover:text-blue-300"
        >
          {children}
        </a>
      ),
    },
    ul: { props: { className: "chat-measure my-3 list-disc pl-5" } },
    ol: { props: { className: "chat-measure my-3 list-decimal pl-5" } },
    blockquote: {
      props: {
        className:
          "chat-measure my-3 border-l-2 border-neutral-700 pl-2 text-neutral-400 italic",
      },
    },
    h1: {
      props: { className: "chat-measure mt-3 mb-1 text-h1 font-semibold" },
    },
    h2: {
      props: { className: "chat-measure mt-3 mb-1 text-h2 font-semibold" },
    },
    h3: {
      props: { className: "chat-measure mt-3 mb-1 text-h3 font-semibold" },
    },
    h4: {
      props: { className: "chat-measure mt-2 mb-1 text-h3 font-semibold" },
    },
    table: { props: { className: "chat-wide my-3 border-collapse text-body" } },
    th: {
      props: {
        className:
          "border border-neutral-800 px-2 py-1 text-left font-semibold",
      },
    },
    td: { props: { className: "border border-neutral-800 px-2 py-1" } },
    // `my-3` is the one gap between every block in an answer (paragraphs,
    // reasoning, tool lines); margins collapse, so neighbours never add up.
    p: { props: { className: "chat-measure my-3" } },
  },
};

/**
 * Assistant prose only. Tool output, bash output, and echoed user input stay
 * plain `whitespace-pre-wrap` — those are verbatim text, not prose, and
 * markdown syntax characters in them (a `#` in a shell comment, a stray `_`
 * in a path) would otherwise get mangled into headings and italics.
 *
 * Memoized on `text`: message blocks are rebuilt into new array/object
 * instances on every snapshot refetch, but the string content of a settled
 * block never changes, so this skips re-parsing the whole document on
 * unrelated state updates. The one block still being streamed necessarily
 * gets a new `text` every delta and reparses — that one is expected to.
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  /*
   * Math out, then markdown. One `useMemo` for both, keyed on the text: the
   * extraction is a single pass and cheap, but the array identity is what
   * `renderRule` closes over, and a new one every render would rebuild the
   * options object and defeat markdown-to-jsx's own memoization.
   */
  const { source, math } = useMemo(() => extractMath(text), [text]);
  const opts = useMemo(
    () => ({
      ...options,
      renderRule: makeRenderRule(math),
      optimizeForStreaming: streaming,
    }),
    [math, streaming],
  );
  return <Markdown options={opts}>{source}</Markdown>;
});
