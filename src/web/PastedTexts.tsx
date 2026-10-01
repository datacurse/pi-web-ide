import { useEffect, useRef, useState } from "react";
import { FileText, X } from "@phosphor-icons/react";
import { Button, IconButton } from "./ui.js";
import { t } from "./i18n.js";
import type { PastedText } from "./pastedText.js";

function TextDialog({ item, onSave, onClose }: {
	item: PastedText;
	onSave?: (text: string) => void;
	onClose: () => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [text, setText] = useState(item.text);
	useEffect(() => { dialog.current?.showModal(); }, []);
	return (
		<dialog ref={dialog} onClose={onClose} onClick={(e) => {
			if (e.target === e.currentTarget) onClose();
		}} className="m-auto h-[85vh] w-[min(48rem,94vw)] rounded-md border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm">
			<div className="flex h-full flex-col">
				<div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
					<h2 className="text-title">{item.name}</h2>
					<IconButton label={t("Close")} size="sm" onClick={onClose}><X size={16} /></IconButton>
				</div>
				<textarea data-custom="pasted text editor" aria-label={item.name} autoFocus readOnly={!onSave}
					value={text} onChange={(e) => setText(e.target.value)}
					className="min-h-0 flex-1 resize-none bg-transparent p-4 font-mono text-body outline-none" />
				<div className="flex justify-end gap-2 border-t border-neutral-800 p-3">
					<Button size="sm" onClick={onClose}>{t("Close")}</Button>
					{onSave && <Button size="sm" variant="primary" onClick={() => { onSave(text); onClose(); }}>{t("Save changes")}</Button>}
				</div>
			</div>
		</dialog>
	);
}

export function PastedTexts({ items, onChange }: {
	items: PastedText[];
	onChange?: (items: PastedText[]) => void;
}) {
	const [opened, setOpened] = useState<number | null>(null);
	if (!items.length) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-2">
			{items.map((item, i) => (
				<div key={item.name} className="flex min-w-0 max-w-full items-center gap-2 rounded-md border border-neutral-700 p-2">
					<button data-custom="pasted text attachment" onClick={() => setOpened(i)} title={item.name}
						className="flex min-w-0 items-center gap-2 text-left text-ui text-neutral-200 hover:text-neutral-100">
						<FileText size={24} className="shrink-0 text-amber-400" />
						<span className="min-w-0"><span className="fade-end block">{item.name}</span>
							<span className="fade-end block max-w-64 text-meta text-neutral-500">{item.text.split(/\r?\n/).find((line) => line.trim()) || t("Empty text")}</span>
						</span>
					</button>
					{onChange && <IconButton size="sm" label={t("Remove {name}", { name: item.name })} onClick={() => {
						setOpened(null);
						onChange(items.filter((_, n) => n !== i));
					}}><X size={14} /></IconButton>}
				</div>
			))}
			{opened !== null && items[opened] && <TextDialog key={items[opened].name} item={items[opened]} onClose={() => setOpened(null)}
				onSave={onChange ? (text) => onChange(items.map((item, i) => i === opened ? { ...item, text } : item)) : undefined} />}
		</div>
	);
}
