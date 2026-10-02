/**
 * rewind-extension.ts — a pi extension, not server code.
 *
 * agent.ts loads it into every session child for "edit message". The command
 * `/pwi-rewind <entryId>` moves the session back to just before that user
 * message, in the same file, like pi's own `/tree`: the old branch stays in the
 * file, and the next prompt starts a new one. pi's RPC has no command for this
 * (its `fork` moves the child to a new file); only an extension command gets
 * `navigateTree`.
 *
 * pi swallows a command's error, so agent.ts checks the leaf afterwards.
 */

/** The minimum of pi's ExtensionAPI this file uses; pi is not a dependency here. */
interface Pi {
  registerCommand(
    name: string,
    options: {
      description?: string;
      handler: (
        args: string,
        ctx: {
          navigateTree(targetId: string): Promise<{ cancelled: boolean }>;
        },
      ) => Promise<void>;
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
}
