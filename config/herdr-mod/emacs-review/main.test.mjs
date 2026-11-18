import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const source = await fs.readFile(new URL("./main.js", import.meta.url), "utf8");

test("new reviews use a one-shot Emacs intent without creating a Herdr mailbox session", () => {
  const start = source.slice(
    source.indexOf("  start(cx)"),
    source.indexOf("  scheduleTick(cx)"),
  );

  assert.match(start, /emacsStartProjectExpression\(/);
  assert.doesNotMatch(start, /makeRequest\(/);
  assert.doesNotMatch(start, /writeTextFile\(/);
  assert.doesNotMatch(start, /saveSession\(/);
  assert.doesNotMatch(start, /request\.json/);
});

test("a new review can open without a Herdr agent target", () => {
  const start = source.slice(
    source.indexOf("  start(cx)"),
    source.indexOf("  scheduleTick(cx)"),
  );
  const render = source.slice(source.indexOf("  render(cx)"));

  assert.match(start, /target: target \?/);
  assert.doesNotMatch(start, /if \(!target/);
  assert.match(render, /const canStart = Boolean\(this\.context\.cwd/);
});
