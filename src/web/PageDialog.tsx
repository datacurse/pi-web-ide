import { useEffect, useRef, useState, type ReactNode } from "react";

/** The rail's bottom group: places you visit, not work beside, so a popup rather than a tab. */
export type PageId = "stats" | "packages" | "settings";
const TITLE: Record<PageId, string> = { stats: "Stats", packages: "Packages", settings: "Settings" };

/**
 * One large modal for whichever page is open. A page stays mounted once opened,
 * hidden while closed, so an unsaved personality edit or a scrolled list
 * survives closing and reopening.
 */
export function PageDialog({
	page,
	onClose,
	render,
}: {
	page: PageId | null;
	onClose: () => void;
	/** A page's content; `open` is whether it is the one showing. */
	render: (page: PageId, open: boolean) => ReactNode;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const [mounted, setMounted] = useState<PageId[]>([]);
	const shown = page && !mounted.includes(page) ? [...mounted, page] : mounted;

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (page) {
			setMounted((m) => (m.includes(page) ? m : [...m, page]));
			if (!dialog.open) dialog.showModal();
		} else if (dialog.open) dialog.close();
	}, [page]);

	return (
		<dialog
			ref={ref}
			aria-label={page ? TITLE[page] : undefined}
			onClose={onClose}
			onClick={(e) => {
				if (e.target === ref.current) onClose();
			}}
			// `hidden open:flex`: see DirectoryPicker — a bare `flex` would paint the closed dialog.
			className="m-auto hidden h-[85vh] w-[min(64rem,94vw)] flex-col overflow-hidden rounded-md border border-neutral-800 bg-neutral-950 p-0 text-neutral-100 shadow-2xl backdrop:bg-black/50 backdrop:backdrop-blur-sm open:flex"
		>
			{shown.map((p) => (
				<div key={p} className={`flex min-h-0 min-w-0 flex-1 flex-col ${p === page ? "" : "hidden"}`}>
					{render(p, p === page)}
				</div>
			))}
		</dialog>
	);
}
