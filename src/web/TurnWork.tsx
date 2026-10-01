import type { ActivityRound, TurnActivity } from "../shared/activity.js";
import { activityGroups } from "../shared/activity.js";
import type { PiBlock, PiMessage, PiPartial } from "../shared/types.js";
import { ActivityPanel } from "./Activity.js";
import { Block } from "./Transcript.js";
import { phaseBlocks } from "./turnPhases.js";

/** Round content is prose first, then tools; empty timing-only stages have no extra folds. */
export function RoundWork({ round, blocks, now }: { round: ActivityRound; blocks: PiBlock[]; now: number }) {
	const tools = new Map(round.groups.flatMap((group) => group.tools).map((tool) => [tool.id, tool]));
	const received = blocks.filter((block) => block.kind !== "tool");
	const calls = blocks.filter((block) => block.kind === "tool");
	return <div className="chat-nested chat-prose flow-trim flow-root">
		{received.map((block, i) => <Block key={i} block={block} isUser={false} autoOpenTools={false} />)}
		{calls.map((block) => {
			const tool = tools.get(block.id);
			return <Block key={block.id} block={block} isUser={false} autoOpenTools={false} toolMs={tool ? (tool.end ?? now) - tool.start : undefined} />;
		})}
	</div>;
}

/** Each timed round contains the actual reasoning and tool cards, not a second log. */
export function TurnWork({ activity, messages, partial, waitingForInput }: {
	activity: TurnActivity;
	messages: PiMessage[];
	partial?: PiPartial;
	waitingForInput?: boolean;
}) {
	const blocks = phaseBlocks(activityGroups(activity), messages, partial);
	return (
		<div className="chat-gutter my-3">
			<div className="chat-measure">
				<ActivityPanel activity={activity} waitingForInput={waitingForInput} renderContent={(round, now) => <RoundWork round={round} blocks={round.groups.flatMap((group) => blocks.get(group.id) ?? [])} now={now} />} />
			</div>
		</div>
	);
}
