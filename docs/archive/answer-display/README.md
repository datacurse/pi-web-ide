# Archived answer display

Snapshot before switching the chat to raw output. Source files have `.txt` suffixes so they are not compiled or indexed as active code. The original paths are `src/web/<filename>`. Supporting modules and the original renderer are also available in Git history; restoring this snapshot requires restoring those modules together.

The active chat renders model prose and reasoning as Markdown, and tool arguments and results as literal escaped text. Each turn has one collapsed-by-default work toggle; only the final answer stays visible. Copy/fork controls target the final assistant message. The retired round renderer and ignored display preferences have been removed from active source. Session data and activity collection are unchanged.
