import type { TurnActivity } from "../shared/activity.js";
import { activityGroups } from "../shared/activity.js";
import type { PiMessage, PiPartial } from "../shared/types.js";
import { ActivityPanel } from "./Activity.js";
import { Block } from "./Transcript.js";
import { phaseBlocks } from "./turnPhases.js";

/** Timed phases contain the actual reasoning and tool cards, not a second log. */
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
				<ActivityPanel activity={activity} waitingForInput={waitingForInput} renderContent={(group, now) => (
					<div className="chat-prose flow-trim flow-root">
						{blocks.get(group.id)?.map((block, i) => {
							const tool = block.kind === "tool" ? group.tools.find((call) => call.id === block.id) : undefined;
							return <Block key={block.kind === "tool" ? block.id : i} block={block} isUser={false} autoOpenTools={false} toolMs={tool ? (tool.end ?? now) - tool.start : undefined} />;
						})}
					</div>
				)} />
			</div>
		</div>
	);
}
