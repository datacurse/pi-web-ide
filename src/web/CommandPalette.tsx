import { useEffect, useRef, useState } from "react";
import { Command, X } from "@phosphor-icons/react";
import { matches } from "./Settings.js";
import { IconButton } from "./ui.js";
import { t } from "./i18n.js";
import { ScrollPane } from "./OverlayScrollbar.js";

export interface PaletteCommand {
  id: string;
  label: string;
  /** Key binding shown on the right. */
  keys?: string;
  run: () => void;
}

/** Ctrl+P popup: filter and run app commands, like VS Code's command palette. */
export function CommandPalette({
  open,
  commands,
  onClose,
}: {
  open: boolean;
  commands: PaletteCommand[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setQuery("");
      setActive(0);
      dialog.showModal();
    } else if (!open && dialog.open) dialog.close();
  }, [open]);

  const rows = query.trim()
    ? commands
        .map((c) => ({ c, hit: matches(query, c.label, "") }))
        .filter((r) => r.hit)
        .sort((a, b) => (a.hit === b.hit ? 0 : a.hit === "words" ? -1 : 1))
        .map((r) => r.c)
    : commands;

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (c: PaletteCommand) => {
    onClose();
    c.run();
  };

  return (
    <dialog
      ref={ref}
      aria-label={t("Command palette")}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      // `hidden open:flex`: see DirectoryPicker — a bare `flex` would paint the closed dialog.
      className="mx-auto mt-[12vh] hidden max-h-[76vh] w-[min(44rem,92vw)] flex-col overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
    >
      <div className="flex items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <Command size={18} className="shrink-0 text-neutral-500" />
        <input
          data-custom="search field"
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((a) =>
                Math.min(Math.max(a + step, 0), Math.max(rows.length - 1, 0)),
              );
            } else if (e.key === "Enter" && rows[active]) {
              e.preventDefault();
              pick(rows[active]);
            }
          }}
          placeholder={t("Type a command…")}
          aria-label={t("Command")}
          className="min-w-0 flex-1 bg-transparent text-title text-neutral-100 outline-none placeholder:text-neutral-500"
        />
        <IconButton onClick={onClose} label={t("Close command palette")}>
          <X size={13} />
        </IconButton>
      </div>

      <ScrollPane
        ref={list}
        role="listbox"
        aria-label={t("Commands")}
        className="min-h-0 flex-1"
        innerClassName="p-1.5"
      >
        {rows.length === 0 && (
          <p className="px-3 py-4 text-ui text-neutral-400">
            {t("No matching commands.")}
          </p>
        )}
        {rows.map((c, i) => (
          <button
            data-custom="search result"
            key={c.id}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => setActive(i)}
            onClick={() => pick(c)}
            className={`flex w-full min-w-0 items-center gap-3 rounded-sm px-3 py-2 text-left ${
              i === active ? "bg-neutral-800" : ""
            }`}
          >
            <span className="min-w-0 flex-1 fade-end text-body text-neutral-200">
              {c.label}
            </span>
            {c.keys && (
              <span className="shrink-0 text-ui text-neutral-500">
                {c.keys}
              </span>
            )}
          </button>
        ))}
      </ScrollPane>
    </dialog>
  );
}
