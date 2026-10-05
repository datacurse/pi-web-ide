import {
  ArrowClockwise,
  CaretRight,
  CheckCircle,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";

/** Presentation only: never changes the supervisor's directives or configuration. */
export function isAutoGoalText(text: string): boolean {
  return (
    /^\[auto-goal\]/.test(text) ||
    /^(【自动监督】|\[Auto supervision\])/.test(text)
  );
}

export function AutoGoalNotice({ text }: { text: string }) {
  const headline = text.split("\n", 1)[0];
  const stopped = /判定可停止|stop accepted/i.test(headline);
  const continuing =
    /判定该继续|judged premature|【自动监督】|\[Auto supervision\]/i.test(
      headline,
    );
  const failed = /失败|failed/i.test(headline);
  const limited = /次数用尽|limit reached/i.test(headline);
  const interrupted = /已打断|interrupted/i.test(headline);
  const incomplete = /未正常结束|did not finish normally/i.test(headline);
  const confidence = headline.match(/(?:置信度|confidence)\s*(\d+%)/i)?.[1];
  const budget = headline.match(/(?:已催促|continuation)\s*(\d+\/\d+)/i)?.[1];
  const label = stopped
    ? "Completion confirmed"
    : continuing
      ? "Continuing unfinished work"
      : failed
        ? "Completion check failed"
        : limited
          ? "Continuation limit reached"
          : interrupted
            ? "Interrupted · not checked"
            : incomplete
              ? "Turn incomplete · not checked"
              : "Completion check";
  const Icon = stopped
    ? CheckCircle
    : continuing
      ? ArrowClockwise
      : failed
        ? WarningCircle
        : ShieldCheck;
  const color = stopped
    ? "text-green-400"
    : continuing
      ? "text-amber-400"
      : failed
        ? "text-red-400"
        : "text-neutral-500";
  return (
    <details className="group/goal text-ui">
      <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-neutral-400 transition-colors hover:text-neutral-200">
        <Icon size={16} className={color} aria-hidden />
        <span className="text-neutral-500">Auto-goal</span>
        <span>{label}</span>
        {confidence && (
          <span className="text-meta text-neutral-500">
            {confidence} confidence
          </span>
        )}
        {budget && <span className="text-meta text-neutral-500">{budget}</span>}
        <CaretRight
          size={12}
          aria-hidden
          className="shrink-0 transition-transform group-open/goal:rotate-90"
        />
      </summary>
      <div className="mt-2 border-l border-neutral-800 pl-6 text-meta text-neutral-400">
        <div className="mb-2 text-neutral-500">Original supervisor output</div>
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
    </details>
  );
}
