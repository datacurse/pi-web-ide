import assert from "node:assert/strict";
import { test } from "node:test";
import type { PointerEvent as ReactPointerEvent } from "react";
import { startPointerDrag } from "./pointerDrag.js";

for (const finish of ["pointerup", "pointercancel", "lostpointercapture"]) {
	test(`drag listeners are removed on ${finish} and ignore other pointers`, () => {
		const target = new class extends EventTarget {
			captured?: number;
			setPointerCapture(id: number) { this.captured = id; }
		}();
		let prevented = false;
		let moves = 0;
		let ends = 0;
		startPointerDrag({
			button: 0, pointerId: 1, currentTarget: target, preventDefault() { prevented = true; },
		} as unknown as ReactPointerEvent<HTMLElement>, () => moves++, () => ends++);
		assert.equal(target.captured, 1);
		assert.equal(prevented, true);
		const emit = (type: string, id = 1) => {
			const event = new Event(type);
			Object.defineProperty(event, "pointerId", { value: id });
			target.dispatchEvent(event);
		};
		emit("pointermove", 2);
		emit(finish, 2);
		assert.equal(moves, 0);
		assert.equal(ends, 0);
		emit("pointermove");
		assert.equal(moves, 1);
		emit(finish);
		assert.equal(ends, 1);
		emit("pointermove");
		emit(finish);
		assert.equal(moves, 1);
		assert.equal(ends, 1);
	});
}

test("non-primary pointer buttons do not start a drag", () => {
	startPointerDrag({ button: 2 } as ReactPointerEvent<HTMLElement>,
		() => assert.fail("unexpected move"), () => assert.fail("unexpected end"));
});
