import { View, div } from "gpui-kit";
import { Editor, EditorState, h_flex, Input, InputState, v_flex } from "gpui-base";
import { closeOverlay, focused, knownAgents, notify, openOverlay, panes, props, run, setShared, shared, spaces, theme } from "herdr";

import {
  STORE_KEY,
  agentLaunch,
  commandsForSpace,
  importLegacy as migrateLegacy,
  normalizeStore,
  remove,
  search,
  shellLaunch,
  upsert,
} from "./model.js";

function currentContext() {
  const space = spaces().find((candidate) => candidate.active);
  const focus = focused();
  const pane = focus?.pane ? panes().find((candidate) => candidate.pane === focus.pane) : null;
  return {
    space: space?.id ?? null,
    folder: pane?.cwd || focus?.cwd || space?.folder || null,
    on: focus?.pane === null
      ? (focus?.terminal?.includes("/") ? focus.terminal.split("/")[0] : null)
      : space?.machine ?? null,
  };
}

function newId() {
  return `qc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function typeLabel(command) {
  return command.type === "shell" ? "Shell" : "Agent";
}

function bodyPreview(command) {
  return command.type === "shell" ? command.command : `${command.agent} · ${command.prompt}`;
}

function input(state, focused) {
  const t = theme();
  return Input.new(state).h(34).px(10).rounded(8).border_1()
    .border_color(focused ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground);
}

export default class QuickCommands extends View {
  init(_props, cx) {
    this.editor = props()?.editor ?? null;
    this.context = currentContext();
    this.agents = [];
    this.agentsError = null;
    if (this.editor) this.initEditor(cx);
    else this.initManager(cx);
  }

  initManager(cx) {
    this.query = "";
    this.searchInput = InputState.new({ value: "", placeholder: "Search commands" });
    this.searchInput.on("change", (_event, cx) => { this.query = this.searchInput.value(); cx.notify(); });
    this.running = new Set();
    this.notice = null;
    this.error = null;
  }

  initEditor(cx) {
    const command = this.editor.command ?? {
      id: newId(), name: "", type: "shell", command: "", agent: "", prompt: "",
    };
    this.editing = command;
    this.spaceId = this.editor.spaceId ?? this.context.space;
    this.kind = command.type;
    this.name = InputState.new({ value: command.name, placeholder: "Command name" });
    this.shell = EditorState.new({ value: command.command ?? "", line_numbers: false, folding: false, soft_wrap: true });
    this.prompt = EditorState.new({ value: command.prompt ?? "", line_numbers: false, folding: false, soft_wrap: true });
    this.agentKey = command.agent ?? "";
    this.error = null;
    this.deleteArmed = Boolean(this.editor.deleteConfirm);
    this.name.on("change", (_event, cx) => { this.error = null; cx.notify(); });
    this.shell.on("change", (_event, cx) => { this.error = null; cx.notify(); });
    this.prompt.on("change", (_event, cx) => { this.error = null; cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.context.on });
        if (!this.agentKey) this.agentKey = this.agents.find((agent) => agent.installed)?.key ?? "";
      } catch (error) { this.agentsError = errorText(error); }
      cx.notify();
    });
    this.name.focus();
    cx.timer.after(100, () => this.name.focus());
  }

  store() {
    return normalizeStore(shared(STORE_KEY));
  }

  write(next) {
    setShared(STORE_KEY, next);
  }

  openEditor(command = null, deleteConfirm = false) {
    const context = currentContext();
    if (!context.space) {
      this.error = "No active Herdr space";
      return;
    }
    openOverlay({
      mod: "quick-commands",
      kind: "dialog",
      width: 640,
      height: 540,
      props: { editor: { command, deleteConfirm, spaceId: context.space } },
    });
  }

  launch(command, cx) {
    if (this.running.has(command.id)) return;
    this.running.add(command.id);
    this.error = null;
    this.notice = null;
    const context = currentContext();
    cx.spawn(async (cx) => {
      try {
        if (!context.space) throw new Error("No active Herdr space");
        let plan;
        if (command.type === "shell") {
          plan = shellLaunch(command, context);
        } else {
          const agents = await knownAgents({ on: context.on });
          const agent = agents.find((candidate) => candidate.key === command.agent && candidate.installed);
          if (!agent) throw new Error(`Agent CLI is unavailable: ${command.agent}`);
          plan = agentLaunch(command, agent.run, context);
        }
        run(plan.name, plan.args);
        this.notice = command.type === "shell"
          ? `Opened terminal: ${command.name}`
          : `Started ${command.agent}: ${command.name}`;
        notify({ title: "Quick command started", body: command.name, level: "success" });
      } catch (error) {
        this.error = errorText(error);
        notify({ title: "Quick command failed", body: this.error, level: "error" });
      } finally {
        this.running.delete(command.id);
        cx.notify();
      }
    });
    cx.notify();
  }

  saveEditor() {
    try {
      if (!this.spaceId) throw new Error("No active Herdr space");
      // The command's space is captured when its editor opens, so switching
      // spaces behind a dialog can never move it unexpectedly.
      const next = upsert(this.store(), this.spaceId, {
        id: this.editing.id,
        name: this.name.value(),
        type: this.kind,
        command: this.shell.value(),
        agent: this.agentKey,
        prompt: this.prompt.value(),
        updatedAt: new Date().toISOString(),
      });
      this.write(next);
      notify({ title: "Quick command saved", body: this.name.value().trim(), level: "success" });
      closeOverlay(props().overlay);
    } catch (error) { this.error = errorText(error); }
  }

  deleteEditor() {
    if (!this.deleteArmed) {
      this.deleteArmed = true;
      return;
    }
    if (!this.spaceId) {
      this.error = "No active Herdr space";
      return;
    }
    this.write(remove(this.store(), this.spaceId, this.editing.id));
    notify({ title: "Quick command deleted", body: this.editing.name, level: "info" });
    closeOverlay(props().overlay);
  }

  renderManager(cx) {
    const t = theme();
    const context = currentContext();
    const store = this.store();
    const commands = context.space ? search(commandsForSpace(store, context.space), this.query) : [];
    const legacy = store.legacy.items;
    const row = (command) => {
      const busy = this.running.has(command.id);
      const action = (id, text, handler, color = t.muted) => div().id(id).px(6).py(3).rounded(5).text_size(10.5).text_color(color)
        .cursor_pointer().hover((element) => element.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_event, cx) => cx.stop_propagation())
        .on_click((_event, cx) => { cx.stop_propagation(); handler(cx); }).child(text);
      return h_flex().id(`quick-command-${command.id}`).flex_none().min_h(54).px(8).py(7).gap(7).rounded(7).items_center()
        .cursor_pointer().hover((element) => element.bg(t.hover)).on_click((_event, cx) => this.launch(command, cx))
        .child(div().w(7).h(7).rounded_full().flex_none().bg(command.type === "shell" ? t.ansi3 : t.ansi5))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().min_w(0).gap(5).items_center().child(div().flex_1().truncate().text_color(t.foreground).child(command.name))
            .child(div().px(4).py(1).rounded(3).text_size(9.5).text_color(t.dim).bg(t.raised).child(typeLabel(command))))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(bodyPreview(command))))
        .child(h_flex().flex_none().gap(1).items_center()
          .child(action(`quick-edit-${command.id}`, "Edit", () => this.openEditor(command)))
          .child(action(`quick-delete-${command.id}`, "Delete", () => this.openEditor(command, true), t.ansi1))
          .child(div().text_size(10.5).text_color(busy ? t.working : t.dim).child(busy ? "Starting…" : "Run")));
    };
    return v_flex().id("quick-commands").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .child(h_flex().h(42).flex_none().px(10).gap(7).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Quick commands"))
        .child(div().flex_1())
        .child(div().id("quick-add").px(8).py(4).rounded(6).bg(t.solid).text_color(t.solid_foreground).text_size(11).cursor_pointer()
          .hover((element) => element.bg(t.accent)).on_click(() => this.openEditor()).child("+ Add")))
      .child(div().px(8).py(7).border_b(1).border_color(t.border)
        .child(input(this.searchInput, false)))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar().p(5).gap(2)
        .when(legacy.length > 0 && context.space, (element) => element.child(h_flex().mx(3).mb(5).px(7).py(6).gap(6).items_center().rounded(6).bg(t.raised).text_size(10.5)
          .child(div().flex_1().min_w(0).text_color(t.dim).child(`${legacy.length} legacy global shortcut${legacy.length === 1 ? "" : "s"}`))
          .child(div().id("quick-import-legacy").px(6).py(3).rounded(5).cursor_pointer().bg(t.selected).text_color(t.foreground)
            .hover((item) => item.bg(t.hover)).on_click((_event, cx) => {
              this.write(migrateLegacy(store, context.space));
              notify({ title: "Quick commands imported", body: "Imported into this space only", level: "success" });
              cx.notify();
            }).child("Import here"))))
        .children(commands.map(row))
        .when(commands.length === 0, (element) => element.child(div().px(8).py(12).text_color(t.dim).text_size(11.5)
          .child(context.space ? (this.query ? "No matching commands" : "Add a shell or agent command") : "No active Herdr space"))))
      .child(div().min_h(30).px(10).py(7).border_t(1).border_color(t.border).text_size(10.5)
        .text_color(this.error ? t.ansi1 : this.notice ? t.ansi2 : t.dim)
        .child(this.error || this.notice || "Shell opens a terminal · Agent starts a CLI with its prompt"));
  }

  renderEditor(cx) {
    const t = theme();
    const label = (text) => div().pt(8).pb(5).text_size(11).text_color(t.dim).child(text);
    const typeButton = (type, text) => div().id(`quick-type-${type}`).px(10).py(6).rounded(6).text_size(11.5).cursor_pointer()
      .bg(this.kind === type ? t.selected : t.raised).text_color(this.kind === type ? t.foreground : t.muted)
      .hover((element) => element.bg(t.hover).text_color(t.foreground))
      .on_click((_event, cx) => { this.kind = type; this.error = null; cx.notify(); }).child(text);
    const button = (id, text, action, primary = false, danger = false) => div().id(id).px(11).py(7).rounded(7).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : danger ? t.ansi1 : t.foreground)
      .hover((element) => element.opacity(0.86)).on_click(action).child(text);
    const installed = this.agents.filter((agent) => agent.installed);
    return v_flex().id("quick-command-editor").size_full().min_h(0).p(18).gap(3).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(this.editing.name ? "Edit quick command" : "Add quick command"))
        .child(div().text_size(11).text_color(t.dim).child("Esc closes")))
      .child(label("Name"))
      .child(input(this.name, true))
      .child(label("Type"))
      .child(h_flex().gap(6).child(typeButton("shell", "Shell command")).child(typeButton("agent", "Agent prompt")))
      .when(this.kind === "shell", (element) => element
        .child(label("Command · runs as sh -lc in a new terminal"))
        .child(Editor.new(this.shell).h(120).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12)))
      .when(this.kind === "agent", (element) => element
        .child(label("Agent CLI"))
        .child(h_flex().gap(5).flex_wrap().children(installed.map((agent) => div().id(`quick-agent-${agent.key}`).px(8).py(5).rounded(6).text_size(11).cursor_pointer()
          .bg(this.agentKey === agent.key ? t.selected : t.raised).text_color(this.agentKey === agent.key ? t.foreground : t.muted)
          .hover((item) => item.bg(t.hover).text_color(t.foreground)).on_click((_event, cx) => { this.agentKey = agent.key; this.error = null; cx.notify(); }).child(agent.name))))
        .when(installed.length === 0, (item) => item.child(div().text_size(11).text_color(t.ansi1).child(this.agentsError || "No installed agent CLI found")))
        .child(label("First prompt"))
        .child(Editor.new(this.prompt).h(120).rounded(8).border_1().border_color(t.input).bg(t.background).text_size(12)))
      .when(Boolean(this.error), (element) => element.child(div().pt(6).text_size(11.5).text_color(t.ansi1).child(this.error)))
      .child(h_flex().pt(14).gap(8).items_center()
        .when(Boolean(this.editing.name), (element) => element.child(button("quick-editor-delete", this.deleteArmed ? "Confirm delete" : "Delete", () => this.deleteEditor(), false, true)))
        .child(div().flex_1())
        .child(button("quick-editor-cancel", "Cancel", () => closeOverlay(props().overlay)))
        .child(button("quick-editor-save", "Save", () => this.saveEditor(), true)));
  }

  render(cx) {
    return this.editor ? this.renderEditor(cx) : this.renderManager(cx);
  }
}
