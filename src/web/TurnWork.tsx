import type { ActivityRound, TurnActivity } from "../shared/activity.js";
import { activityGroups } from "../shared/activity.js";
import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";
import { ActivityPanel } from "./Activity.js";
import type { ThinkingMode, UserMode } from "./prefs.js";
import { Block, Message } from "./Transcript.js";
import { phaseBlocks } from "./turnPhases.js";
import { readWorkExpanded } from "./prefs.js";

/** Round content is prose first, then tools; empty timing-only stages have no extra folds. */
export function RoundWork({ round, blocks, now, expandedByDefault = readWorkExpanded() }: { round: ActivityRound; blocks: PiBlock[]; now: number; expandedByDefault?: boolean }) {
	const tools = new Map(round.groups.flatMap((group) => group.tools).map((tool) => [tool.id, tool]));
	const received = blocks.filter((block) => block.kind !== "tool");
	const calls = blocks.filter((block) => block.kind === "tool");
	return <div className="chat-nested chat-prose flow-trim flow-root">
		{received.map((block, i) => <Block key={i} block={block} isUser={false} autoOpenTools={false} expandedByDefault={expandedByDefault} />)}
		{calls.map((block) => {
			const tool = tools.get(block.id);
			return <Block key={block.id} block={block} isUser={false} autoOpenTools={false} toolMs={tool ? (tool.end ?? now) - tool.start : undefined} expandedByDefault={expandedByDefault} />;
		})}
	</div>;
}

/** Each timed round contains the actual reasoning and tool cards, not a second log. */
export function TurnWork({ activity, messages, prompt, partial, waitingForInput, expandedByDefault = readWorkExpanded(), userMode, thinkingMode, onFork, onEdit }: {
	activity: TurnActivity;
	messages: PiMessage[];
	prompt?: PiMessage;
	partial?: PiPartial;
	waitingForInput?: boolean;
	expandedByDefault?: boolean;
	userMode: UserMode;
	thinkingMode: ThinkingMode;
	onFork: (at: number) => Promise<void>;
	onEdit?: (at: number, text: string, images: { data: string; mimeType: string }[]) => void;
}) {
	const blocks = phaseBlocks(activityGroups(activity), messages, partial);
	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure">
				<ActivityPanel
					activity={activity}
					waitingForInput={waitingForInput}
					expandedByDefault={expandedByDefault}
					stickyLeading={prompt && <Message role="user" blocks={prompt.blocks} labelled={false} autoOpenTools={false} userMode={userMode} foldThinking={thinkingMode === "folded"} onFork={onFork} at={prompt.timestamp} onEdit={onEdit} />}
					renderContent={(round, now) => <RoundWork round={round} blocks={round.groups.flatMap((group) => blocks.get(group.id) ?? [])} now={now} expandedByDefault={expandedByDefault} />}
				/>
			</div>
		</div>
	);
}
