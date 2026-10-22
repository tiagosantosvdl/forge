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
    remove_all_children() {
      for (const child of [...this.children]) this.remove_child(child);
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
  const original = JSON.parse(JSON.stringify(h.controller.state.monitors));
  h.activate(["C"], 700);
  assert.deepEqual(h.location(teams), [0, 2]);
  assert.deepEqual(h.location(editor), [0, 1]);
  h.activate(["B", "A"]);
  assert.deepEqual(h.location(teams), [0, 2]);
  assert.deepEqual(h.location(calendar), [0, 2]);
  assert.equal(teams.parentNode, calendar.parentNode);
  assert.equal(teams.parentNode.layout, "TABBED");
  assert.deepEqual(h.location(editor), [1, 1]);
  const restored = JSON.parse(JSON.stringify(h.controller.state.monitors));
  for (const id of ["A", "B"]) assert.deepEqual(restored[id], original[id]);
});

test("display reconfiguration moves saved groups from unavailable workspaces to the last workspace", () => {
  const h = harness(2);
  h.activate(["A"]);
  const node = h.add("teams");
  h.controller.profile = h.saved("A", 7, "teams");
  h.controller.apply({ relocate: true });
  assert.deepEqual(h.location(node), [0, 1]);
  assert.equal(h.tree.nodeWindows.length, 1);
});

test("workspace removal renumbers saved slots in every monitor configuration", () => {
  const h = harness();
  h.activate(["A"]);
  h.controller.profile = h.saved("A", 2, "teams");
  h.controller.state.monitors.A = h.controller.profile.monitors[0];
  h.controller.state.monitors.B = h.saved("B", 2, "calendar").monitors[0];
  h.workspaces.pop();
  h.controller.workspaceRemoved(1);
  assert.equal(h.controller.profile.monitors[0].workspaces[0].index, 1);
  assert.equal(h.controller.state.monitors.B.workspaces[0].index, 1);
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
    restored.state.monitors.A.workspaces.find((ws) => ws.index === 0).tree.splitLayout,
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
        const node = h.add(key, 1);
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
  const teams = h.add("teams", 1, 2);
  h.controller.profile = h.saved("B", 2, "teams", "calendar");
  h.controller.apply();
  h.controller.rendered();
  const calendar = h.add("calendar", 1, 2);
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
  h.controller.apply({ relocate: true });
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

test("reopening a local tab preserves destination and unrelated monitor split sizes", () => {
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
  const opened = h.add("calendar", 1);
  h.controller.windowTracked(opened.nodeValue);
  // Window tracking resets the shares on the monitor where it opened.
  h.tree.resetSiblingPercent(group.parentNode);
  h.controller.restoreWindows();
  assert.equal(teams.parentNode, group);
  assert.equal(opened.parentNode, group);
  assert.equal(group.decoration.destroyed, undefined);
  assert.deepEqual([group.percent, browser.percent], [0.65, 0.35]);
  assert.deepEqual([editor.percent, terminal.percent], [0.7, 0.3]);
  assert.deepEqual(h.location(opened), [1, 0]);
  assert.deepEqual(h.errors, []);
});

test("monitor refresh preserves session sizing and newly saved files omit resize weights", () => {
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
  assert.deepEqual(Array.from(h.tree.computeSizes(one.parentNode, [one, two])), [1600, 400]);
});

test("new windows of an open app join its live slot without moving its siblings", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const browser = h.add("browser", 1);
  const editor = h.add("editor", 1);
  browser.percent = 0.6;
  editor.percent = 0.4;
  const monitor = browser.parentNode;
  const opened = h.add("browser", 1);
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  const group = browser.parentNode;
  assert.equal(group.layout, "TABBED");
  assert.equal(group.parentNode, monitor);
  assert.equal(editor.parentNode, monitor);
  assert.deepEqual([group.percent, editor.percent], [0.6, 0.4]);
  assert.equal(opened.parentNode, group);
  assert.deepEqual(h.location(opened), [1, 0]);
  const another = h.add("browser", 1);
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
  const right = h.add("right", 1, 2);
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
  const opened = h.add("bottom", 1, 2);
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  const group = opened.parentNode;
  assert.equal(group.layout, "VSPLIT");
  assert.deepEqual([...group.parentNode.childNodes], [group, right]);
  assert.deepEqual(h.location(opened), [1, 2]);
  const top = h.add("top", 1, 2);
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

test("regular Edge windows retain independent monitor and workspace slots", () => {
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
  assert.notEqual(one.parentNode, two.parentNode);
  assert.deepEqual(h.location(one), [0, 0]);
  assert.deepEqual(h.location(two), [1, 1]);
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

test("Terminal and Files restore one shared split tab without a Terminal-only inner group", () => {
  const h = harness();
  h.activate(["left", "right"]);
  const edge = h.add("edge", 1, 1);
  const firefox = h.add("firefox", 1, 1);
  h.controller.profile = {
    monitors: [
      {
        id: "right",
        workspaces: [
          {
            index: 1,
            tree: {
              layout: "TABBED",
              children: [
                { key: "edge" },
                {
                  layout: "HSPLIT",
                  children: [
                    { layout: "TABBED", children: [{ key: "terminal" }] },
                    { key: "files" },
                  ],
                },
                { key: "firefox" },
              ],
            },
          },
        ],
      },
    ],
  };
  h.controller.apply();
  const terminal = h.add("terminal", 1, 1);
  h.controller.windowTracked(terminal.nodeValue);
  h.controller.restoreWindows();
  const files = h.add("files", 1, 1);
  h.controller.windowTracked(files.nodeValue);
  h.controller.restoreWindows();
  const split = terminal.parentNode;
  assert.equal(split.layout, "HSPLIT");
  assert.equal(files.parentNode, split);
  assert.deepEqual([...split.childNodes], [terminal, files]);
  assert.equal(split.parentNode, edge.parentNode);
  assert.equal(firefox.parentNode, edge.parentNode);
  assert.equal(edge.parentNode.layout, "TABBED");
  assert.deepEqual(h.location(terminal), [1, 1]);
  assert.deepEqual(h.location(files), [1, 1]);
  h.controller.rendered();
  h.controller.write();
  const state = h.reload().state;
  const check = (node, grouped = false) => {
    const group = ["TABBED", "STACKED"].includes(node.layout);
    assert.ok(!group || !grouped);
    for (const child of node.children || []) check(child, grouped || group);
  };
  for (const monitor of Object.values(state.monitors))
    for (const workspace of monitor.workspaces) check(workspace.tree);
});

test("additional same-app windows inside a split tab join its outer group", () => {
  const h = harness();
  h.activate(["A"]);
  const browser = h.add("browser");
  const terminal = h.add("terminal");
  h.controller.profile = {
    monitors: [
      {
        id: "A",
        workspaces: [
          {
            index: 0,
            tree: {
              layout: "TABBED",
              children: [{ layout: "HSPLIT", children: [{ key: "browser" }, { key: "terminal" }] }],
            },
          },
        ],
      },
    ],
  };
  h.controller.apply();
  const outer = browser.groupAncestor();
  const reopened = h.add("browser");
  h.controller.windowTracked(reopened.nodeValue);
  h.controller.restoreWindows();
  assert.equal(reopened.parentNode, outer);
  assert.equal(browser.groupAncestor(), outer);
  assert.equal(terminal.groupAncestor(), outer);
  assert.equal(outer.getNodeByLayout("TABBED").length, 1);
  h.controller.apply();
  assert.equal(h.tree.getNodeByLayout("TABBED").length, 1);
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

for (const [monitor, workspace] of [
  [0, 0],
  [0, 1],
  [1, 0],
  [1, 2],
])
  test(`new windows use only history at monitor ${monitor}, workspace ${workspace}`, () => {
    const h = harness();
    h.activate(["A", "B"]);
    const remoteMonitor = 1 - monitor;
    const remoteWorkspace = (workspace + 1) % 3;
    const remote = h.add("browser", remoteMonitor, remoteWorkspace);
    h.wm.focusMetaWindow = remote.nodeValue;
    h.controller.profile = h.saved(remoteMonitor ? "B" : "A", remoteWorkspace, "browser", "editor");
    const opened = h.add("browser", monitor, workspace);
    const originalParent = opened.parentNode;
    opened.nodeValue.change_workspace = () => assert.fail("new window changed workspace");
    opened.nodeValue.move_to_monitor = () => assert.fail("new window changed monitor");
    h.controller.windowTracked(opened.nodeValue);
    h.controller.restoreWindows();
    assert.equal(opened.parentNode, originalParent);
    assert.deepEqual(h.location(opened), [monitor, workspace]);
    assert.notEqual(opened.parentNode, remote.parentNode);
    h.controller.apply();
    assert.deepEqual(h.location(opened), [monitor, workspace]);
    assert.deepEqual(h.location(remote), [remoteMonitor, remoteWorkspace]);
    assert.deepEqual(h.errors, []);
  });

test("a peer on another workspace of the same monitor cannot capture a new window", () => {
  const h = harness();
  h.activate(["A"]);
  const remote = h.add("browser", 0, 2);
  h.controller.profile = h.saved("A", 2, "browser");
  const opened = h.add("browser", 0, 0);
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  assert.notEqual(remote.parentNode, opened.parentNode);
  assert.deepEqual(h.location(opened), [0, 0]);
});

test("local history wins over the focused same-app window elsewhere", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const remote = h.add("browser", 0, 2);
  const editor = h.add("editor", 1, 1);
  h.controller.profile = h.saved("B", 1, "browser", "editor");
  h.controller.apply();
  h.wm.focusMetaWindow = remote.nodeValue;
  const opened = h.add("browser", 1, 1);
  h.controller.windowTracked(opened.nodeValue);
  h.controller.restoreWindows();
  assert.equal(opened.parentNode, editor.parentNode);
  assert.notEqual(opened.parentNode, remote.parentNode);
  assert.deepEqual(h.location(opened), [1, 1]);
});

test("saving and reloading retains the same app in every monitor and workspace", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const nodes = [];
  for (const monitor of [0, 1])
    for (const workspace of [0, 1, 2]) nodes.push(h.add("browser", monitor, workspace));
  h.wm.focusMetaWindow = nodes[0].nodeValue;
  h.controller.rendered();
  h.controller.write();
  const profile = h.reload().state;
  const keys = (node) => (node.key ? [node.key] : node.children.flatMap(keys));
  for (const monitor of Object.values(profile.monitors))
    for (const ws of monitor.workspaces) assert.deepEqual(Array.from(keys(ws.tree)), ["browser"]);
  h.controller.apply();
  for (let i = 0; i < nodes.length; i++)
    assert.deepEqual(h.location(nodes[i]), [Math.floor(i / 3), i % 3]);
});

test("initial restoration ignores history from a removed workspace", () => {
  const h = harness(2);
  h.activate(["A"]);
  const teams = h.add("teams", 0, 1);
  const editor = h.add("editor", 0, 1);
  h.controller.profile = h.saved("A", 7, "teams", "editor");
  h.controller.apply();
  assert.equal(teams.parentNode.nodeType, "MONITOR");
  assert.equal(editor.parentNode, teams.parentNode);
  assert.deepEqual(h.location(teams), [0, 1]);
});

test("adding and removing a third display retains survivor groups, actors and resize shares", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const edge = h.add("edge", 1);
  const firefox = h.add("firefox", 1);
  const editor = h.add("editor", 0);
  h.controller.profile = h.saved("B", 0, "edge", "firefox");
  h.controller.apply();
  const group = edge.parentNode;
  group.percent = 0.7;
  const parent = group.parentNode;
  h.controller.rendered();
  // Include an index reorder, as primary-monitor changes can renumber outputs.
  h.activate(["C", "B", "A"]);
  assert.equal(edge.parentNode, group);
  assert.equal(group.parentNode, parent);
  assert.equal(group.percent, 0.7);
  assert.deepEqual(h.location(editor), [2, 0]);
  h.activate(["A", "B"]);
  assert.equal(edge.parentNode, group);
  assert.equal(firefox.parentNode, group);
  assert.equal(group.parentNode, parent);
  assert.equal(group.percent, 0.7);
  assert.deepEqual(h.location(editor), [0, 0]);
});

test("undocking and docking use each display's own saved groups and workspaces", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const teams = h.add("teams", 1);
  const outlook = h.add("outlook", 1);
  const editor = h.add("editor", 0);
  h.controller.profile = {
    monitors: [
      ...h.saved("A", 0, "editor").monitors,
      ...h.saved("B", 0, "teams", "outlook").monitors,
    ],
  };
  h.controller.apply();
  h.controller.rendered();
  h.controller.state.monitors.laptop = h.saved(
    "laptop",
    1,
    "teams",
    "outlook",
    "editor"
  ).monitors[0];
  h.activate(["laptop"]);
  assert.deepEqual(h.location(teams), [0, 1]);
  assert.deepEqual(h.location(editor), [0, 1]);
  assert.equal(teams.parentNode, outlook.parentNode);
  assert.equal(teams.parentNode, editor.parentNode);
  assert.equal(teams.parentNode.layout, "TABBED");
  h.activate(["B", "A"]);
  assert.deepEqual(h.location(teams), [0, 0]);
  assert.deepEqual(h.location(outlook), [0, 0]);
  assert.deepEqual(h.location(editor), [1, 0]);
  assert.equal(teams.parentNode, outlook.parentNode);
  assert.equal(teams.parentNode.layout, "TABBED");
});

test("displaced windows use saved slots without stealing same-app windows on surviving displays", () => {
  const h = harness();
  h.activate(["A", "B", "C"]);
  const local = h.add("browser", 1);
  const displaced = h.add("browser", 2);
  const mail = h.add("mail", 2);
  h.controller.profile = {
    monitors: [
      ...h.saved("A", 1, "browser", "mail").monitors,
      ...h.saved("B", 0, "browser").monitors,
      ...h.saved("C", 0, "browser", "mail").monitors,
    ],
  };
  h.controller.apply();
  h.controller.rendered();
  const originalParent = local.parentNode;
  h.activate(["A", "B"]);
  assert.deepEqual(h.location(local), [1, 0]);
  assert.equal(local.parentNode, originalParent);
  assert.deepEqual(h.location(displaced), [1, 0]); // Existing matching group takes precedence.
  assert.deepEqual(h.location(mail), [0, 1]);
  assert.equal(displaced.parentNode, local.parentNode);
});

test("unmatched displaced windows balance by tiled count, then area, without persisting fallback slots", () => {
  const h = harness();
  h.activate(["A", "B", "C"]);
  h.add("editor", 0);
  const one = h.add("one", 2);
  const two = h.add("two", 2);
  h.controller.rendered();
  const original = JSON.stringify(h.controller.state.monitors.C);
  h.activate(["A", "B"]);
  assert.deepEqual(h.location(one), [1, 0]);
  assert.deepEqual(h.location(two), [0, 0]);
  assert.equal(JSON.stringify(h.controller.state.monitors.C), original);
  const keys = (tree) => (tree.key ? [tree.key] : tree.children.flatMap(keys));
  for (const id of ["A", "B"])
    for (const ws of h.controller.state.monitors[id].workspaces)
      assert.ok(!keys(ws.tree).some((key) => ["one", "two"].includes(key)));
  h.activate(["C", "A", "B"]);
  assert.deepEqual(h.location(one), [0, 0]);
  assert.deepEqual(h.location(two), [0, 0]);
  assert.equal(h.controller.temporaryWindows.size, 0);
});

test("per-monitor state reloads without saving monitor-set snapshots", () => {
  const h = harness();
  h.activate(["A", "B"]);
  h.add("browser", 1);
  h.controller.rendered();
  h.controller.write();
  const state = JSON.parse(h.contents());
  assert.equal(state.version, 2);
  assert.equal(state.configurations, undefined);
  assert.ok(state.monitors.B);
  assert.deepEqual(JSON.parse(JSON.stringify(h.reload().state)), state);
});

test("a deliberate tree move releases a fallback window from its original monitor", () => {
  const h = harness();
  h.activate(["A", "B", "C"]);
  h.add("editor", 0);
  const window = h.add("browser", 2);
  h.controller.rendered();
  h.activate(["A", "B"]);
  assert.deepEqual(h.location(window), [1, 0]);
  window.nodeValue.move_to_monitor(0);
  h.tree.findNode("mo0ws0").appendChild(window);
  h.controller.rendered();
  assert.equal(h.controller.fallbackHomes.has(window.nodeValue), false);
  h.activate(["A", "B", "C"]);
  assert.deepEqual(h.location(window), [0, 0]);
});

test("equal tiled counts send an unmatched displaced window to the larger monitor", () => {
  const h = harness();
  h.activate(["A", "B", "C"]);
  const node = h.add("unknown", 2);
  h.controller.rendered();
  h.controller.activate([
    { id: "A", index: 0, primary: true, x: 0, y: 0, width: 1000, height: 1200 },
    { id: "B", index: 1, x: 1000, y: 0, width: 2500, height: 1200 },
  ]);
  assert.deepEqual(h.location(node), [1, 0]);
});

test("late launch placement reparents through the production monitor handler before joining the local group", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const editor = h.add("editor", 0);
  const teams = h.add("teams", 1);
  h.controller.profile = h.saved("B", 0, "teams", "outlook");
  h.controller.apply();
  const group = teams.parentNode;
  const outlook = h.add("outlook", 0);
  h.wm.layouts = h.controller;
  h.wm.launchPlacement = {
    waitingForIdentity: () => false,
    place(window) {
      window.move_to_monitor(1);
      return true;
    },
  };
  h.wm._validWindow = () => true;
  h.wm.isActiveWindowWorkspaceTiled = () => false;
  h.wm.floatingWindow = () => false;
  vm.runInContext(
    fs
      .readFileSync(path.join(__dirname, "../lib/extension/window.js"), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, ""),
    h.context
  );
  h.wm.updateMetaWorkspaceMonitor = vm.runInContext(
    "WindowManager.prototype.updateMetaWorkspaceMonitor",
    h.context
  );
  h.controller.windowTracked(outlook.nodeValue);
  h.controller.restoreWindows();
  assert.deepEqual(h.location(outlook), [1, 0]);
  assert.equal(outlook.parentNode, group);
  assert.equal(teams.parentNode, group);
  assert.equal(group.layout, "TABBED");
  assert.deepEqual(h.location(editor), [0, 0]);
  assert.deepEqual(h.errors, []);
});

for (const direction of ["HSPLIT", "VSPLIT"])
  for (const layout of ["TABBED", "STACKED"])
    for (const partial of [false, true])
      for (const first of ["edge", "teams", "outlook"])
        test(`${direction} ${layout} ${first}-first restoration partitions ${
          partial ? "partly pending" : "batched"
        } auto-splits`, () => {
          const h = harness();
          h.activate(["A", "B"]);
          const keys = ["edge", "firefox", "teams", "whatsapp", "outlook"];
          const expected = {
            layout: direction,
            children: [
              { layout, children: keys.slice(0, 2).map((key) => ({ key })) },
              { layout, children: keys.slice(2).map((key) => ({ key })) },
            ],
          };
          h.controller.profile = {
            monitors: [{ id: "B", workspaces: [{ index: 0, tree: expected }] }],
          };
          h.tree.findNode("mo1ws0").layout = direction;
          const nodes = [];
          const order = [first, ...keys.filter((key) => key !== first)];
          for (const key of order) {
            const previous = nodes.at(-1);
            if (previous)
              h.tree.split(previous, direction === "HSPLIT" ? "HORIZONTAL" : "VERTICAL");
            const node = h.add(key, 1);
            if (previous) h.tree.attachNode.appendChild(node);
            nodes.push(node);
            h.controller.windowTracked(node.nodeValue);
          }
          const byKey = new Map(nodes.map((node) => [node.nodeValue.get_wm_class(), node]));
          if (partial)
            for (const key of ["teams", "whatsapp"].filter((key) => key !== first))
              h.controller.pendingWindows.delete(byKey.get(key).nodeValue);
          h.controller.cancel("restoreSource");
          h.controller.restoreWindows();
          assert.deepEqual(h.errors, []);
          const browsers = byKey.get("edge").parentNode;
          const messages = byKey.get("teams").parentNode;
          assert.notEqual(browsers, messages);
          assert.equal(browsers.layout, layout);
          assert.equal(messages.layout, layout);
          assert.deepEqual(
            [...browsers.childNodes],
            keys.slice(0, 2).map((key) => byKey.get(key))
          );
          assert.deepEqual(
            [...messages.childNodes],
            keys.slice(2).map((key) => byKey.get(key))
          );
          assert.deepEqual([...h.tree.findNode("mo1ws0").childNodes], [browsers, messages]);
          h.controller.write();
          const saved = h.reload().state.monitors.B.workspaces.find((ws) => ws.index === 0).tree;
          assert.deepEqual(JSON.parse(JSON.stringify(saved)), expected);
        });

test("partitioning a mixed auto-split preserves foreign windows, unrelated groups, actors and shares", () => {
  const h = harness();
  h.activate(["A", "B"]);
  const editor = h.add("editor", 0);
  const terminal = h.add("terminal", 0);
  editor.percent = 0.7;
  terminal.percent = 0.3;
  const monitor = h.tree.findNode("mo1ws0");
  const unrelated = new h.context.Node("CON", new h.context.St.Bin());
  unrelated.settings = h.tree.settings;
  unrelated.layout = "TABBED";
  unrelated.percent = 0.35;
  monitor.appendChild(unrelated);
  const left = h.add("unrelated1", 1);
  const right = h.add("unrelated2", 1);
  unrelated.appendChild(left);
  unrelated.appendChild(right);
  const expected = {
    layout: "HSPLIT",
    children: [
      { layout: "TABBED", children: [{ key: "edge" }, { key: "firefox" }] },
      { layout: "TABBED", children: [{ key: "teams" }, { key: "outlook" }] },
      { layout: "TABBED", children: [{ key: "unrelated1" }, { key: "unrelated2" }] },
    ],
  };
  h.controller.profile = { monitors: [{ id: "B", workspaces: [{ index: 0, tree: expected }] }] };
  const nodes = [];
  for (const key of ["edge", "firefox", "utility1", "utility2", "teams", "outlook"]) {
    const previous = nodes.at(-1);
    if (previous) h.tree.split(previous, "HORIZONTAL");
    const node = h.add(key, 1);
    if (previous) h.tree.attachNode.appendChild(node);
    nodes.push(node);
    if (key !== "utility1" && key !== "utility2") h.controller.windowTracked(node.nodeValue);
  }
  const utilityParent = nodes[2].parentNode;
  h.controller.cancel("restoreSource");
  h.controller.restoreWindows();
  assert.deepEqual(h.errors, []);
  assert.equal(nodes[0].parentNode, nodes[1].parentNode);
  assert.equal(nodes[4].parentNode, nodes[5].parentNode);
  assert.notEqual(nodes[0].parentNode, nodes[4].parentNode);
  assert.equal(nodes[2].parentNode, utilityParent);
  assert.equal(utilityParent.actor.destroyed, undefined);
  assert.equal(nodes[2].groupAncestor(), null);
  assert.equal(nodes[3].groupAncestor(), null);
  assert.equal(left.parentNode, unrelated);
  assert.equal(right.parentNode, unrelated);
  assert.equal(unrelated.actor.destroyed, undefined);
  assert.equal(unrelated.decoration.destroyed, undefined);
  assert.equal(unrelated.percent, 0.35);
  assert.deepEqual([editor.percent, terminal.percent], [0.7, 0.3]);
  for (const node of nodes) assert.equal(node.tab.destroyed, undefined);
});

test("a floating window with a saved group key is not adopted during restoration", () => {
  const h = harness();
  h.activate(["A"]);
  const floating = h.add("firefox");
  floating.mode = "FLOAT";
  const original = floating.parentNode;
  h.controller.profile = h.saved("A", 0, "edge", "firefox");
  const edge = h.add("edge");
  h.controller.windowTracked(edge.nodeValue);
  h.controller.cancel("restoreSource");
  h.controller.restoreWindows();
  assert.deepEqual(h.errors, []);
  assert.equal(floating.parentNode, original);
  assert.notEqual(edge.parentNode, original);
  assert.equal(edge.parentNode.layout, "TABBED");
  assert.equal(floating.tab.destroyed, undefined);
});
