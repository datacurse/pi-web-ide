import { createContext, useContext } from "react";
export { Lightbox } from "./ImageLightbox.js";
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

/**
 * Copy a picked file to the pwi machine, which may not be this one, and return its path there.
 * `into` writes it into a project folder instead, as `name` (which may hold subfolders).
 * XHR rather than fetch because only XHR reports upload progress, to `onProgress` in bytes.
 */
export function uploadFile(
	file: File,
	into?: { dir: string; name: string },
	onProgress?: (sent: number) => void,
): Promise<string> {
	const q = new URLSearchParams(into ?? { name: file.name || "file" });
	const failed = () => new Error(t("could not upload {name}", { name: file.name }));
	return new Promise((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("POST", `/api/upload?${q}`);
		xhr.setRequestHeader("Content-Type", "application/octet-stream");
		xhr.responseType = "json";
		if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
		xhr.onerror = () => reject(failed());
		xhr.onload = () => {
			const body = (xhr.response ?? {}) as { path?: unknown; error?: unknown };
			if (xhr.status === 200 && typeof body.path === "string") return resolve(body.path);
			reject(typeof body.error === "string" ? new Error(body.error) : failed());
		};
		xhr.send(file);
	});
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
