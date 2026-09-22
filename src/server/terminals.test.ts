// Run: node --import tsx src/server/terminals.test.ts
import assert from "node:assert/strict";
import { Terminals, type TermEvent } from "./terminals.js";

const terminals = new Terminals();
const CWD = "/tmp";

/**
 * A client: the replay, then the live stream, plus a way to wait for output
 * to ARRIVE rather than for a guessed number of milliseconds. A shell's
 * round trip is not a fixed duration — it is an echo, a fork and a write —
 * so every wait here is on the thing itself, bounded only so a failure reads
 * as "never printed X" instead of hanging the run.
 */
function client(id: string) {
	let text = "";
	let exited: number | null = null;
	const waiters = new Set<() => void>();

	const onEvent = (e: TermEvent) => {
		if (e.type === "data") text += e.data;
		else exited = e.code;
		for (const w of [...waiters]) w();
	};
	const detach = terminals.attach(id, onEvent);

	const until = (done: () => boolean, what: string) => {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const check = () => {
			if (!done()) return;
			waiters.delete(check);
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			waiters.delete(check);
			reject(new Error(`timed out waiting for ${what}; saw: ${JSON.stringify(text.slice(-200))}`));
		}, 10_000);
		waiters.add(check);
		check();
		return promise;
	};

	return {
		detach,
		text: () => text,
		exit: () => exited,
		match: (re: RegExp) => until(() => re.test(text), String(re)),
		gone: () => until(() => exited !== null, "the shell to exit"),
	};
}

// A directory that is not one is rejected at create, rather than producing a
// shell that dies immediately for a reason the browser cannot see.
assert.throws(() => terminals.create("/tmp/pwi-does-not-exist-ever"), /not a directory/);

/*
 * Every create is a NEW shell. Splitting and opening a tab are the same call,
 * so two of them must never collapse into one process — that was the whole
 * limitation of keying terminals by cwd.
 */
const one = terminals.create(CWD, 100, 30);
const two = terminals.create(CWD, 100, 30);
assert.notEqual(one.id, two.id);
assert.equal(terminals.get(one.id), one);

// The list is how a reloaded client learns which of its stored ids are real.
const listed = terminals.list(CWD).map((t) => t.id);
assert.deepEqual(new Set(listed), new Set([one.id, two.id]));
assert.deepEqual(terminals.list("/tmp/pwi-not-a-project"), []);

/*
 * Attach replays the scrollback BEFORE subscribing. A client that only got
 * live output would open on a blank pane after a reload, with the output of
 * whatever is running already lost.
 */
terminals.write(one.id, "echo first-marker\n");
const early = client(one.id);
await early.match(/first-marker/);
const late = client(one.id);
await late.match(/first-marker/);

// And the shells are genuinely independent: input to one is not seen by the
// other, which is what makes "server here, tests there" work at all.
const other = client(two.id);
terminals.write(two.id, "echo second-shell\n");
await other.match(/second-shell/);
assert.equal(/first-marker/.test(other.text()), false);

/*
 * Each has its own window size. With splits, two panes of the same project
 * are different widths at the same time, so a shared size would leave one of
 * them drawing wrong.
 */
terminals.resize(one.id, 123, 45);
terminals.resize(two.id, 61, 20);
terminals.write(one.id, "stty size\n");
terminals.write(two.id, "stty size\n");
await late.match(/45 123/);
await other.match(/20 61/);

/*
 * Nonsense sizes are dropped rather than forwarded: a pane measured mid-
 * layout legitimately reports 0 columns, and a 0-column pty wedges the shell
 * for good. The last real size must therefore still be in force.
 */
terminals.resize(one.id, 0, 0);
terminals.write(one.id, "stty size; echo size-checked\n");
await late.match(/size-checked/);
assert.equal(/\b0 0\b/.test(late.text()), false);
early.detach();
late.detach();
other.detach();

/*
 * A shell the user exited is KEPT until closed: the last thing it printed is
 * usually why the terminal was opened, and dropping the entry would drop
 * that with it. It is reported as not running, so the client can show it
 * exited rather than reconnecting forever.
 */
const dying = client(two.id);
terminals.write(two.id, "exit\n");
await dying.gone();
assert.equal(dying.exit(), 0);
assert.equal(terminals.list(CWD).find((t) => t.id === two.id)?.running, false);
assert.ok(terminals.get(two.id));
dying.detach();

/*
 * Detaching is what hiding the pane does, and it must leave the shell alone:
 * close() is the only thing that ends one.
 */
const survivor = client(one.id);
terminals.write(one.id, "echo survives-detach\n");
await survivor.match(/survives-detach/);
survivor.detach();
assert.equal(terminals.list(CWD).find((t) => t.id === one.id)?.running, true);

terminals.close(one.id);
terminals.close(two.id);
assert.deepEqual(terminals.list(CWD), []);

terminals.disposeAll();
console.log("ok");
