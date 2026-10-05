/** Browser downloads never write to arbitrary server paths. */
export function downloadText(content: string, mime: string, filename: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download =
    filename.replace(/\\/g, "/").split("/").pop() || "session.txt";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
