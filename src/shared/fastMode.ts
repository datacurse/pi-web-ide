export const FAST_COMMAND = "pwi-fast";

export function supportsFastMode(model: string | undefined): boolean {
  return model === "openai-codex/gpt-6.1-sol";
}
