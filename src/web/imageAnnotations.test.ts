import { test } from "node:test";
import assert from "node:assert/strict";
import { annotationReference, annotationSvg, markLabel, markSvg, moveMark, type Mark } from "./imageAnnotations.js";

const area: Mark = { id: 7, kind: "area", color: "#ef4444", width: 2, points: [{ x: 90, y: 80 }, { x: 10, y: 20 }] };

test("rectangles normalize reverse drags and keep their stable label", () => {
	const svg = markSvg(area);
	assert.match(svg, /x="10" y="20" width="80" height="60"/);
	assert.match(svg, />Area 7<\/text>/);
	assert.equal(markLabel(area), "Area 7");
});

test("moving a mark preserves its identity and does not mutate the original", () => {
	const moved = moveMark(area, 5, -10);
	assert.equal(moved.id, 7);
	assert.deepEqual(moved.points, [{ x: 95, y: 70 }, { x: 15, y: 10 }]);
	assert.deepEqual(area.points, [{ x: 90, y: 80 }, { x: 10, y: 20 }]);
});

test("arrows render a head and expose the destination to the model", () => {
	const arrow: Mark = { ...area, id: 9, kind: "arrow" };
	assert.equal((markSvg(arrow).match(/<polyline/g) ?? []).length, 2);
	assert.match(annotationReference(arrow, 100, 200), /Arrow 9/);
	assert.match(annotationReference(arrow, 100, 200), /tip 10\.0%,10\.0%/);
});

test("pen strokes retain every point and exports contain all labeled marks", () => {
	const pen: Mark = { ...area, id: 12, kind: "pen", points: [{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }] };
	const svg = annotationSvg([area, pen], 100, 200);
	assert.match(svg, /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
	assert.match(svg, /viewBox="0 0 100 200"/);
	assert.match(svg, /points="1,2 3,4 5,6"/);
	assert.match(svg, /Area 7/);
	assert.match(svg, /Pen 12/);
});

test("references use original image percentages, independent of zoom", () => {
	assert.equal(annotationReference(area, 100, 200), "Area 7 (#ef4444; bounds 10.0%,10.0%–90.0%,40.0%)");
});
