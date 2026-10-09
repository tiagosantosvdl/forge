const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness(workspaceCount = 3) {
  class Actor {
    constructor() {
      this.children = [];
    }
    contains(actor) {
      return this.children.includes(actor);
    }
    get_parent() {
      return this.parent;
    }
    add_child(actor) {
      actor.parent?.remove_child(actor);
      this.children.push(actor);
      actor.parent = this;
    }
    remove_child(actor) {
      this.children.splice(this.children.indexOf(actor), 1);
      actor.parent = null;
    }
    hide() {}
    destroy() {
      this.destroyed = true;
      for (const child of [...this.children]) child.destroy();
      this.parent?.remove_child(this);
    }
  }
  const timers = new Map();
  let source = 0;
  let contents;
  const errors = [];
  const calls = [];
  const workspaces = Array.from({ length: workspaceCount }, (_, index) => ({
    index: () => index,
    get_work_area_for_monitor: (index) => ({
      width: monitors[index].width,
      height: monitors[index].height,
    }),
  }));
  let monitors = [];
  const workspaceManager = {
    get_n_workspaces: () => workspaces.length,
    get_workspace_by_index: (index) => workspaces[index],
  };
  const file = {
    query_exists: () => contents !== undefined,
    load_contents: () => [true, new TextEncoder().encode(contents)],
    get_parent: () => ({ make_directory_with_parents() {} }),
    replace_contents: (value) => {
      contents = value;
    },
  };
  const context = vm.createContext({
    TextDecoder,
    GObject: { Object: class {}, registerClass() {} },
    Utils: { createEnum: (names) => Object.fromEntries(names.map((name) => [name, name])) },
    Window: { WINDOW_MODES: { TILE: "TILE", FLOAT: "FLOAT" } },
    Logger: { debug() {}, info() {}, warn() {}, error: (value) => errors.push(value) },
    St: { Bin: Actor, BoxLayout: Actor },
    Main: {
      layoutManager: {
        get monitors() {
          return monitors;
        },
      },
    },
    global: {
      window_group: new Actor(),
      workspace_manager: workspaceManager,
      display: {
        get_workspace_manager: () => workspaceManager,
        get_n_monitors: () => monitors.length,
        get_monitor_geometry: (index) => monitors[index],
        get_primary_monitor: () => monitors.find((monitor) => monitor.primary).index,
      },
    },
    Gio: {
      File: { new_for_path: () => file },
      FileCreateFlags: { PRIVATE: 1, REPLACE_DESTINATION: 2 },
      DBusCallFlags: { NONE: 0 },
      DBus: { session: { call: (...args) => calls.push(args.at(-1)) } },
    },
    GLib: {
      get_user_state_dir: () => "/tmp/forge-test",
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      timeout_add: (_, delay, callback) => {
        const id = ++source;
        timers.set(id, callback);
        return id;
      },
      Source: { remove: (id) => timers.delete(id) },
    },
  });
  for (const file of ["extension/tree.js", "shared/layout-state.js", "extension/layouts.js"]) {
    const code = fs
      .readFileSync(path.join(__dirname, "../lib", file), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, "");
    vm.runInContext(code, context);
  }
  vm.runInContext(
    "Object.assign(globalThis, { Tree, Node, Layouts, NODE_TYPES, LAYOUT_TYPES, configurationKey });",
    context
  );
  const settings = { get_boolean: () => true };
  const wm = {
    ext: { settings },
    bindWorkspaceSignals() {},
    determineSplitLayout: () => "HSPLIT",
    trackCurrentWindows() {},
    focusMetaWindow: null,
    renderTree() {
      controller.rendered();
    },
  };
  const tree = new context.Tree(wm);
  wm.tree = tree;
  const controller = new context.Layouts(wm);
  function activate(ids, width = 2500) {
    monitors = ids.map((id, index) => ({
      id,
      index,
      primary: index === 0,
      x: index * width,
      y: 0,
      width,
      height: 1200,
    }));
    controller.activate(monitors);
    assert.deepEqual(errors, []);
  }
  let sequence = 0;
  function add(key, monitor = 0, workspace = 0) {
    const window = {
      minimized: false,
      is_above: () => false,
      is_maximized: () => false,
      get_wm_class: () => key,
      get_stable_sequence: () => sequence++,
      get_monitor: () => monitor,
      get_workspace: () => workspaces[workspace],
      get_min_size: () => [true, 300, 200],
      change_workspace: (ws) => {
        workspace = ws.index();
      },
      move_to_monitor: (index) => {
        monitor = index;
      },
    };
    const node = Object.create(context.Node.prototype);
    Object.assign(node, {
      _type: "WINDOW",
      _data: window,
      _nodes: [],
      _actor: new Actor(),
      mode: "TILE",
      settings,
      tab: new Actor(),
    });
    tree.findNode(`mo${monitor}ws${workspace}`).appendChild(node);
    return node;
  }
  function saved(id, workspace, ...keys) {
    return {
      monitors: [
        {
          id,
          workspaces: [
            {
              index: workspace,
              tree: { layout: "TABBED", children: keys.map((key) => ({ key })) },
            },
          ],
        },
      ],
    };
  }
  function location(node) {
    return [node.nodeValue.get_monitor(), node.nodeValue.get_workspace().index()];
  }
  return {
    context,
    controller,
    tree,
    wm,
    activate,
    add,
    saved,
    location,
    errors,
    timers,
    calls,
    workspaces,
    reload: () => new context.Layouts(wm),
    contents: () => contents,
  };
}

test("reconnecting arbitrary monitor sets restores monitor, workspace and grouping", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const teams = h.add("teams", 1, 2);
  const calendar = h.add("calendar", 1, 2);
  const editor = h.add("code", 0, 1);
  h.controller.profile = {
    monitors: [
      ...h.saved("A", 1, "code").monitors,
      ...h.saved("B", 2, "teams", "calendar").monitors,
    ],
  };
  h.controller.apply();
  h.controller.rendered();
  const original = JSON.parse(JSON.stringify(h.controller.state.configurations[h.controller.key]));
  h.activate(["C"], 700);
  assert.deepEqual(h.location(teams), [0, 2]);
  assert.deepEqual(h.location(editor), [0, 1]);
  h.activate(["B", "A"]);
  assert.deepEqual(h.location(teams), [0, 2]);
  assert.deepEqual(h.location(calendar), [0, 2]);
  assert.equal(teams.parentNode, calendar.parentNode);
  assert.equal(teams.parentNode.layout, "TABBED");
  assert.deepEqual(h.location(editor), [1, 1]);
  const restored = JSON.parse(JSON.stringify(h.controller.state.configurations[h.controller.key]));
  restored.monitors.sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(restored, original);
});

test("restoration moves saved groups from unavailable workspaces to the last workspace", () => {
  const h = harness(2);
  h.activate(["A"]);
  const node = h.add("teams");
  h.controller.profile = h.saved("A", 7, "teams");
  h.controller.apply();
  assert.deepEqual(h.location(node), [0, 1]);
  assert.equal(h.tree.nodeWindows.length, 1);
});

test("workspace removal renumbers saved slots in every monitor configuration", () => {
  const h = harness();
  h.activate(["A"]);
  h.controller.profile = h.saved("A", 2, "teams");
  h.controller.state.configurations[h.controller.key] = h.controller.profile;
  h.controller.state.configurations['["B"]'] = h.saved("B", 2, "calendar");
  h.workspaces.pop();
  h.controller.workspaceRemoved(1);
  assert.equal(h.controller.profile.monitors[0].workspaces[0].index, 1);
  assert.equal(h.controller.state.configurations['["B"]'].monitors[0].workspaces[0].index, 1);
});

test("tabbed groups retain their remembered split direction across persistence and restoration", () => {
  const h = harness();
  h.activate(["A"]);
  h.add("teams");
  h.add("calendar");
  h.controller.profile = h.saved("A", 0, "teams", "calendar");
  h.controller.profile.monitors[0].workspaces[0].tree.splitLayout = "VSPLIT";
  h.controller.apply();
  h.controller.rendered();
  h.controller.write();
  const restored = h.reload();
  assert.equal(
    restored.state.configurations[h.controller.key].monitors[0].workspaces.find(
      (ws) => ws.index === 0
    ).tree.splitLayout,
    "VSPLIT"
  );
  const group = h.tree.nodeWindows[0].parentNode;
  group.restoreSplitLayout("HSPLIT");
  assert.equal(group.layout, "VSPLIT");
});

test("missing apps reopen in their saved group after other apps have restored", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const teams = h.add("teams");
  h.controller.profile = h.saved("B", 2, "teams", "calendar");
  h.controller.apply();
  h.controller.rendered();
  const calendar = h.add("calendar");
  h.controller.windowTracked(calendar.nodeValue);
  h.controller.restoreWindows();
  assert.deepEqual(h.location(calendar), [1, 2]);
  assert.equal(teams.parentNode, calendar.parentNode);
  assert.equal(teams.parentNode.layout, "TABBED");
  assert.deepEqual(h.errors, []);
});

test("tabs survive destruction of a source group rebuilt after the destination", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const node = h.add("teams", 1);
  const group = new h.context.Node("CON", new h.context.St.Bin());
  h.tree.findNode("mo1ws0").appendChild(group);
  group.appendChild(node);
  group.decoration.add_child(node.tab);
  h.controller.profile = h.saved("A", 0, "teams");
  h.controller.apply();
  assert.equal(group.decoration.destroyed, true);
  assert.equal(node.tab.destroyed, undefined);
  assert.deepEqual(h.location(node), [0, 0]);
});

test("partially reopened columns retain their original proportions when the remaining app opens", () => {
  const h = harness();
  h.activate(["A"]);
  const one = h.add("teams");
  h.controller.profile = h.saved("A", 0, "teams", "calendar");
  const saved = h.controller.profile.monitors[0].workspaces[0].tree;
  saved.layout = "HSPLIT";
  saved.children[0].percent = 0.7;
  saved.children[1].percent = 0.3;
  h.controller.apply();
  h.controller.rendered();
  const two = h.add("calendar");
  h.controller.windowTracked(two.nodeValue);
  h.controller.restoreWindows();
  assert.equal(one.parentNode, two.parentNode);
  assert.equal(one.percent, 0.7);
  assert.equal(two.percent, 0.3);
});

test("regular Edge windows share the last focused slot without accumulating containers", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const one = h.add("microsoft-edge", 0, 0);
  const two = h.add("microsoft-edge", 1, 1);
  h.wm.focusMetaWindow = two.nodeValue;
  h.controller.rendered();
  h.controller.apply();
  h.controller.rendered();
  const before = JSON.stringify(h.controller.profile);
  h.controller.apply();
  h.controller.rendered();
  assert.equal(JSON.stringify(h.controller.profile), before);
  assert.equal(one.parentNode, two.parentNode);
  assert.equal(one.parentNode.layout, "TABBED");
  assert.deepEqual(h.location(one), [1, 1]);
});

test("saved layouts reload across sessions including unopened apps", () => {
  const h = harness();
  h.activate(["A"]);
  h.controller.profile = h.saved("A", 2, "teams", "calendar");
  h.controller.rendered();
  h.controller.write();
  const restored = h.reload();
  assert.deepEqual(JSON.parse(JSON.stringify(restored.state)), JSON.parse(h.contents()));
});

test("stale display callbacks cannot apply after another change or disable", () => {
  const h = harness();
  h.activate(["A"]);
  let activated = 0;
  h.controller.activate = () => activated++;
  h.controller.refreshMonitors();
  h.controller.monitorsChanged();
  h.calls[0]({
    call_finish() {
      throw new Error("stale");
    },
  });
  h.controller.refreshMonitors();
  h.controller.disable();
  h.calls[1]({
    call_finish() {
      throw new Error("disabled");
    },
  });
  assert.equal(activated, 0);
  assert.deepEqual(h.errors, []);
  assert.equal(h.timers.size, 0);
});

test("an active drag defers restoration and protects the last stable profile", () => {
  const h = harness();
  h.activate(["A"]);
  h.add("teams");
  h.controller.rendered();
  const original = JSON.stringify(h.controller.state);
  h.wm.isDraggingWindow = true;
  h.controller.monitorsChanged();
  h.controller.activate([{ id: "B" }]);
  assert.equal(h.controller.key, '["A"]');
  h.controller.rendered();
  assert.equal(JSON.stringify(h.controller.state), original);
  assert.equal(h.controller.transitioning, true);
});
