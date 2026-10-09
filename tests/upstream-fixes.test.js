const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Actual extension classes, with desktop timing, files and actors controlled by each test.
// FORGE_SOURCE_ROOT allows the same regressions to be run against the pre-fix snapshot.
function harness() {
  class Actor {
    constructor(props = {}) {
      Object.assign(this, props);
      this.children = [];
      this.visible = false;
    }
    get_name() {
      if (this.destroyed) throw Error("finalized actor");
      return "actor";
    }
    contains(child) {
      return this.children.includes(child);
    }
    get_parent() {
      return this.parent;
    }
    get_children() {
      return [...this.children];
    }
    get_child_at_index(index) {
      return this.children[index];
    }
    add_child(child) {
      child.parent?.remove_child(child);
      this.children.push(child);
      child.parent = this;
    }
    remove_child(child) {
      this.children.splice(this.children.indexOf(child), 1);
      child.parent = null;
    }
    remove_all_children() {
      for (const child of [...this.children]) this.remove_child(child);
    }
    destroy_all_children() {
      for (const child of [...this.children]) child.destroy();
    }
    destroy() {
      this.destroyed = true;
      this.destroy_all_children();
      this.parent?.remove_child(this);
    }
    connect(_, fn) {
      this.onClick = fn;
      return 1;
    }
    hide() {
      this.visible = false;
    }
    show() {
      this.visible = true;
    }
    set_size(width, height) {
      this.width = width;
      this.height = height;
    }
    set_position(x, y) {
      this.x = x;
      this.y = y;
    }
    set_height(height) {
      this.height = height;
    }
    remove_all_transitions() {}
    add_style_class_name() {}
    remove_style_class_name() {}
    set_style_class_name() {}
    insert_child_above(child, below) {
      this.add_child(child);
      this.children.splice(this.children.indexOf(child), 1);
      this.children.splice(this.children.indexOf(below) + 1, 0, child);
    }
  }
  const files = new Map();
  const directories = new Set(["/user/forge/config"]);
  const warnings = [];
  const copies = [];
  let closed = 0;
  const file = (name) => ({
    get_path: () => name,
    equal: (other) => name === other.get_path(),
    query_exists: () => files.has(name) || directories.has(name),
    make_directory_with_parents: () => {
      directories.add(name);
      return true;
    },
    get_parent: () => file(path.dirname(name)),
    load_contents: () => [true, new TextEncoder().encode(files.get(name))],
    create: () => {
      files.set(name, "");
      return {
        write_all: (data) => files.set(name, data),
        close: () => closed++,
      };
    },
    copy: (target, flags) => {
      copies.push([name, target.get_path(), flags]);
      files.set(target.get_path(), files.get(name));
      return true;
    },
    replace_contents: (data) => {
      files.set(name, data);
      return [true, "etag"];
    },
  });
  const timers = new Map();
  let next = 0;
  let now = 1000000;
  const booleans = new Map();
  const settings = {
    get_boolean: (name) =>
      booleans.get(name) ??
      ["tiling-mode-enabled", "showtab-decoration-enabled", "auto-exit-tabbed"].includes(name),
    get_uint: () => 0,
    get_string: () => "",
    set_uint() {},
  };
  let focus = null;
  const activeWorkspace = {
    index: () => 0,
    get_work_area_for_monitor: () => ({ x: 0, y: 0, width: 2000, height: 1000 }),
  };
  const workspaceManager = {
    get_active_workspace: () => activeWorkspace,
    get_active_workspace_index: () => 0,
  };
  const context = vm.createContext({
    TextDecoder,
    console: { warn: (value) => warnings.push(value) },
    GObject: { Object: class {}, registerClass() {} },
    Logger: { debug() {}, trace() {}, error() {} },
    Gio: {
      File: { new_for_path: file },
      FileCreateFlags: { NONE: 0, REPLACE_DESTINATION: 1 },
      FileCopyFlags: { OVERWRITE: 1, TARGET_DEFAULT_PERMS: 2 },
    },
    GLib: {
      get_user_config_dir: () => "/user",
      build_filenamev: (parts) => parts.join("/"),
      get_monotonic_time: () => now,
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      SOURCE_CONTINUE: true,
      timeout_add: (_, delay, fn) => {
        const id = ++next;
        timers.set(id, fn);
        return id;
      },
      Source: { remove: (id) => timers.delete(id) },
    },
    St: { Bin: Actor, BoxLayout: Actor, Button: Actor, Side: { TOP: 0, BOTTOM: 1 } },
    Clutter: { Orientation: { VERTICAL: 1, HORIZONTAL: 0 } },
    Meta: {
      MotionDirection: { LEFT: "LEFT", RIGHT: "RIGHT", UP: "UP", DOWN: "DOWN" },
      GrabOp: { WINDOW_BASE: 1 },
      MaximizeFlags: { BOTH: 3 },
    },
    Utils: {
      createEnum: (names) => Object.fromEntries(names.map((name) => [name, name])),
      dpi: () => 1,
      monitorIndex: (name) => Number(name.match(/^mo(\d+)/)[1]),
      orientationFromLayout: (layout) => (layout === "HSPLIT" ? "HORIZONTAL" : "VERTICAL"),
      directionFromGrab: (grab) => grab,
      orientationFromGrab: (grab) => (["LEFT", "RIGHT"].includes(grab) ? "HORIZONTAL" : "VERTICAL"),
      resolveDirection: (direction) => direction.toUpperCase(),
      positionFromDirection: (direction) =>
        ["RIGHT", "DOWN"].includes(direction) ? "AFTER" : "BEFORE",
      removeGapOnRect: (rect) => ({ ...rect }),
      rectContainsPoint: (rect, point) =>
        point[0] >= rect.x &&
        point[0] <= rect.x + rect.width &&
        point[1] >= rect.y &&
        point[1] <= rect.y + rect.height,
      grabMode: () => "RESIZING",
    },
    Window: {
      WINDOW_MODES: { TILE: "TILE", FLOAT: "FLOAT", GRAB_TILE: "GRAB_TILE", DEFAULT: "DEFAULT" },
    },
    imports: { byteArray: { toString: (bytes) => new TextDecoder().decode(bytes) } },
    global: {
      window_group: new Actor(),
      workspace_manager: workspaceManager,
      display: {
        get_focus_window: () => focus,
        get_current_monitor: () => 0,
        get_current_time: () => 1,
        get_workspace_manager: () => workspaceManager,
        get_n_monitors: () => 1,
      },
    },
  });
  const root = process.env.FORGE_SOURCE_ROOT || path.join(__dirname, "..");
  function load(name, exports) {
    const sourcePath =
      name === "lib/css/index.js" ? path.join(__dirname, "..", name) : path.join(root, name);
    const source = fs
      .readFileSync(sourcePath, "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, "");
    vm.runInContext(`${source}\nObject.assign(globalThis, {${exports}});`, context);
  }
  if (fs.existsSync(path.join(root, "lib/extension/mutter-safe.js")))
    load("lib/extension/mutter-safe.js", "isWindowAlive, safeRaise, safeFocus, safeActivate");
  load("lib/css/index.js", "parse, stringify");
  load("lib/shared/settings.js", "ConfigManager");
  load("lib/shared/theme.js", "ThemeManagerBase");
  load("lib/extension/tree.js", "Node, Tree, LAYOUT_TYPES, NODE_TYPES");
  load("lib/extension/window.js", "WindowManager");
  const wm = Object.create(context.WindowManager.prototype);
  Object.assign(wm, {
    ext: { settings },
    determineSplitLayout: () => "HSPLIT",
    bindWorkspaceSignals() {},
    calculateGaps: () => 0,
    floatingWindow: (node) => node.isFloat(),
    updateBorderLayout() {},
    updateDecorationLayout() {},
    queueEvent() {},
  });
  const tree = Object.assign(Object.create(context.Tree.prototype), {
    _type: "ROOT",
    _nodes: [],
    _data: new Actor(),
    _extWm: wm,
    settings,
    defaultStackHeight: 35,
  });
  wm._tree = tree;
  function group(layout = "HSPLIT", type = "CON", value = new Actor()) {
    const node = new context.Node(type, value);
    node.settings = settings;
    node.layout = layout;
    return node;
  }
  function window(title = "app", rect = { x: 0, y: 0, width: 500, height: 500 }) {
    let alive = true;
    const actor = new Actor();
    const calls = [];
    const meta = {
      title,
      minimized: false,
      get_title: () => title,
      get_wm_class: () => title,
      get_id: () => title,
      get_workspace: () => activeWorkspace,
      get_monitor: () => 0,
      located_on_workspace: (workspace) => workspace === activeWorkspace,
      appears_focused: true,
      get_frame_rect: () => ({ ...rect }),
      get_compositor_private: () => (alive ? actor : null),
      get_min_size: () => [true, 100, 100],
      client_rect_to_frame_rect: (rect) => rect,
      set_unmaximize_flags() {},
      unmaximize() {},
      is_fullscreen: () => false,
      is_maximized: () => false,
      raise: () => calls.push("raise"),
      focus: () => calls.push("focus"),
      activate: () => calls.push("activate"),
      move_frame: (...args) => calls.push(["move", ...args]),
      move_resize_frame: (...args) => calls.push(["resize", ...args]),
    };
    const node = Object.assign(Object.create(context.Node.prototype), {
      _type: "WINDOW",
      _data: meta,
      _nodes: [],
      _actor: actor,
      tab: new Actor(),
      mode: "TILE",
      settings,
      percent: 0,
    });
    node._rect = { ...rect };
    return {
      node,
      meta,
      calls,
      rect,
      actor,
      die: () => {
        alive = false;
      },
    };
  }
  function monitor() {
    const node = group("HSPLIT", "MONITOR", "mo0ws0");
    node.actorBin = new Actor();
    tree.appendChild(node);
    return node;
  }
  const config = new context.ConfigManager({ dir: { get_path: () => "/extension" } });
  files.set("/extension/config/windows.json", '{"overrides":[]}');
  return {
    context,
    wm,
    tree,
    settings,
    booleans,
    group,
    window,
    monitor,
    focus: (meta) => (focus = meta),
    files,
    file,
    config,
    copies,
    warnings,
    closed: () => closed,
    timers,
    tick: (ms) => {
      now += ms * 1000;
      for (const [id, fn] of [...timers]) if (!fn()) timers.delete(id);
    },
  };
}

for (const layout of ["HSPLIT", "VSPLIT"])
  for (const sameParent of [true, false])
    for (const groupLayout of ["TABBED", "STACKED"])
      test(`center drop in ${layout} creates ${groupLayout} with only the hovered window (${
        sameParent ? "same container" : "another monitor"
      })`, () => {
        const h = harness();
        const monitor = h.monitor();
        const split = h.group(layout);
        split.rect = { x: 2000, y: 0, width: 2000, height: 1000 };
        monitor.appendChild(split);
        const windows = Array.from({ length: 5 }, (_, index) =>
          h.window(`window${index}`, {
            x: 2000 + (layout === "HSPLIT" ? index * 400 : 0),
            y: layout === "VSPLIT" ? index * 200 : 0,
            width: layout === "HSPLIT" ? 400 : 2000,
            height: layout === "VSPLIT" ? 200 : 1000,
          })
        );
        for (const window of windows) split.appendChild(window.node);
        const dragged = sameParent ? windows[0] : h.window("from other monitor");
        if (!sameParent) {
          const sourceMonitor = h.group("HSPLIT", "MONITOR", "mo1ws0");
          h.tree.appendChild(sourceMonitor);
          sourceMonitor.appendChild(dragged.node);
        }
        const hovered = windows[2];
        dragged.node.mode = "GRAB_TILE";
        dragged.node.previewHint = new h.context.St.Bin();
        h.wm.nodeWinAtPointer = hovered.node;
        h.wm.getPointer = () => [
          hovered.rect.x + hovered.rect.width / 2,
          hovered.rect.y + hovered.rect.height / 2,
        ];
        h.settings.get_string = () => groupLayout.toLowerCase();
        h.booleans.set("preview-hint-enabled", true);

        h.wm.moveWindowToPointer(dragged.node, true);
        const hint = dragged.node.previewHint;
        assert.deepEqual(
          { x: hint.x, y: hint.y, width: hint.width, height: hint.height },
          hovered.rect
        );
        assert.equal(split.layout, layout);
        assert.equal(split.childNodes.length, 5);

        h.wm.moveWindowToPointer(dragged.node);
        const group = hovered.node.parentNode;
        assert.notEqual(group, split);
        assert.equal(group.layout, groupLayout);
        assert.equal(group.parentNode, split);
        assert.deepEqual([...group.childNodes], [hovered.node, dragged.node]);
        assert.equal(split.layout, layout);
        const expected = windows
          .filter((window) => !sameParent || window !== dragged)
          .map((window) => (window === hovered ? group : window.node));
        assert.deepEqual([...split.childNodes], expected);
      });

test("#541: containers accept a null rectangle until their first render", () => {
  const h = harness();
  const node = h.group();
  assert.doesNotThrow(() => {
    node.rect = null;
  });
  assert.equal(node.rect, null);
});

test("#516: detaching returns the node and clears its former parent", () => {
  const h = harness();
  const parent = h.group();
  const { node } = h.window();
  parent.appendChild(node);
  assert.equal(parent.removeChild(node), node);
  assert.equal(node.parentNode, null);
});

test("#572: removing a workspace renumbers its successors and their monitor IDs", () => {
  const h = harness();
  for (let index = 0; index < 3; index++) {
    const ws = h.group("HSPLIT", "WORKSPACE", `ws${index}`);
    ws.actorBin = new h.context.St.Bin();
    h.tree.appendChild(ws);
    ws.appendChild(h.group("HSPLIT", "MONITOR", `mo0ws${index}`));
  }
  const third = h.tree.findNode("ws2");
  h.tree.removeWorkspace(1);
  assert.equal(h.tree.findNode("ws1"), third);
  assert.equal(third.childNodes[0].nodeValue, "mo0ws1");
});

test("#557: moving a tabbed group preserves its decoration and living tabs", () => {
  const h = harness();
  const source = h.group();
  const target = h.group();
  const tabs = h.group("TABBED");
  const { node } = h.window();
  tabs.appendChild(node);
  tabs.decoration.add_child(node.tab);
  source.appendChild(tabs);
  target.appendChild(tabs);
  assert.ok(tabs.decoration);
  assert.equal(tabs.decoration.destroyed, undefined);
  assert.equal(node.tab.destroyed, undefined);
});

test("#557: deleting a group destroys its decoration while detaching surviving foreign tabs", () => {
  const h = harness();
  const monitor = h.monitor();
  const tabs = h.group("HSPLIT");
  monitor.appendChild(tabs);
  const own = h.window("own");
  tabs.appendChild(own.node);
  const foreign = h.window("foreign");
  monitor.appendChild(foreign.node);
  const ownTab = own.node.tab;
  tabs.decoration.add_child(ownTab);
  tabs.decoration.add_child(foreign.node.tab);
  h.tree.removeNode(own.node);
  assert.equal(ownTab.destroyed, true);
  assert.equal(tabs.decoration, null);
  assert.equal(foreign.node.tab.destroyed, undefined);
  assert.equal(foreign.node.tab.get_parent(), null);
});

test("#567: leaving tabbed and stacked modes restores the original split direction", () => {
  const h = harness();
  const node = h.group("VSPLIT");
  for (const layout of ["TABBED", "STACKED"]) {
    node.layout = layout;
    node.restoreSplitLayout("HSPLIT");
    assert.equal(node.layout, "VSPLIT");
  }
});

test("#527: split toggle exits a tabbed layout", () => {
  const h = harness();
  const parent = h.group("TABBED");
  const w = h.window();
  parent.appendChild(w.node);
  h.tree.appendChild(parent);
  h.focus(w.meta);
  h.wm.renderTree = () => {};
  h.wm.command({ name: "LayoutToggle" });
  assert.equal(parent.layout, "HSPLIT");
});

test("#536: a missing config file is created and closed when its directory already exists", () => {
  const h = harness();
  const file = h.config.windowConfigFile;
  assert.equal(file.get_path(), "/user/forge/config/windows.json");
  assert.equal(h.closed(), 1);
  assert.equal(h.files.get(file.get_path()), '{"overrides":[]}');
});

for (const text of ["", "broken", '{"overrides":null}'])
  test(`#579: invalid window configuration (${JSON.stringify(text)}) falls back safely`, () => {
    const h = harness();
    h.files.set("/user/forge/config/windows.json", text);
    assert.equal(h.config.windowProps.overrides.length, 0);
    if (text) assert.equal(h.files.get("/user/forge/config/windows.json.bak"), text);
  });

test("#584: an unreadable source never deletes the existing stylesheet", () => {
  const h = harness();
  h.context.Gio.IOErrorEnum = { PERMISSION_DENIED: 1 };
  h.context.Gio.FileQueryInfoFlags = { NONE: 0 };
  const theme = Object.create(h.context.ThemeManagerBase.prototype);
  const failure = Object.assign(new Error("Permission denied"), { matches: () => true });
  const source = {
    copy: () => {
      throw failure;
    },
    query_info: () => ({ get_attribute_boolean: () => false }),
  };
  let deleted = false;
  const target = {
    query_exists: () => true,
    query_info: () => ({ get_attribute_boolean: () => false }),
    delete: () => {
      deleted = true;
    },
  };
  assert.throws(() => theme._copyFile(source, target), /Permission denied/);
  assert.equal(deleted, false);
});

test("#583: CSS lookups tolerate comments and missing rules", () => {
  const h = harness();
  const theme = Object.create(h.context.ThemeManagerBase.prototype);
  theme.cssAst = h.context.parse("/* comment */ .other { color: red; }");
  assert.doesNotThrow(() => theme.getCssProperty(".tabbed", "color"));
  assert.equal(Object.keys(theme.getCssProperty(".tabbed", "color")).length, 0);
});

test("#583: incomplete stylesheets retain custom colours and gain defaults with a backup", () => {
  const h = harness();
  h.files.set("/extension/stylesheet.css", ".tabbed { color: blue; border-width: 3px; }");
  const original = "/* mine */ .tabbed { color: red; }";
  h.files.set("/user/forge/stylesheet/forge/stylesheet.css", original);
  const theme = Object.create(h.context.ThemeManagerBase.prototype);
  theme.configMgr = h.config;
  theme._importCss();
  assert.equal(theme.getCssProperty(".tabbed", "color").value, "red");
  assert.equal(theme.getCssProperty(".tabbed", "border-width").value, "3px");
  assert.equal(h.files.get("/user/forge/stylesheet/forge/stylesheet.css.bak"), original);
});

test("#584: stylesheet updates back up beside the source and use default permissions", () => {
  const h = harness();
  h.files.set("/extension/stylesheet.css", ".tabbed { color: blue; }");
  h.files.set("/user/forge/stylesheet/forge/stylesheet.css", ".tabbed { color: red; }");
  const theme = Object.create(h.context.ThemeManagerBase.prototype);
  theme.configMgr = h.config;
  theme.settings = h.settings;
  theme._needUpdate = () => true;
  assert.equal(theme.patchCss(), true);
  assert.equal(h.copies[0][1], "/user/forge/stylesheet/forge/stylesheet.css.bak");
  assert.ok(h.copies.every((copy) => copy[2] & h.context.Gio.FileCopyFlags.TARGET_DEFAULT_PERMS));
});

test("#573: two windows of the same app can each have their own float rule", () => {
  const h = harness();
  let props = { overrides: [] };
  h.wm.ext.configMgr = {
    get windowProps() {
      return props;
    },
    set windowProps(value) {
      props = value;
    },
  };
  const first = h.window("edge-1");
  const second = h.window("edge-2");
  first.meta.get_wm_class = second.meta.get_wm_class = () => "microsoft-edge";
  h.wm.addFloatOverride(first.meta, true);
  h.wm.addFloatOverride(second.meta, true);
  assert.equal(props.overrides.length, 2);
  h.wm.removeFloatOverride(first.meta, true);
  assert.equal(props.overrides.length, 1);
  assert.equal(props.overrides[0].wmId, "edge-2");
});

test("#550: floating keyboard resize moves the requested top or bottom edge", () => {
  const h = harness();
  const w = h.window("float", { x: 0, y: 100, width: 500, height: 400 });
  w.node.mode = "FLOAT";
  h.tree.appendChild(w.node);
  h.focus(w.meta);
  const frames = [];
  h.wm.move = (_, rect) => frames.push(rect);
  h.wm.resize("UP", 20);
  h.wm.resize("DOWN", 20);
  assert.equal(frames[0].y, 80);
  assert.equal(frames[0].height, 420);
  assert.equal(frames[1].y, 100);
  assert.equal(frames[1].height, 420);
});

test("#550: keyboard resizing an empty workspace is harmless", () => {
  const h = harness();
  assert.doesNotThrow(() => h.wm.resize("UP", 20));
});

test("#551: frame movement sends one combined request", () => {
  const h = harness();
  const w = h.window();
  h.wm.move(w.meta, w.rect);
  assert.equal(w.calls.length, 1);
  assert.equal(w.calls[0][0], "resize");
});

test("#554: splits respect minimum sizes, normalize shares and conserve every pixel", () => {
  const h = harness();
  const monitor = h.monitor();
  monitor._rect = { width: 1000, height: 500 };
  const first = h.window("first");
  const second = h.window("second");
  first.node.percent = 0.1;
  second.node.percent = 0.3;
  first.meta.get_min_size = () => [true, 400, 100];
  monitor.appendChild(first.node);
  monitor.appendChild(second.node);
  const sizes = Array.from(h.tree.computeSizes(monitor, monitor.childNodes));
  assert.ok(sizes[0] >= 400);
  assert.equal(
    sizes.reduce((sum, size) => sum + size),
    1000
  );
  assert.equal(first.node.percent, 0.1);
});

test("#553: a resize stops when its neighbour reaches its minimum", () => {
  const h = harness();
  const first = h.window("first");
  const second = h.window("second");
  second.meta.get_min_size = () => [true, 300, 100];
  assert.deepEqual(
    Array.from(h.wm._resizePairSizes(first.node, 500, second.node, 500, 950, "HORIZONTAL")),
    [700, 300]
  );
});

test("#556: repeated keyboard resizing updates layout shares immediately without fake grabs", () => {
  const h = harness();
  const monitor = h.monitor();
  const first = h.window("first");
  const second = h.window("second");
  monitor.appendChild(first.node);
  monitor.appendChild(second.node);
  h.tree.processNode(monitor);
  h.focus(first.meta);
  for (let i = 0; i < 3; i++) h.wm.resize("RIGHT", 20);
  assert.equal(first.node.rect.width, 1060);
  assert.equal(second.node.rect.width, 940);
  assert.equal(h.wm.grabOp, undefined);
  assert.equal(h.wm._liveResizeSrcId, undefined);
  h.wm.resize("RIGHT", 2000);
  assert.equal(second.node.rect.width, 100);
});

test("#555: resizing an outer edge of a nested split leaves its inner sibling unchanged", () => {
  const h = harness();
  const monitor = h.monitor();
  const split = h.group("HSPLIT");
  const neighbour = h.window("neighbour");
  const first = h.window("first");
  const sibling = h.window("sibling");
  monitor.appendChild(neighbour.node);
  monitor.appendChild(split);
  split.appendChild(first.node);
  split.appendChild(sibling.node);
  h.tree.processNode(monitor);
  const previous = sibling.node.rect.width;
  h.focus(first.meta);
  h.wm.resize("LEFT", 20);
  assert.equal(first.node.rect.width, 520);
  assert.equal(sibling.node.rect.width, previous);
  assert.equal(neighbour.node.rect.width, 980);
});

test("#568/#553: stacked title lists contribute all header rows to minimum height", () => {
  const h = harness();
  const stack = h.group("STACKED");
  stack.appendChild(h.window("first").node);
  stack.appendChild(h.window("second").node);
  assert.equal(h.tree.minSizeOf(stack, "VERTICAL"), 170);
});

test("#562: any tab resizes the outer group's edge against its actual neighbour", () => {
  const h = harness();
  const monitor = h.monitor();
  const tabs = h.group("TABBED");
  const first = h.window("first");
  const last = h.window("last");
  const next = h.window("next");
  monitor.appendChild(tabs);
  tabs.appendChild(first.node);
  tabs.appendChild(last.node);
  monitor.appendChild(next.node);
  assert.deepEqual(Array.from(h.wm._resizePairFor(last.node, "RIGHT")), [tabs, next.node]);
});

test("#558: live resize requests affect only changed neighbours in the resized subtree", () => {
  const h = harness();
  const monitor = h.monitor();
  const group = h.group();
  monitor.appendChild(group);
  const drag = h.window("drag");
  const neighbour = h.window("neighbour");
  const other = h.window("other");
  group.appendChild(drag.node);
  group.appendChild(neighbour.node);
  monitor.appendChild(other.node);
  neighbour.node.renderRect = neighbour.rect;
  other.node.renderRect = other.rect;
  h.tree.processNode = () => {};
  h.wm._liveResizeNeighbors(drag.node, new Set([group]));
  h.wm._liveResizeNeighbors(drag.node, new Set([group]));
  assert.equal(neighbour.calls.length, 1);
  assert.equal(other.calls.length, 0);
});

test("#569: entering a group returns to its last-used live window", () => {
  const h = harness();
  const tabs = h.group("TABBED");
  const first = h.window("first");
  const last = h.window("last");
  tabs.appendChild(first.node);
  tabs.appendChild(last.node);
  tabs.lastTabFocus = last.meta;
  assert.equal(h.tree._entryWindow(tabs, false), last.node);
  last.meta.minimized = true;
  assert.equal(h.tree._entryWindow(tabs, false), first.node);
});

test("#571: a split inside tabs has its own clickable tab and raises its whole visible member", () => {
  const h = harness();
  const monitor = h.monitor();
  const tabs = h.group("TABBED");
  const split = h.group("HSPLIT");
  monitor.appendChild(tabs);
  tabs.appendChild(split);
  const first = h.window("first");
  const last = h.window("last");
  split.appendChild(first.node);
  split.appendChild(last.node);
  h.tree._updateConTab(split);
  assert.ok(split.tab);
  assert.match(split.tab.get_child_at_index(1).label, /\(\+1\)/);
  h.wm._raiseGroupMembers(first.node);
  assert.ok(last.calls.includes("raise"));
  assert.equal(first.calls.at(-1), "raise");
});

test("#570: a growing window waits for its shrinking neighbour to vacate the destination", () => {
  const h = harness();
  const monitor = h.monitor();
  const growing = h.window("growing", { x: 0, y: 0, width: 500, height: 500 });
  const shrinking = h.window("shrinking", { x: 500, y: 0, width: 500, height: 500 });
  monitor.appendChild(growing.node);
  monitor.appendChild(shrinking.node);
  h.wm._rememberRequest(growing.meta, growing.rect);
  h.wm._rememberRequest(shrinking.meta, shrinking.rect);
  h.wm.moveAll([
    [growing.meta, { x: 0, y: 0, width: 700, height: 500 }],
    [shrinking.meta, { x: 700, y: 0, width: 300, height: 500 }],
  ]);
  assert.equal(growing.calls.length, 0);
  assert.equal(shrinking.calls.length, 1);
  shrinking.rect.x = 700;
  shrinking.rect.width = 300;
  h.tick(16);
  assert.equal(growing.calls.length, 1);
  assert.equal(h.wm._queuedMoves.size, 0);
});

test("#570 integration: queued movement cannot retile windows after a drag begins", () => {
  const h = harness();
  const monitor = h.monitor();
  const w = h.window();
  monitor.appendChild(w.node);
  h.wm._queuedMoves = new Map([[w.meta, { rect: w.rect }]]);
  w.node.mode = "GRAB_TILE";
  h.wm._flushMoves();
  assert.equal(w.calls.length, 0);
  assert.equal(h.wm._queuedMoves.size, 0);
});

test("#520: unmanaged or finalized windows are not raised or focused", () => {
  const h = harness();
  const w = h.window();
  w.die();
  assert.equal(h.context.safeRaise(w.meta), false);
  assert.equal(h.context.safeFocus(w.meta, 1), false);
  const finalized = {
    get_compositor_private() {
      throw Error("finalized");
    },
  };
  assert.equal(h.context.isWindowAlive(finalized), false);
  assert.equal(w.calls.length, 0);
});

test("#575: a window from another workspace cannot leave a focus border on the current one", () => {
  const h = harness();
  const monitor = h.monitor();
  const w = h.window();
  monitor.appendChild(w.node);
  h.focus(w.meta);
  h.booleans.set("focus-border-toggle", true);
  w.actor.border = new h.context.St.Bin();
  w.meta.located_on_workspace = () => false;
  h.wm.calculateGaps = () => 8;
  h.wm.showWindowBorders();
  assert.equal(w.actor.border.visible, false);
});

test("#574: a single tile shows its split hint above the focus border", () => {
  const h = harness();
  const monitor = h.monitor();
  const w = h.window();
  monitor.appendChild(w.node);
  h.focus(w.meta);
  h.booleans.set("focus-border-toggle", true);
  h.booleans.set("split-border-toggle", true);
  w.actor.border = new h.context.St.Bin();
  h.context.global.window_group.add_child(w.actor);
  h.context.global.window_group.add_child(w.actor.border);
  h.wm.calculateGaps = () => 8;
  h.wm.showWindowBorders();
  assert.ok(w.actor.splitBorder);
  assert.equal(w.actor.splitBorder.visible, true);
  const order = h.context.global.window_group.children;
  assert.ok(order.indexOf(w.actor.splitBorder) > order.indexOf(w.actor.border));
});

test("#524: a workspace move updates tabbed focus when no grab is active", () => {
  const h = harness();
  const monitor = h.monitor();
  const other = h.group();
  const w = h.window();
  h.tree.appendChild(other);
  other.appendChild(w.node);
  h.wm._validWindow = () => true;
  h.wm.updateStackedFocus = () => {};
  h.wm.renderTree = () => {};
  let calls = 0;
  h.wm.updateTabbedFocus = () => calls++;
  h.wm.updateMetaWorkspaceMonitor("workspace-change", 0, w.meta);
  assert.equal(w.node.parentNode, monitor);
  assert.equal(calls, 1);
});

test("#582: disable disconnects settings and the actor of a window no longer listed", () => {
  const h = harness();
  const calls = [];
  h.context.global.workspace_manager.get_n_workspaces = () => 0;
  Object.defineProperty(h.wm, "windowsAllWorkspaces", { get: () => [] });
  const actor = new h.context.St.Bin();
  actor.actorSignals = [8];
  actor.disconnect = (id) => calls.push(id);
  h.wm._signalsBound = true;
  h.wm._settingsChangedId = 7;
  h.wm._settings = { disconnect: (id) => calls.push(id) };
  h.wm._windowActors = new Set([actor]);
  h.wm._removeSignals();
  assert.deepEqual(calls, [7, 8]);
  assert.equal(h.wm._windowActors.size, 0);
  assert.equal(h.wm._signalsBound, false);
});
