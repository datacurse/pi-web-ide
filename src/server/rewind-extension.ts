/**
 * RPC session navigation. Both commands use Pi's own navigation lifecycle;
 * branches remain in the append-only session, and extensions can cancel.
 */
interface Entry {
  id: string;
  type: string;
  message?: {
    role?: string;
    content?: string | { type?: string; text?: string }[];
  };
}
interface Node {
  entry: Entry;
  children: Node[];
  label?: string;
}
interface Context {
  isIdle(): boolean;
  navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
  sessionManager: { getTree(): Node[]; getLeafId(): string | null };
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    setStatus(key: string, text: string): void;
  };
}
interface Pi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler(args: string, ctx: Context): Promise<void>;
    },
  ): void;
}
export default function rewind(pi: Pi) {
  pi.registerCommand("pwi-rewind", {
    description: "pwi internal: rewind to before a user message",
    handler: async (args, ctx) => {
      await ctx.navigateTree(args.trim());
    },
  });
  pi.registerCommand("pwi-tree", {
    description: "pwi internal: navigate the session tree",
    handler: async (args, ctx) => {
      let result: { cancelled?: boolean; error?: string } = {};
      try {
        if (!ctx.isIdle())
          throw new Error("Finish the current turn before navigating.");
        const choices: { id: string; label: string }[] = [];
        const visit = (nodes: Node[], depth: number) => {
          for (const node of nodes) {
            const entry = node.entry;
            const content = entry.message?.content;
            const text =
              typeof content === "string"
                ? content
                : (content
                    ?.filter((part) => part.type === "text")
                    .map((part) => part.text ?? "")
                    .join(" ") ?? "");
            if (
              entry.type === "message" &&
              ["user", "assistant"].includes(entry.message?.role ?? "")
            ) {
              choices.push({
                id: entry.id,
                label: `${"  ".repeat(Math.min(depth, 12))}${entry.id === ctx.sessionManager.getLeafId() ? "● " : ""}${entry.id} · ${entry.message?.role} · ${node.label ?? text.replace(/\s+/g, " ").slice(0, 160)}`,
              });
            }
            visit(node.children, depth + 1);
          }
        };
        visit(ctx.sessionManager.getTree(), 0);
        let target = args.trim();
        if (!target) {
          if (!choices.length)
            throw new Error("This session has no conversation entries yet.");
          const selected = await ctx.ui.select(
            "Navigate session tree (user entries resume before that prompt)",
            choices.map((choice) => choice.label),
          );
          target =
            choices.find((choice) => choice.label === selected)?.id ?? "";
        }
        if (!target) result = { cancelled: true };
        else if (!choices.some((choice) => choice.id === target))
          throw new Error("No such conversation entry.");
        else result = await ctx.navigateTree(target);
      } catch (error) {
        result = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      ctx.ui.setStatus("pwi-tree", JSON.stringify(result));
    },
  });
}
