export const FAST_COMMAND = "pwi-fast";

export function supportsFastMode(model: string | undefined): boolean {
  // Pi does not expose service-tier support in its model catalog. Restrict
  // the switch to Sol models on providers whose Responses API accepts it.
  return (
    model === "openai/gpt-6-sol" ||
    model === "openai/gpt-6.1-sol" ||
    model === "openai-codex/gpt-6-sol" ||
    model === "openai-codex/gpt-6.1-sol"
  );
}
