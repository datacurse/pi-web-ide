import type { SessionAttachment } from "./types.js";
import { splitPastedText } from "./pastedText.js";

export function sessionPreview(
  text: string,
  imageCount = 0,
): { text: string; attachments: SessionAttachment[] } {
  const pasted = splitPastedText(text.trim());
  return {
    text: pasted.text.trim(),
    attachments: [
      ...pasted.attachments.map(({ name }): SessionAttachment => ({
        kind: "text",
        name,
      })),
      ...Array.from({ length: imageCount }, (_, index): SessionAttachment => ({
        kind: "image",
        index: index + 1,
      })),
    ],
  };
}
