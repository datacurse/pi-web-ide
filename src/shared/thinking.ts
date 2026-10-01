export function thinkingChoices(levels: string[], map: Record<string, string | null> = {}) {
	const groups = new Map<string, string[]>();
	for (const level of levels) {
		const effort = Object.hasOwn(map, level) ? map[level] : level;
		if (effort === null) continue;
		const group = groups.get(effort) ?? [];
		group.push(level);
		groups.set(effort, group);
	}
	const aliases = new Map<string, string>();
	const choices: string[] = [];
	for (const [effort, group] of groups) {
		const choice = group.includes(effort) ? effort : group[0]!;
		choices.push(choice);
		for (const level of group) aliases.set(level, choice);
	}
	return { levels: choices, resolve: (level: string | undefined | null) => level == null ? level : aliases.get(level) ?? level };
}
