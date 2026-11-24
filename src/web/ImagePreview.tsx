import { useState } from "react";
import { ArrowClockwise } from "@phosphor-icons/react";
import { api } from "./api.js";
import { shortPath } from "./fileNavigation.js";
import { Button, PanelHeader } from "./ui.js";

export function ImagePreview({
  src,
  alt,
  error,
}: {
  src: string;
  alt: string;
  error: string;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center p-4">
      {failed ? (
        <p role="status" className="text-meta text-neutral-400">
          {error}
        </p>
      ) : (
        <img
          src={src}
          alt={alt}
          className="max-h-full max-w-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

export function PngViewer({ path, cwd }: { path: string; cwd: string }) {
  const [revision, setRevision] = useState<string>();
  // The download endpoint streams the original bytes and applies the same
  // project path check as other file operations. Use an image, not a text buffer.
  const src = api.download.$path({ query: { path, v: revision } });
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-neutral-950">
      <PanelHeader>
        <span
          className="min-w-0 fade-end font-mono text-meta text-neutral-400"
          title={path}
        >
          {shortPath(path, cwd)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setRevision(String(Date.now()))}
          title="Re-read from disk"
        >
          <ArrowClockwise size={13} />
          Reload
        </Button>
      </PanelHeader>
      <ImagePreview
        key={src}
        src={src}
        alt="PNG preview"
        error="Couldn’t load this PNG."
      />
    </div>
  );
}
