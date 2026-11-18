export const STORE_KEY = "opcflow.quick-commands@1";
export const STORE_SCHEMA = "opcflow.quick-commands/store@2";
export const LEGACY_STORE_SCHEMA = "opcflow.quick-commands/store@1";
export const COMMAND_TYPES = Object.freeze(["shell", "agent"]);
const MAX_COMMANDS = 200;
const MAX_NAME = 120;
const MAX_BODY = 16000;

function string(value, name, { required = false, max = MAX_BODY } = {}) {
  if (typeof value !== "string") throw new Error(`${name} must be text`);
  const result = value.trim();
  if (required && !result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} is too long`);
  return result;
}

function id(value) {
  return string(value, "id", { required: true, max: 160 });
}

function spaceId(value) {
  return string(value, "space id", { required: true, max: 240 });
}

export function makeCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("command must be an object");
  const type = string(value.type, "type", { required: true, max: 16 });
  if (!COMMAND_TYPES.includes(type)) throw new Error("type must be shell or agent");
  const command = {
    id: id(value.id),
    name: string(value.name, "name", { required: true, max: MAX_NAME }),
    type,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
  if (type === "shell") command.command = string(value.command, "shell command", { required: true });
  else {
    command.agent = string(value.agent, "agent", { required: true, max: 120 });
    command.prompt = string(value.prompt, "agent prompt", { required: true });
  }
  return Object.freeze(command);
}

function normalizeItems(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of Array.isArray(items) ? items : []) {
    try {
      const command = makeCommand(item);
      if (!seen.has(command.id)) {
        seen.add(command.id);
        normalized.push(command);
      }
    } catch { /* Ignore malformed persisted entries, retaining the valid commands. */ }
    if (normalized.length >= MAX_COMMANDS) break;
  }
  return Object.freeze(normalized);
}

export function normalizeStore(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const spaces = {};
  for (const [key, candidate] of Object.entries(source.spaces ?? {})) {
    try {
      const normalizedId = spaceId(key);
      spaces[normalizedId] = normalizeItems(Array.isArray(candidate) ? candidate : candidate?.items);
    } catch { /* Ignore malformed space buckets. */ }
  }
  // Version 1 stored every command in one list. Preserve it as explicit legacy
  // data so a person chooses which space receives it after upgrading.
  const legacy = source.schema === LEGACY_STORE_SCHEMA || Array.isArray(source.items)
    ? normalizeItems(source.items)
    : normalizeItems(source.legacy?.items);
  return Object.freeze({
    schema: STORE_SCHEMA,
    spaces: Object.freeze(spaces),
    legacy: Object.freeze({ items: legacy }),
  });
}

export function commandsForSpace(store, currentSpace) {
  const root = normalizeStore(store);
  return root.spaces[spaceId(currentSpace)] ?? Object.freeze([]);
}

function withSpace(root, currentSpace, items) {
  const key = spaceId(currentSpace);
  return Object.freeze({
    schema: STORE_SCHEMA,
    spaces: Object.freeze({ ...root.spaces, [key]: Object.freeze(items) }),
    legacy: root.legacy,
  });
}

export function upsert(store, currentSpace, draft) {
  const command = makeCommand(draft);
  const root = normalizeStore(store);
  const items = commandsForSpace(root, currentSpace).filter((item) => item.id !== command.id);
  return withSpace(root, currentSpace, [...items, command]);
}

export function remove(store, currentSpace, commandId) {
  const idValue = id(commandId);
  const root = normalizeStore(store);
  return withSpace(root, currentSpace, commandsForSpace(root, currentSpace).filter((item) => item.id !== idValue));
}

export function importLegacy(store, currentSpace) {
  const root = normalizeStore(store);
  const current = commandsForSpace(root, currentSpace);
  const ids = new Set(current.map((item) => item.id));
  const items = [...current, ...root.legacy.items.filter((item) => !ids.has(item.id))];
  const next = withSpace(root, currentSpace, items);
  return Object.freeze({ ...next, legacy: Object.freeze({ items: Object.freeze([]) }) });
}

export function search(commands, query) {
  const needle = String(query ?? "").trim().toLocaleLowerCase();
  if (!needle) return [...commands];
  return commands.filter((command) => [
    command.name,
    command.type,
    command.command ?? "",
    command.agent ?? "",
    command.prompt ?? "",
  ].join("\n").toLocaleLowerCase().includes(needle));
}

export function shellLaunch(command, context) {
  const saved = makeCommand(command);
  if (saved.type !== "shell") throw new Error("shell launch requires a shell command");
  return Object.freeze({
    name: "tab.new",
    args: {
      name: saved.name,
      space: context.space,
      folder: context.folder ?? undefined,
      argv: ["sh", "-lc", saved.command],
    },
  });
}

export function agentLaunch(command, agentRun, context) {
  const saved = makeCommand(command);
  if (saved.type !== "agent") throw new Error("agent launch requires an agent command");
  if (!Array.isArray(agentRun) || agentRun.length === 0 || !agentRun.every((part) => typeof part === "string" && part.length > 0)) {
    throw new Error("selected agent has no launch argv");
  }
  return Object.freeze({
    name: "tab.new",
    args: {
      name: saved.name,
      space: context.space,
      folder: context.folder ?? undefined,
      argv: [...agentRun],
      task: saved.prompt,
    },
  });
}
