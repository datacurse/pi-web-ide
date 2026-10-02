import { useEffect, useRef, useState, type ReactNode } from "react";
import type { PiSessionHit } from "../shared/types.js";
import { api } from "./api.js";
import { t } from "./i18n.js";

/** Wrap every occurrence of any term in a bold mark; with `word`, only whole-word ones (as the server matches). */
export function highlight(
  text: string,
  terms: string[],
  word = false,
): ReactNode {
  if (!terms.length) return text;
  const alt = terms
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const re = new RegExp(
    word ? `(?<![\\p{L}\\p{N}_])(${alt})(?![\\p{L}\\p{N}_])` : `(${alt})`,
    "giu",
  );
  // split with a capture group puts the matches at the odd indexes.
  return text.split(re).map((part, i) =>
    i % 2 ? (
      <mark key={i} className="bg-transparent font-semibold text-neutral-100">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/**
 * Server full-text search over a project's sessions, debounced. The last
 * answer stays until the next one lands, so typing never flashes an empty list.
 * `terms` are the answered query's, so highlights always match the hits shown.
 */
export function useSessionSearch(project: string, query: string, word = false) {
  const [result, setResult] = useState<{
    query: string;
    word: boolean;
    hits: PiSessionHit[];
  }>({ query: "", word, hits: [] });
  const [error, setError] = useState<string | null>(null);
  /** Only the newest query may write results; responses can land out of order. */
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const ticket = ++seq.current;
    if (!q) {
      setResult({ query: "", word, hits: [] });
      setError(null);
      return;
    }
    const timer = setTimeout(async () => {
      const r = await api.sessions.search
        .$get({ query: { cwd: project, q, ...(word && { word: "1" }) } })
        .catch(() => null);
      const body = (await r?.json().catch(() => null)) as {
        hits?: PiSessionHit[];
        error?: string;
      } | null;
      if (ticket !== seq.current) return;
      if (!r?.ok || !body?.hits) {
        setError(body?.error ?? t("Search failed"));
        return;
      }
      setError(null);
      setResult({ query: q, word, hits: body.hits });
    }, 150);
    return () => clearTimeout(timer);
  }, [query, project, word]);

  return {
    hits: result.hits,
    terms: result.query.split(/\s+/).filter(Boolean),
    word: result.word,
    pending: (query.trim() !== result.query || word !== result.word) && !error,
    error,
  };
}
