export const DEFAULT_AUTOMATIC_MODEL = "openai-codex/gpt-6.1-sol";
export const AUTOMATIC_ACTIONS = ["commitNaming", "sessionNaming", "compaction", "reducer"] as const;
export type AutomaticAction = (typeof AUTOMATIC_ACTIONS)[number];
export type AutomaticModels = Record<AutomaticAction, string>;
