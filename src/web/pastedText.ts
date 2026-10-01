export interface PastedText {
	name: string;
	text: string;
}

export function isLargePaste(text: string): boolean {
	return text.length >= 2000 || text.split(/\r\n|\r|\n/).length >= 20;
}

export function joinPastedText(text: string, attachments: PastedText[]): string {
	if (!attachments.length) return text;
	return text + attachments.map((item) => {
		const runs = item.text.match(/`+/g) ?? [];
		const fence = "`".repeat(runs.reduce((length, run) => Math.max(length, run.length + 1), 3));
		return `\n\n${fence}pwi-pasted-text ${item.name}\n${item.text}\n${fence}`;
	}).join("");
}

export function splitPastedText(value: string): { text: string; attachments: PastedText[] } {
	const attachments: PastedText[] = [];
	const pattern = /(?:^|\n\n)(`{3,})pwi-pasted-text (Pasted text \d+\.txt)\n([\s\S]*?)\n\1(?=\n\n`{3,}pwi-pasted-text |$)/g;
	let start = value.length;
	for (const match of value.matchAll(pattern)) {
		if (!attachments.length) start = match.index;
		else if (match.index !== start) return { text: value, attachments: [] };
		attachments.push({ name: match[2], text: match[3] });
		start = match.index + match[0].length;
	}
	if (!attachments.length || start !== value.length) return { text: value, attachments: [] };
	const first = value.search(pattern);
	return { text: value.slice(0, first), attachments };
}

export function addPastedText(value: string, pasted: string, start: number, end: number): string {
	const { text, attachments } = splitPastedText(value);
	const used = new Set(attachments.map((item) => item.name));
	let n = 1;
	while (used.has(`Pasted text ${n}.txt`)) n++;
	return joinPastedText(text.slice(0, start) + text.slice(end), [
		...attachments, { name: `Pasted text ${n}.txt`, text: pasted },
	]);
}
