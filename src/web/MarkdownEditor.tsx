import { memo } from "react";
import Markdown from "markdown-to-jsx";
import { t } from "./i18n.js";

const options = {
  forceBlock: true,
  disableParsingRawHTML: true,
  overrides: {
    h1: { props: { className: "mt-3 mb-1 text-h1 font-semibold" } },
    h2: { props: { className: "mt-3 mb-1 text-h2 font-semibold" } },
    h3: { props: { className: "mt-3 mb-1 text-h3 font-semibold" } },
    p: { props: { className: "my-3" } },
    ul: { props: { className: "my-3 list-disc pl-5" } },
    ol: { props: { className: "my-3 list-decimal pl-5" } },
    blockquote: {
      props: { className: "my-3 border-l-2 border-neutral-700 pl-2" },
    },
    a: { props: { className: "text-blue-400 underline" } },
    pre: {
      props: {
        className: "my-3 overflow-auto bg-neutral-900 p-3 font-mono text-body",
      },
    },
    table: { props: { className: "my-3 border-collapse text-body" } },
    th: {
      props: { className: "border border-neutral-700 px-2 py-1 text-left" },
    },
    td: { props: { className: "border border-neutral-700 px-2 py-1" } },
  },
};

/** Serialize the editable document, not the app's chat renderer or its controls. */
function markdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE)
    return (node.textContent ?? "")
      .replace(/\u00a0/g, " ")
      .replace(/([\\`*_\[\]<>])/g, "\\$1")
      .replace(/(^|\n)(\s*)([#>+-]|\d+\.)/g, "$1$2\\$3");
  if (!(node instanceof HTMLElement)) return "";
  const children = () => Array.from(node.childNodes, markdown).join("");
  const inline = () => children().trim();
  switch (node.tagName) {
    case "BR":
      return "  \n";
    case "H1":
    case "H2":
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      return `${"#".repeat(Number(node.tagName[1]))} ${inline()}\n\n`;
    case "P":
    case "DIV":
      return `${inline()}\n\n`;
    case "STRONG":
    case "B":
      return `**${children()}**`;
    case "EM":
    case "I":
      return `*${children()}*`;
    case "DEL":
    case "S":
    case "STRIKE":
      return `~~${children()}~~`;
    case "A": {
      const href = (node.getAttribute("href") ?? "").replace(/[\s()<>]/g, (c) =>
        encodeURIComponent(c),
      );
      const title = node.getAttribute("title");
      return `[${children()}](${href}${title ? ` "${title.replace(/[\\"]/g, "\\$&")}"` : ""})`;
    }
    case "IMG":
      return `![${(node.getAttribute("alt") ?? "").replace(/[\[\]]/g, "\\$&")}](${node.getAttribute("src") ?? ""})`;
    case "PRE": {
      const code = node.querySelector("code");
      const text = (code ?? node).textContent ?? "";
      const fence = "`".repeat(
        Math.max(
          3,
          ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1),
        ),
      );
      const language =
        code?.className.match(/lang(?:uage)?-([\w+-]+)/)?.[1] ?? "";
      return `${fence}${language}\n${text.replace(/\n$/, "")}\n${fence}\n\n`;
    }
    case "CODE": {
      const text = node.textContent ?? "";
      const fence = "`".repeat(
        Math.max(
          1,
          ...Array.from(text.matchAll(/`+/g), (m) => m[0].length + 1),
        ),
      );
      const pad = /^[` ]|[` ]$/.test(text) ? " " : "";
      return `${fence}${pad}${text}${pad}${fence}`;
    }
    case "BLOCKQUOTE":
      return `${inline()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    case "UL":
    case "OL": {
      const start = Number(node.getAttribute("start") ?? 1);
      return `${Array.from(node.children)
        .map((item, index) => {
          const prefix = node.tagName === "OL" ? `${start + index}. ` : "- ";
          return (
            prefix +
            markdown(item)
              .trim()
              .replace(/\n/g, `\n${" ".repeat(prefix.length)}`)
          );
        })
        .join("\n")}\n\n`;
    }
    case "TABLE": {
      const rows = Array.from(
        node.querySelectorAll("tr"),
        (row) =>
          `| ${Array.from(row.children, (cell) => markdown(cell).trim().replace(/\|/g, "\\|").replace(/\n/g, "<br>")).join(" | ")} |`,
      );
      if (!rows.length) return "";
      const cells = node.querySelector("tr")?.children.length ?? 0;
      rows.splice(1, 0, `| ${Array(cells).fill("---").join(" | ")} |`);
      return `${rows.join("\n")}\n\n`;
    }
    case "HR":
      return "---\n\n";
    case "INPUT":
      return (node as HTMLInputElement).checked ? "[x] " : "[ ] ";
    default:
      return children();
  }
}

/** Keep React's seed unchanged during typing so native selection/undo survive. */
export const MarkdownEditor = memo(function MarkdownEditor({
  text,
  onChange,
}: {
  text: string;
  onChange: (text: string) => void;
}) {
  return (
    <div
      className="chat-prose min-h-0 flex-1 overflow-auto px-6 py-4 outline-none"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={t("Edit formatted Markdown")}
      onInput={(event) => {
        const content = Array.from(
          event.currentTarget.childNodes,
          markdown,
        ).join("");
        onChange(content.trimEnd() + "\n");
      }}
      onClick={(event) => {
        // Links are editable text here, not navigation out of the document.
        if ((event.target as Element).closest("a")) event.preventDefault();
      }}
      onPaste={(event) => {
        // Never insert arbitrary clipboard HTML into an editable document.
        event.preventDefault();
        document.execCommand(
          "insertText",
          false,
          event.clipboardData.getData("text/plain"),
        );
      }}
    >
      <Markdown options={options}>{text}</Markdown>
    </div>
  );
});
