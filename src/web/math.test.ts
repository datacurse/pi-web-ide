// Run: node --import tsx src/web/math.test.ts
import assert from "node:assert/strict";
import { extractMath, PLACEHOLDER } from "./math.js";

const placeholders = (s: string) => s.match(/\uE000\d+\uE001/g) ?? [];

// No math: the source comes back byte-identical, and nothing downstream has
// to look for placeholders that cannot be there.
const plain = extractMath("Angular velocity is a rigid-body property.");
assert.equal(plain.source, "Angular velocity is a rigid-body property.");
assert.deepEqual(plain.math, []);

/*
 * THE bug this exists for: the underscores in a real expression are markdown
 * emphasis, so the parser turns half the TeX into <em> and the source is
 * gone. Extraction has to happen before the parse, leaving nothing markdown
 * can act on.
 */
const display = extractMath(
	"What offset touches:\n\n$$a_{\\text{sensor}} = a_{\\text{body}} + \\underbrace{\\alpha \\times r}_{\\text{tangential}}$$\n",
);
assert.deepEqual(display.math, [
	{
		tex: "a_{\\text{sensor}} = a_{\\text{body}} + \\underbrace{\\alpha \\times r}_{\\text{tangential}}",
		display: true,
	},
]);
assert.ok(!display.source.includes("_"), "no markdown-significant character survives in the placeholder");

// Several expressions in one paragraph: they all become one text node at
// render time, so each needs its own addressable index.
const many = extractMath("$r$ = vector; $r=0$ kills both terms.");
assert.equal(many.math.length, 2);
assert.deepEqual(many.math.map((m) => m.tex), ["r", "r=0"]);
assert.equal(placeholders(many.source).length, 2);
assert.equal(PLACEHOLDER.exec(many.source)?.[1], "0");

// Inline and display use different renderings, so the two delimiter styles
// must not collapse into one kind.
assert.deepEqual(extractMath("$x$").math, [{ tex: "x", display: false }]);
assert.deepEqual(extractMath("$$x$$").math, [{ tex: "x", display: true }]);
assert.deepEqual(extractMath("\\(x\\)").math, [{ tex: "x", display: false }]);
assert.deepEqual(extractMath("\\[x\\]").math, [{ tex: "x", display: true }]);

/*
 * Money is not math. "$5 and $10" is the shape that made every naive
 * implementation of this render a sentence as an expression: TeX never opens
 * with whitespace nor closes after it, which is what separates the two.
 */
const money = extractMath("It costs $5 and $10 more.");
assert.deepEqual(money.math, []);
assert.equal(money.source, "It costs $5 and $10 more.");
assert.deepEqual(extractMath("$ x $").math, []);

// A `$` with no partner is a `$`.
assert.deepEqual(extractMath("costs $5").math, []);

/*
 * Code is verbatim. A fence full of shell is exactly what would otherwise be
 * read as math — and rendering `$1` from an awk script as an expression would
 * corrupt the one kind of text that must survive character for character.
 */
const fenced = extractMath("```sh\nawk '{print $1}' | grep $PATH\n```\n\nand $x$ after.");
assert.equal(fenced.math.length, 1);
assert.deepEqual(fenced.math[0], { tex: "x", display: false });
assert.ok(fenced.source.includes("awk '{print $1}' | grep $PATH"));

// Inline code too: `$HOME` in prose is a variable name, not a variable.
const inlineCode = extractMath("Set `$HOME` and `$PWD` first.");
assert.deepEqual(inlineCode.math, []);
assert.equal(inlineCode.source, "Set `$HOME` and `$PWD` first.");

/*
 * A message being streamed ends mid-expression on almost every delta. An
 * unterminated delimiter stays text, or the answer would flicker between
 * prose and math as each chunk arrives.
 */
const partial = extractMath("the result is $$a_{\\text{sen");
assert.deepEqual(partial.math, []);
assert.equal(partial.source, "the result is $$a_{\\text{sen");

// An escaped dollar is a dollar, and stays escaped: markdown is what resolves
// `\$` to `$`, so unescaping here would hand the parser a live delimiter.
const escaped = extractMath("costs \\$5 and \\$10");
assert.deepEqual(escaped.math, []);
assert.equal(escaped.source, "costs \\$5 and \\$10");

console.log("ok");
