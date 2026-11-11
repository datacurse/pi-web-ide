import { PI_MARK } from "./piMark.js";

export type Badge = "needs" | "ready" | null;

/** Fill the icon edge to edge so the mark stays sharp at tab-strip sizes. */
const MARK_SCALE = 64 / 560;

let live: HTMLLinkElement | null = null;
let color: string | undefined;
let revision = 0;

/** Static white (idle), orange (working/needs input), or green (reply ready). */
export function setFavicon(working: boolean, badge: Badge): void {
  const nextColor =
    badge === "needs"
      ? "#fb923c"
      : badge === "ready"
        ? "#5ec98b"
        : working
          ? "#fb923c"
          : "#fff";
  if (nextColor === color) return;

  const doc =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
    `<!--${revision++}-->` +
    `<path fill="${nextColor}" transform="scale(${MARK_SCALE})" d="${PI_MARK}"/>` +
    "</svg>";
  const next = document.createElement("link");
  next.rel = "icon";
  next.type = "image/svg+xml";
  next.href = `data:image/svg+xml,${encodeURIComponent(doc)}`;

  // Chrome needs a fresh link and URL when switching back to a previous color.
  const previous =
    live ?? document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  document.head.appendChild(next);
  previous?.remove();
  live = next;
  color = nextColor;
}
