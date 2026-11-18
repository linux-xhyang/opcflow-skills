import assert from "node:assert/strict";
import test from "node:test";

import {
  agentLaunch,
  commandsForSpace,
  importLegacy,
  makeCommand,
  normalizeStore,
  remove,
  search,
  shellLaunch,
  upsert,
} from "./model.js";

const shell = { id: "shell-status", name: "Git status", type: "shell", command: "git status" };
const agent = { id: "agent-review", name: "Review changes", type: "agent", agent: "claude", prompt: "Review the current diff." };

test("commands normalize, preserve legacy global entries, and retain stable ids", () => {
  const store = normalizeStore({ items: [shell, { id: "bad", name: "", type: "shell", command: "" }, agent, { ...shell }] });
  assert.equal(store.legacy.items.length, 2);
  assert.deepEqual(store.legacy.items.map((item) => item.id), ["shell-status", "agent-review"]);
  assert.throws(() => makeCommand({ ...agent, prompt: "" }), /agent prompt is required/);
});

test("search covers names, types, shell text, agent keys, and prompts", () => {
  const commands = commandsForSpace(
    normalizeStore({ spaces: { "space-1": { items: [shell, agent] } } }),
    "space-1",
  );
  assert.deepEqual(search(commands, "status").map((item) => item.id), ["shell-status"]);
  assert.deepEqual(search(commands, "claude").map((item) => item.id), ["agent-review"]);
  assert.deepEqual(search(commands, "current diff").map((item) => item.id), ["agent-review"]);
});

test("upsert and remove isolate shortcuts by space", () => {
  const initial = normalizeStore({ spaces: { "space-1": { items: [shell, agent] }, "space-2": { items: [agent] } } });
  const updated = upsert(initial, "space-1", { ...shell, name: "Repository status" });
  assert.equal(commandsForSpace(updated, "space-1").length, 2);
  assert.equal(commandsForSpace(updated, "space-1").find((item) => item.id === shell.id).name, "Repository status");
  assert.deepEqual(commandsForSpace(updated, "space-2").map((item) => item.id), ["agent-review"]);
  const removed = remove(updated, "space-1", "agent-review");
  assert.deepEqual(commandsForSpace(removed, "space-1").map((item) => item.id), ["shell-status"]);
});

test("legacy global shortcuts are imported only after choosing a destination space", () => {
  const initial = normalizeStore({ schema: "opcflow.quick-commands/store@1", items: [shell, agent] });
  assert.deepEqual(commandsForSpace(initial, "space-1"), []);
  const migrated = importLegacy(initial, "space-1");
  assert.deepEqual(commandsForSpace(migrated, "space-1").map((item) => item.id), ["shell-status", "agent-review"]);
  assert.deepEqual(commandsForSpace(migrated, "space-2"), []);
  assert.deepEqual(migrated.legacy.items, []);
});

test("shell launch keeps a command as one shell argv and agent launch uses task injection", () => {
  assert.deepEqual(shellLaunch(shell, { space: "space-1", folder: "/repo" }), {
    name: "tab.new",
    args: { name: "Git status", space: "space-1", folder: "/repo", argv: ["sh", "-lc", "git status"] },
  });
  assert.deepEqual(agentLaunch(agent, ["claude"], { space: "space-1", folder: "/repo" }), {
    name: "tab.new",
    args: {
      name: "Review changes", space: "space-1", folder: "/repo", argv: ["claude"], task: "Review the current diff.",
    },
  });
});
