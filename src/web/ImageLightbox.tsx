import { useEffect, useLayoutEffect, useRef, useState, type RefObject, type PointerEvent } from "react";
import { X } from "@phosphor-icons/react";
import type { PiImage } from "../shared/types.js";
import { t } from "./i18n.js";
import { Button, IconButton, inputClass } from "./ui.js";
import { annotationReference, annotationSvg, markLabel, markSvg, moveMark, type ImageWorkspace, type Mark, type Point } from "./imageAnnotations.js";

const COLORS = ["#ef4444", "#facc15", "#22c55e", "#38bdf8", "#ffffff"];
type Tool = "hand" | "select" | Mark["kind"];

export function Lightbox({ src, above, workspace, onChange, onAdd, onClose }: {
	src: string;
	above: RefObject<HTMLElement | null>;
	workspace: ImageWorkspace;
	onChange: (workspace: ImageWorkspace) => void;
	onAdd?: (image: PiImage, previousSrc: string | undefined, reference: string) => boolean;
	onClose: () => void;
}) {
	const [bottom, setBottom] = useState(0);
	const [tool, setTool] = useState<Tool>("hand");
	const [color, setColor] = useState(COLORS[0]);
	const [stroke, setStroke] = useState(2);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
	const [selected, setSelected] = useState<number | null>(null);
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const viewport = useRef<HTMLDivElement>(null);
	const image = useRef<HTMLImageElement>(null);
	const drag = useRef<{ start: Point; view: typeof view; mark?: Mark; drawing?: Mark } | null>(null);
	const history = useRef<Mark[][]>([]);
	const future = useRef<Mark[][]>([]);
	const mounted = useRef(true);
	useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
	const chosen = workspace.marks.find((mark) => mark.id === selected);

	useLayoutEffect(() => {
		const el = above.current;
		if (!el) return;
		const measure = () => setBottom(window.innerHeight - el.getBoundingClientRect().bottom + parseFloat(getComputedStyle(el).lineHeight));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		window.addEventListener("resize", measure);
		return () => { observer.disconnect(); window.removeEventListener("resize", measure); };
	}, [above]);
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) onClose();
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [onClose]);

	const fit = () => {
		const el = viewport.current;
		if (!el || !size.width) return;
		const scale = Math.min(el.clientWidth / size.width, el.clientHeight / size.height);
		setView({ scale, x: (el.clientWidth - size.width * scale) / 2, y: (el.clientHeight - size.height * scale) / 2 });
	};
	useLayoutEffect(fit, [size]);
	useEffect(() => {
		const el = viewport.current;
		if (!el) return;
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			const rect = el.getBoundingClientRect();
			zoom(Math.exp(-event.deltaY * 0.002), event.clientX - rect.left, event.clientY - rect.top);
		};
		el.addEventListener("wheel", wheel, { passive: false });
		return () => el.removeEventListener("wheel", wheel);
	}, []);
	function zoom(factor: number, x = (viewport.current?.clientWidth ?? 0) / 2, y = (viewport.current?.clientHeight ?? 0) / 2) {
		setView((old) => {
			const scale = Math.max(0.02, Math.min(16, old.scale * factor));
			return { scale, x: x - (x - old.x) * scale / old.scale, y: y - (y - old.y) * scale / old.scale };
		});
	}
	const point = (event: PointerEvent): Point => {
		const rect = viewport.current!.getBoundingClientRect();
		return { x: (event.clientX - rect.left - view.x) / view.scale, y: (event.clientY - rect.top - view.y) / view.scale };
	};
	const remember = () => { history.current.push(workspace.marks); future.current = []; };
	const down = (event: PointerEvent<HTMLDivElement>) => {
		if (busy || (event.button !== 0 && event.button !== 1)) return;
		const bounds = event.currentTarget.getBoundingClientRect();
		if (event.clientX > bounds.right - 20 && event.clientY > bounds.bottom - 20) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		if (tool === "hand" || event.button === 1) {
			drag.current = { start: { x: event.clientX, y: event.clientY }, view };
			return;
		}
		const start = point(event);
		if (tool === "select") {
			const id = Number((event.target as Element).closest("[data-mark]")?.getAttribute("data-mark"));
			const mark = workspace.marks.find((mark) => mark.id === id);
			setSelected(mark?.id ?? null);
			if (mark?.id !== selected) setDescription("");
			if (mark) { remember(); drag.current = { start, view, mark }; }
			return;
		}
		if (start.x < 0 || start.y < 0 || start.x > size.width || start.y > size.height) return;
		remember();
		const mark: Mark = { id: workspace.nextId, kind: tool, color, width: stroke * Math.max(1, size.width / 700), points: [start, start] };
		drag.current = { start, view, drawing: mark };
		setSelected(mark.id);
		setDescription("");
		onChange({ ...workspace, marks: [...workspace.marks, mark], nextId: mark.id + 1 });
	};
	const move = (event: PointerEvent<HTMLDivElement>) => {
		const current = drag.current;
		if (!current) return;
		if (!current.mark && !current.drawing) {
			setView({ ...current.view, x: current.view.x + event.clientX - current.start.x, y: current.view.y + event.clientY - current.start.y });
			return;
		}
		const p = point(event);
		const mark = current.mark ? moveMark(current.mark, p.x - current.start.x, p.y - current.start.y) : {
			...current.drawing!, points: current.drawing!.kind === "pen" ? [...current.drawing!.points, p] : [current.start, p],
		};
		if (current.drawing) current.drawing = mark;
		onChange({ ...workspace, marks: workspace.marks.map((old) => old.id === mark.id ? mark : old) });
	};
	const add = async () => {
		if (!chosen || !onAdd || !image.current) return;
		setBusy(true); setError("");
		try {
			const overlay = new Image();
			const url = URL.createObjectURL(new Blob([annotationSvg(workspace.marks, size.width, size.height)], { type: "image/svg+xml" }));
			try {
				overlay.src = url;
				await overlay.decode();
				const canvas = document.createElement("canvas");
				canvas.width = size.width; canvas.height = size.height;
				const context = canvas.getContext("2d");
				if (!context) throw new Error(t("Could not render annotations."));
				context.drawImage(image.current, 0, 0);
				context.drawImage(overlay, 0, 0);
				const exportedSrc = canvas.toDataURL("image/png");
				if (!exportedSrc.startsWith("data:image/png;base64,")) throw new Error(t("Could not render annotations."));
				const reference = `${annotationReference(chosen, size.width, size.height)}: ${description}`;
				if (mounted.current && onAdd({ mimeType: "image/png", data: exportedSrc.split(",")[1] }, workspace.exportedSrc, reference)) {
					onChange({ ...workspace, exportedSrc, exportedCount: workspace.marks.length });
					setDescription("");
				}
			} finally { URL.revokeObjectURL(url); }
		} catch (err) { setError(err instanceof Error ? err.message : String(err)); }
		finally { setBusy(false); }
	};
	return <div role="dialog" aria-label={t("Attachment")} style={{ bottom }} className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-center justify-center p-6">
		<div className="pointer-events-auto flex max-h-full max-w-full flex-col overflow-hidden rounded-md border-2 border-neutral-200 bg-neutral-950 shadow-2xl">
			<div className="flex flex-wrap items-center gap-1 border-b border-neutral-800 p-2">
				<Button size="sm" onClick={fit}>{t("Fit")}</Button>
				<Button size="sm" onClick={() => zoom(1 / view.scale)}>100%</Button>
				<Button size="sm" aria-label={t("Zoom out")} onClick={() => zoom(0.8)}>−</Button>
				<Button size="sm" aria-label={t("Zoom in")} onClick={() => zoom(1.25)}>+</Button>
				{([ ["hand", t("Pan")], ["select", t("Select")], ["arrow", t("Arrow")], ["area", t("Rectangle")], ["pen", t("Pen")] ] as [Tool, string][]).map(([value, label]) => <Button key={value} size="sm" variant={tool === value ? "subtle" : "ghost"} aria-pressed={tool === value} onClick={() => setTool(value)}>{label}</Button>)}
				<label className="text-meta text-neutral-400">{t("Color")} <select aria-label={t("Color")} className={inputClass.sm} disabled={busy} value={color} onChange={(e) => { setColor(e.target.value); if (chosen && tool === "select") { remember(); onChange({ ...workspace, marks: workspace.marks.map((mark) => mark.id === chosen.id ? { ...mark, color: e.target.value } : mark) }); } }}>{COLORS.map((value, i) => <option key={value} value={value}>{[t("Red"), t("Yellow"), t("Green"), t("Blue"), t("White")][i]}</option>)}</select></label>
				<label className="text-meta text-neutral-400">{t("Stroke")} <select aria-label={t("Stroke")} className={inputClass.sm} disabled={busy} value={stroke} onChange={(e) => { const width = Number(e.target.value); setStroke(width); if (chosen && tool === "select") { remember(); onChange({ ...workspace, marks: workspace.marks.map((mark) => mark.id === chosen.id ? { ...mark, width: width * Math.max(1, size.width / 700) } : mark) }); } }}>{[1, 2, 4].map((value) => <option key={value}>{value}</option>)}</select></label>
				<Button size="sm" disabled={!history.current.length || busy} onClick={() => { future.current.push(workspace.marks); onChange({ ...workspace, marks: history.current.pop()! }); }}>{t("Undo")}</Button>
				<Button size="sm" disabled={!future.current.length || busy} onClick={() => { history.current.push(workspace.marks); onChange({ ...workspace, marks: future.current.pop()! }); }}>{t("Redo")}</Button>
				<IconButton label={t("Close")} size="sm" className="ml-auto" onClick={onClose}><X size={14}/></IconButton>
			</div>
			<div ref={viewport} style={{ width: "min(80vw, 1100px)", height: `min(65vh, calc(100vh - ${bottom + 180}px))`, resize: "both", maxWidth: "calc(100vw - 64px)", minWidth: "280px", minHeight: "120px", touchAction: "none", cursor: tool === "hand" ? "grab" : "crosshair" }} className="relative overflow-hidden" onPointerDown={down} onPointerMove={move} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
				<div style={{ width: size.width, height: size.height, transformOrigin: "0 0", transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
					<img ref={image} src={src} draggable={false} alt={t("Attachment, full size")} className="pointer-events-none block" onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}/>
					<svg width={size.width} height={size.height} className="absolute inset-0">{workspace.marks.map((mark) => <g key={mark.id} data-mark={mark.id} pointerEvents="bounding-box" style={{ opacity: selected === mark.id ? 1 : 0.85 }} dangerouslySetInnerHTML={{ __html: markSvg(mark) }}/>)}</svg>
				</div>
			</div>
			<div className="flex flex-wrap items-center gap-2 border-t border-neutral-800 p-2 text-meta text-neutral-400">
				{chosen ? <><span>{markLabel(chosen)}</span><input aria-label={t("Describe this mark")} placeholder={t("Describe this mark")} className={`${inputClass.sm} flex-1`} value={description} onChange={(e) => setDescription(e.target.value)}/><Button size="sm" disabled={busy} onClick={() => { remember(); onChange({ ...workspace, marks: workspace.marks.filter((mark) => mark.id !== selected) }); setSelected(null); }}>{t("Delete")}</Button><Button size="sm" variant="primary" disabled={busy || !onAdd} onClick={() => void add()}>{t("Add to prompt")}</Button></> : <span>{t("Draw a mark, then select it to add a reference to your prompt.")}</span>}
				<span>{t("Annotations are sent only when you choose Add to prompt.")}</span>
				{error && <span role="alert" className="text-red-400">{error}</span>}
			</div>
		</div>
	</div>;
}
