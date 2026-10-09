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
    set_size(width, height) {
      this.width = width;
      this.height = height;
    }
    set_position(x, y) {
      this.x = x;
      this.y = y;
    }
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
    Utils: {
      createEnum: (names) => Object.fromEntries(names.map((name) => [name, name])),
      orientationFromLayout: (layout) => (layout === "HSPLIT" ? "HORIZONTAL" : "VERTICAL"),
    },
    Window: {
      WINDOW_MODES: { TILE: "TILE", FLOAT: "FLOAT", GRAB_TILE: "GRAB_TILE", DEFAULT: "DEFAULT" },
    },
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
    calculateGaps: () => 0,
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
      percent: 0,
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

for (const direction of ["HSPLIT", "VSPLIT"])
  for (const first of ["firefox", "edge", "whatsapp", "teams", "outlook"])
    test(`partially reopened ${direction} groups retain their structure when ${first} opens first`, () => {
      const h = harness();
      h.activate(["A", "B"]);
      const keys = ["firefox", "edge", "whatsapp", "teams", "outlook"];
      const expected = {
        layout: direction,
        children: [
          { layout: "TABBED", children: keys.slice(0, 2).map((key) => ({ key })) },
          { layout: "TABBED", children: keys.slice(2).map((key) => ({ key })) },
        ],
      };
      h.controller.profile = {
        monitors: [{ id: "B", workspaces: [{ index: 0, tree: expected }] }],
      };
      const order = [first, ...keys.filter((key) => key !== first)];
      const opened = new Map([[first, h.add(first, 1)]]);
      h.controller.apply();
      h.controller.rendered();
      const saved = () =>
        JSON.parse(
          JSON.stringify(
            h.controller.profile.monitors
              .find((m) => m.id === "B")
              .workspaces.find((ws) => ws.index === 0).tree
          )
        );
      assert.deepEqual(saved(), expected);
      for (const key of order.slice(1)) {
        const node = h.add(key, 0);
        opened.set(key, node);
        h.controller.windowTracked(node.nodeValue);
        h.controller.cancel("restoreSource");
        h.controller.restoreWindows();
        assert.deepEqual(saved(), expected);
      }
      const left = opened.get("firefox").parentNode;
      const right = opened.get("teams").parentNode;
      assert.notEqual(left, right);
      assert.equal(left, opened.get("edge").parentNode);
      assert.equal(right, opened.get("whatsapp").parentNode);
      assert.equal(right, opened.get("outlook").parentNode);
      assert.equal(left.parentNode, right.parentNode);
      assert.equal(left.parentNode.layout, direction);
      assert.deepEqual([...left.parentNode.childNodes], [left, right]);
      h.controller.write();
      const reloaded = h.reload();
      assert.deepEqual(JSON.parse(JSON.stringify(reloaded.state)), JSON.parse(h.contents()));
      assert.deepEqual(h.errors, []);
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

test("partially reopened columns use equal shares when the remaining app opens", () => {
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
  one.parentNode.rect = { x: 0, y: 0, width: 2000, height: 1000 };
  assert.deepEqual(Array.from(h.tree.computeSizes(one.parentNode, [one, two])), [1000, 1000]);
});

test("opening on another monitor preserves live groups and session sizes despite stale saved weights", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const left = h.add("left", 1);
  const right = h.add("right", 1);
  h.controller.profile = h.saved("B", 0, "left", "right");
  const saved = h.controller.profile.monitors[0].workspaces[0].tree;
  saved.layout = "HSPLIT";
  saved.children[0].percent = 0.5;
  saved.children[1].percent = 0.17647058823529413;
  h.controller.apply();
  const monitor = left.parentNode;
  left.percent = 0.6;
  right.percent = 0.4;
  monitor.rect = { x: 2500, y: 0, width: 2000, height: 1000 };
  const opened = h.add("new-app", 0);
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  assert.equal(left.parentNode, monitor);
  assert.equal(right.parentNode, monitor);
  assert.deepEqual([left.percent, right.percent], [0.6, 0.4]);
  assert.deepEqual(Array.from(h.tree.computeSizes(monitor, [left, right])), [1200, 800]);
  assert.deepEqual(h.location(opened), [0, 0]);
  assert.deepEqual(h.errors, []);
});

test("reopening a tab preserves both destination and provisional source split sizes", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const editor = h.add("editor");
  const terminal = h.add("terminal");
  const teams = h.add("teams", 1);
  const browser = h.add("browser", 1);
  const tabbed = { layout: "TABBED", children: [{ key: "teams" }, { key: "calendar" }] };
  h.controller.profile = {
    monitors: [
      ...h.saved("A", 0, "editor", "terminal").monitors,
      {
        id: "B",
        workspaces: [
          { index: 0, tree: { layout: "HSPLIT", children: [tabbed, { key: "browser" }] } },
        ],
      },
    ],
  };
  h.controller.profile.monitors[0].workspaces[0].tree.layout = "HSPLIT";
  h.controller.apply();
  const source = editor.parentNode;
  const group = teams.parentNode;
  editor.percent = 0.7;
  terminal.percent = 0.3;
  group.percent = 0.65;
  browser.percent = 0.35;
  const opened = h.add("calendar");
  h.controller.windowTracked(opened.nodeValue);
  // trackWindow clears the provisional parent's shares after notifying Layouts.
  h.tree.resetSiblingPercent(source);
  h.controller.restoreWindows();
  assert.equal(teams.parentNode, group);
  assert.equal(opened.parentNode, group);
  assert.equal(group.decoration.destroyed, undefined);
  assert.deepEqual([group.percent, browser.percent], [0.65, 0.35]);
  assert.deepEqual([editor.percent, terminal.percent], [0.7, 0.3]);
  assert.deepEqual(h.location(opened), [1, 0]);
  assert.deepEqual(h.errors, []);
});

test("full restoration resets session sizing and newly saved files omit resize weights", () => {
  const h = harness();
  h.activate(["A"]);
  const one = h.add("one");
  const two = h.add("two");
  one.percent = 0.8;
  two.percent = 0.2;
  h.controller.rendered();
  h.controller.write();
  assert.equal(h.contents().includes('"percent"'), false);
  assert.deepEqual([one.percent, two.percent], [0.8, 0.2]);
  h.activate(["A"]);
  one.parentNode.rect = { x: 0, y: 0, width: 2000, height: 1000 };
  assert.deepEqual(Array.from(h.tree.computeSizes(one.parentNode, [one, two])), [1000, 1000]);
});

test("new windows of an open app join its live slot without moving its siblings", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const browser = h.add("browser", 1);
  const editor = h.add("editor", 1);
  browser.percent = 0.6;
  editor.percent = 0.4;
  const monitor = browser.parentNode;
  const opened = h.add("browser");
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  const group = browser.parentNode;
  assert.equal(group.layout, "TABBED");
  assert.equal(group.parentNode, monitor);
  assert.equal(editor.parentNode, monitor);
  assert.deepEqual([group.percent, editor.percent], [0.6, 0.4]);
  assert.equal(opened.parentNode, group);
  assert.deepEqual(h.location(opened), [1, 0]);
  const another = h.add("browser");
  h.controller.windowTracked(another.nodeValue);
  h.controller.restoreWindows();
  assert.equal(another.parentNode, group);
  assert.equal(group.childNodes.length, 3);
  assert.deepEqual(h.errors, []);
});

test("adding another window of the same app preserves resized columns on its monitor", () => {
  const h = harness();
  h.activate(["A"]);
  const browser = h.add("browser");
  const editor = h.add("editor");
  browser.percent = 0.6;
  editor.percent = 0.4;
  const monitor = browser.parentNode;
  const opened = h.add("browser");
  h.controller.windowTracked(opened.nodeValue);
  h.tree.resetSiblingPercent(monitor);
  h.controller.restoreWindows();
  assert.equal(opened.parentNode, browser.parentNode);
  assert.deepEqual([browser.parentNode.percent, editor.percent], [0.6, 0.4]);
  assert.deepEqual(h.errors, []);
});

test("reopening an empty nested group retains saved direction and sibling order", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const right = h.add("right", 1);
  h.controller.profile = {
    monitors: [
      {
        id: "B",
        workspaces: [
          {
            index: 2,
            tree: {
              layout: "HSPLIT",
              children: [
                { layout: "VSPLIT", children: [{ key: "top" }, { key: "bottom" }] },
                { key: "right" },
              ],
            },
          },
        ],
      },
    ],
  };
  h.controller.apply();
  const opened = h.add("bottom");
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  const group = opened.parentNode;
  assert.equal(group.layout, "VSPLIT");
  assert.deepEqual([...group.parentNode.childNodes], [group, right]);
  assert.deepEqual(h.location(opened), [1, 2]);
  const top = h.add("top");
  h.controller.windowTracked(top.nodeValue);
  h.controller.restoreWindows();
  assert.equal(top.parentNode, group);
  assert.deepEqual([...group.childNodes], [top, opened]);
  assert.deepEqual(h.errors, []);
});

test("apps reopening into a split collapsed for a small display stay in its tabs", () => {
  const h = harness();
  h.activate(["A"], 500);
  const one = h.add("one");
  const two = h.add("two");
  h.controller.profile = h.saved("A", 0, "one", "two", "three");
  h.controller.profile.monitors[0].workspaces[0].tree.layout = "HSPLIT";
  h.controller.apply();
  const group = one.parentNode;
  assert.equal(group.layout, "TABBED");
  const three = h.add("three");
  h.controller.windowTracked(three.nodeValue);
  h.controller.restoreWindows();
  assert.equal(three.parentNode, group);
  assert.equal(one.parentNode, group);
  assert.equal(two.parentNode, group);
  assert.deepEqual(h.errors, []);
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
