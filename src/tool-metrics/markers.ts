/**
 * markers.ts — takes trace.bash's markers (`\x1ePWI<nonce>:<n>\x1f`) out of
 * a bash call's output before anything else reads it, and remembers where
 * each one was, so output can be split by command.
 */

const START = 0x1e;
const END = 0x1f;
/** Longest marker: prefix, nonce, `:`, a 10-digit number, end. */
const MAX_TAIL = 64;

export class MarkerStrip {
	/** Marker number → how many clean bytes came before it. */
	readonly at = new Map<number, number>();
	/** Clean bytes so far. */
	bytes = 0;
	private readonly prefix: Buffer;
	private held = Buffer.alloc(0);

	constructor(nonce: string) {
		this.prefix = Buffer.from(`\x1ePWI${nonce}:`);
	}

	/** The chunk without markers. A marker cut off at the end is held for the next chunk. */
	push(chunk: Buffer): Buffer {
		const data = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
		this.held = Buffer.alloc(0);
		const out: Buffer[] = [];
		let from = 0;
		for (let i = data.indexOf(START); i >= 0; i = data.indexOf(START, i + 1)) {
			const rest = data.length - i;
			const n = Math.min(rest, this.prefix.length);
			if (data.compare(this.prefix, 0, n, i, i + n) !== 0) continue;
			const end = rest >= this.prefix.length ? data.indexOf(END, i + this.prefix.length) : -1;
			if (end < 0) {
				// Maybe the rest of a marker is in the next chunk.
				if (rest <= MAX_TAIL) {
					this.emit(out, data.subarray(from, i));
					this.held = Buffer.from(data.subarray(i));
					return Buffer.concat(out);
				}
				continue;
			}
			const seq = Number(data.subarray(i + this.prefix.length, end).toString("latin1"));
			if (!Number.isInteger(seq)) continue;
			this.emit(out, data.subarray(from, i));
			this.at.set(seq, this.bytes);
			from = end + 1;
			i = end;
		}
		this.emit(out, data.subarray(from));
		return Buffer.concat(out);
	}

	/** Whatever was held back, as output: the stream ended mid-marker. */
	flush(): Buffer {
		const rest = this.held;
		this.held = Buffer.alloc(0);
		this.bytes += rest.length;
		return rest;
	}

	private emit(out: Buffer[], part: Buffer) {
		if (!part.length) return;
		out.push(part);
		this.bytes += part.length;
	}
}
