import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { SessionTabs } from "./SessionTabs.js";

const require = createRequire(import.meta.url);
const modules: Record<string, unknown> = {
	"react/jsx-runtime": require("react/jsx-runtime"),
	"@phosphor-icons/react": require("@phosphor-icons/react"),
	"./sessionName.js": require("./sessionName.js"),
	"./attention.js": require("./attention.js"),
	"./fileIcon.js": require("./fileIcon.js"),
	"./piMark.js": require("./piMark.js"),
	"./tabs.js": require("./tabs.js"),
	"./ui.js": require("./ui.js"),
	"./i18n.js": require("./i18n.js"),
};
const source = ts.transpileModule(readFileSync(new URL("./SessionTabs.tsx", import.meta.url), "utf8"), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function element(clientWidth: number, scrollWidth: number) {
	return {
		clientWidth, scrollWidth, overflow: false,
		toggleAttribute(name: string, enabled: boolean) {
			assert.equal(name, "data-overflow");
			this.overflow = enabled;
		},
	};
}

test("tab fades clear when tabs and labels fit after closing or resizing", () => {
	const label = element(80, 120);
	const strip = { ...element(300, 600), querySelectorAll: () => [label] };
	const effects: Array<() => (() => void) | undefined> = [];
	let refs = 0;
	let update = () => {};
	let disconnected = false;
	const observed: unknown[] = [];
	class Observer {
		constructor(callback: () => void) { update = callback; }
		observe(target: unknown) { observed.push(target); }
		disconnect() { disconnected = true; }
	}
	const exports = {} as { SessionTabs: typeof SessionTabs };
	runInNewContext(source, {
		exports, ResizeObserver: Observer,
		require: (name: string) => name === "react" ? {
			useRef: (initial: unknown) => ({ current: refs++ === 1 ? strip : initial }),
			useState: (initial: unknown) => [initial, () => {}],
			useMemo: (fn: () => unknown) => fn(),
			useEffect: (fn: () => (() => void) | undefined) => effects.push(fn),
		} : modules[name],
	});
	exports.SessionTabs({
		tabs: ["file:/a.ts"], sessions: [], attention: new Map(), active: undefined,
		panelId: "panel", latestPrompt: false, pinned: [], dirtyFiles: {},
		onSelect: () => {}, onClose: () => {}, onReorder: () => {},
	});
	const cleanup = effects[0]();
	assert.deepEqual(observed, [strip, label]);
	assert.equal(strip.overflow, true);
	assert.equal(label.overflow, true);

	strip.scrollWidth = 300;
	label.scrollWidth = 80;
	update();
	assert.equal(strip.overflow, false);
	assert.equal(label.overflow, false);

	strip.clientWidth = 200;
	label.clientWidth = 60;
	update();
	assert.equal(strip.overflow, true);
	assert.equal(label.overflow, true);
	cleanup?.();
	assert.equal(disconnected, true);
});
