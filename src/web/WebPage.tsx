import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowClockwise,
  ArrowSquareOut,
  Globe,
} from "@phosphor-icons/react";
import { IconButton, IconLink, inputClass } from "./ui.js";
import { writeStored } from "./tabStore.js";
import { t } from "./i18n.js";

// Never accept executable URLs. Bare local addresses use HTTP for dev servers.
function pageUrl(value: string): string {
  const input = value.trim();
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(input);
  const url = new URL(
    /^[a-z][a-z\d+.-]*:\/\//i.test(input)
      ? input
      : `${local ? "http" : "https"}://${input}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error(t("Enter an HTTP or HTTPS URL without credentials."));
  return url.href;
}

function restoredUrl(entry: string): string {
  try {
    const saved = localStorage.getItem(`pwi:${entry}`);
    return saved ? pageUrl(saved) : "";
  } catch {
    return "";
  }
}

export function WebPage({ entry, active }: { entry: string; active: boolean }) {
  const [history, setHistory] = useState(() => [restoredUrl(entry)]);
  const [index, setIndex] = useState(0);
  const url = history[index] ?? "";
  const [address, setAddress] = useState(url);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAddress(url);
    writeStored(`pwi:${entry}`, url);
  }, [entry, url]);
  useEffect(() => {
    if (active && !url) input.current?.focus();
  }, [active, url]);

  const navigate = () => {
    try {
      const next = pageUrl(address);
      setError("");
      if (next === url) setReload((n) => n + 1);
      else {
        setHistory([...history.slice(0, index + 1), next]);
        setIndex(index + 1);
      }
    } catch {
      setError(t("Enter a valid HTTP or HTTPS URL."));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form
        className="flex h-bar shrink-0 items-center gap-1 border-b border-neutral-800 px-2"
        onSubmit={(e) => {
          e.preventDefault();
          navigate();
        }}
      >
        <IconButton
          label={t("Back (address bar history)")}
          disabled={index === 0}
          onClick={() => {
            setError("");
            setIndex(index - 1);
          }}
        >
          <ArrowLeft size={16} />
        </IconButton>
        <IconButton
          label={t("Forward (address bar history)")}
          disabled={index >= history.length - 1}
          onClick={() => {
            setError("");
            setIndex(index + 1);
          }}
        >
          <ArrowRight size={16} />
        </IconButton>
        <IconButton
          label={t("Reload page")}
          disabled={!url}
          onClick={() => setReload((n) => n + 1)}
        >
          <ArrowClockwise size={16} />
        </IconButton>
        <input
          ref={input}
          aria-label={t("Web address")}
          placeholder={t("Enter URL, e.g. localhost:3000")}
          className={`${inputClass.sm} min-w-0 flex-1`}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        {url && (
          <IconLink label={t("Open externally")} href={url}>
            <ArrowSquareOut size={16} />
          </IconLink>
        )}
      </form>
      {error && (
        <p role="alert" className="px-3 py-2 text-meta text-red-400">
          {error}
        </p>
      )}
      {url ? (
        <>
          <p className="border-b border-neutral-800 px-3 py-1 text-meta text-neutral-500">
            {t(
              "Some sites block embedding. Use Open externally if the page is blank. Navigation tracks addresses entered above, not links inside the page.",
            )}
          </p>
          <iframe
            key={`${url}:${reload}`}
            src={url}
            title={t("Web page: {url}", { url })}
            className="min-h-0 w-full flex-1 border-0 bg-white"
            sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
            referrerPolicy="no-referrer"
          />
        </>
      ) : (
        <div className="m-auto flex flex-col items-center gap-3 px-4 text-center text-neutral-500">
          <Globe size={32} />
          <p className="text-title text-neutral-200">{t("Open a web page")}</p>
          <p>{t("Enter a website or local development server URL above.")}</p>
        </div>
      )}
    </div>
  );
}
