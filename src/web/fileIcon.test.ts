// Run: node --import tsx src/web/fileIcon.test.ts
//
// Names only: the part worth testing is the lookup, not the rendered glyph.
import assert from "node:assert/strict";
import { iconIdFor } from "./fileIcon.js";

// Language ids, resolved through the extension table.
assert.equal(iconIdFor("main.py"), "_python");
assert.equal(iconIdFor("index.ts"), "_typescript");
assert.equal(iconIdFor("App.tsx"), "_react");
assert.equal(iconIdFor("notes.md"), "_markdown");
assert.equal(iconIdFor("install.ps1"), "_powershell");

// Case does not matter.
assert.equal(iconIdFor("Main.PY"), "_python");

// Whole filename beats extension.
assert.equal(iconIdFor("tsconfig.json"), iconIdFor("TSCONFIG.JSON"));
assert.notEqual(iconIdFor("tsconfig.json"), iconIdFor("data.json"));

// Longest extension first: `test.ts` has its own icon, `ts` is the fallback.
assert.notEqual(iconIdFor("tabs.test.ts"), iconIdFor("tabs.ts"));

// A dotfile's leading dot starts an extension, as in VS Code.
assert.equal(iconIdFor(".gitattributes"), "_git");
assert.equal(iconIdFor(".gitignore"), "_git");

// Unknown names still resolve — a tree must draw every file.
assert.equal(iconIdFor("data.xyzzy"), "_default");
assert.equal(iconIdFor("noextension"), "_default");
assert.equal(iconIdFor(""), "_default");

console.log("fileIcon: ok");
