import {
	createContext,
	type RefObject,
	useContext,
	useEffect,
	useLayoutEffect,
	useState,
} from "react";
import { X } from "@phosphor-icons/react";
import type { PiImage } from "../shared/types.js";
import { t } from "./i18n.js";

/** Mirrors the server's allowlist; see SUPPORTED_IMAGE_MIME in agent.ts. */
export const SUPPORTED_IMAGE_MIME = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];

/**
 * Read a clipboard/file blob into the wire shape.
 *
 * FileReader hands back a `data:` URL and we keep only the payload: the wire
 * contract is raw base64 (what pi's RPC `images` field takes), so the prefix is
 * stripped once, here, at the boundary where it appears.
 */
export function readImage(file: File): Promise<PiImage> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () => reject(new Error(t("could not read {name}", { name: file.name || t("image") })));
		reader.onload = () => {
			const result = String(reader.result ?? "");
			const comma = result.indexOf(",");
			if (comma < 0) return reject(new Error(t("unreadable image data")));
			resolve({ data: result.slice(comma + 1), mimeType: file.type });
		};
		reader.readAsDataURL(file);
	});
}

/** Copy a picked file to the pwi machine, which may not be this one, and return its path there. */
export async function uploadFile(file: File): Promise<string> {
	const r = await fetch(`/api/upload?name=${encodeURIComponent(file.name || "file")}`, {
		method: "POST",
		headers: { "Content-Type": "application/octet-stream" },
		body: file,
	});
	const body = (await r.json().catch(() => ({}))) as { path?: unknown; error?: unknown };
	if (!r.ok || typeof body.path !== "string") {
		throw new Error(typeof body.error === "string" ? body.error : t("could not upload {name}", { name: file.name }));
	}
	return body.path;
}

/**
 * Click-to-expand for every thumbnail on the page.
 *
 * A context and not a prop chain because the two places that show an image —
 * a sent message deep inside the transcript, and the composer's staging row —
 * have no common parent short of `Chat` itself, and threading a callback
 * through `Message`, `Block` and `ToolGroup` would put an image concern in
 * three components that otherwise have none.
 */
export const ZoomContext = createContext<(src: string) => void>(() => {});

/**
 * One attachment, square.
 *
 * Square and small because an attachment is an ITEM in a list here, not
 * content: a screenshot rendered at its own aspect ratio pushes the message
 * it belongs to off the screen, and a row of mixed shapes is unreadable as a
 * set. `object-cover` crops to the square rather than letterboxing, so the
 * middle of the picture — which is what identifies it — stays visible; the
 * click is what shows the whole thing.
 */
export function Thumb({
	image,
	label,
	onRemove,
}: {
	image: PiImage;
	label: string;
	onRemove?: () => void;
}) {
	const zoom = useContext(ZoomContext);
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<div className="group relative">
			<button
				data-custom="image thumbnail"
				onClick={() => zoom(src)}
				title={t("Click to expand")}
				className="block size-14 overflow-hidden rounded-md border border-neutral-700 transition-colors duration-150 ease-out hover:border-neutral-500 motion-reduce:transition-none"
			>
				<img src={src} alt={label} className="size-full object-cover" />
			</button>
			{onRemove && (
				<button
					data-custom="thumbnail remove badge"
					onClick={onRemove}
					aria-label={t("Remove {name}", { name: label })}
					className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-meta text-neutral-400 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 hover:text-neutral-100 focus:opacity-100 motion-reduce:transition-none"
				>
					<X size={13} />
				</button>
			)}
		</div>
	);
}

/**
 * The expanded image.
 *
 * A thumbnail is deliberately too small to read a screenshot in, so the full
 * size has to be one click away — and it is an overlay rather than a new tab
 * because the data is a base64 URL: a tab would show a megabyte of address
 * bar and, in some browsers, refuse to navigate to it at all.
 *
 * It spans the whole window but stops just above the last line of `above`
 * (the composer's field), the line you type on: you open a picture to
 * describe it, so that line has to stay usable under it. The field grows
 * upward, so its last line, and the overlay's edge, stay put as you type.
 */
export function Lightbox({
	src,
	above,
	onClose,
}: {
	src: string;
	above: RefObject<HTMLElement | null>;
	onClose: () => void;
}) {
	const [bottom, setBottom] = useState(0);
	useLayoutEffect(() => {
		const el = above.current;
		if (!el) return;
		const measure = () =>
			setBottom(
				window.innerHeight -
					el.getBoundingClientRect().bottom +
					parseFloat(getComputedStyle(el).lineHeight),
			);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(el);
		window.addEventListener("resize", measure);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [above]);

	// Escape closes, because that is what every overlay in this app answers to.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// Not when the composer already used it (closing the command picker).
			if (e.key === "Escape" && !e.defaultPrevented) onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		// No backdrop: clicks around the image reach the app under it.
		<div
			role="dialog"
			aria-label={t("Attachment")}
			style={{ bottom }}
			className="pointer-events-none fixed inset-x-0 top-0 z-50 flex items-center justify-center"
		>
			<button
				data-custom="expanded image, click closes"
				onClick={onClose}
				aria-label={t("Close")}
				className="group pointer-events-auto relative overflow-hidden rounded-md border-2 border-neutral-200 shadow-2xl"
			>
				<img
					src={src}
					alt={t("Attachment, full size")}
					style={{ maxHeight: `calc(100vh - ${bottom + 48}px)`, maxWidth: "calc(100vw - 48px)" }}
					className="block object-contain"
				/>
				<span className="absolute top-2 right-2 flex size-7 items-center justify-center rounded-full border border-neutral-700 bg-neutral-900 text-neutral-100 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 motion-reduce:transition-none">
					<X size={14} />
				</span>
			</button>
		</div>
	);
}

/** Staged attachments, above the composer until they are sent. */
export function Attachments({
	images,
	onRemove,
}: {
	images: PiImage[];
	onRemove: (index: number) => void;
}) {
	if (images.length === 0) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-2">
			{images.map((img, i) => (
				<Thumb
					key={i}
					image={img}
					label={t("attachment {n}", { n: i + 1 })}
					onRemove={() => onRemove(i)}
				/>
			))}
		</div>
	);
}
