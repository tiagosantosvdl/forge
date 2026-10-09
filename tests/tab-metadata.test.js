const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  class Signals {
    constructor(props = {}) {
      Object.assign(this, props);
      this.handlers = new Map();
      this.sequence = 0;
    }
    connect(name, callback) {
      const id = ++this.sequence;
      this.handlers.set(id, { name, callback });
      return id;
    }
    disconnect(id) {
      this.handlers.delete(id);
    }
    emit(name) {
      for (const [id, entry] of [...this.handlers])
        if (this.handlers.has(id) && entry.name === name) entry.callback(this);
    }
  }
  class Actor extends Signals {
    constructor(props = {}) {
      super(props);
      this.children = [];
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
    get_child_at_index(index) {
      return this.children[index];
    }
    add_child(child) {
      child.parent?.remove_child(child);
      child.parent = this;
      this.children.push(child);
    }
    remove_child(child) {
      this.children.splice(this.children.indexOf(child), 1);
      child.parent = null;
    }
    hide() {}
    add_style_class_name() {}
  }
  const desktop = new Map();
  const startup = new Map();
  const tracked = new Map();
  const tracker = Object.assign(new Signals(), { get_window_app: (window) => tracked.get(window) });
  const appSystem = Object.assign(new Signals(), {
    lookup_app: (id) => desktop.get(id),
    lookup_startup_wmclass: (id) => startup.get(id),
    lookup_desktop_wmclass: () => null,
  });
  const timers = new Map();
  const warnings = [];
  let source = 0;
  let scale = 1;
  const context = vm.createContext({
    GObject: { Object: class {}, registerClass() {} },
    GLib: {
      PRIORITY_DEFAULT: 0,
      SOURCE_REMOVE: false,
      timeout_add: (_, delay, callback) => {
        const id = ++source;
        timers.set(id, callback);
        return id;
      },
      Source: { remove: (id) => timers.delete(id) },
    },
    Gio: { FileMonitorFlags: { NONE: 0 } },
    Shell: {
      WindowTracker: { get_default: () => tracker },
      AppSystem: { get_default: () => appSystem },
    },
    St: { Bin: Actor, BoxLayout: Actor, Button: Actor, Icon: Actor },
    Logger: { warn: (message) => warnings.push(message), debug() {} },
    Utils: {
      dpi: () => scale,
      createEnum: (values) => Object.fromEntries(values.map((value) => [value, value])),
    },
    Window: { WINDOW_MODES: { DEFAULT: "DEFAULT", TILE: "TILE", GRAB_TILE: "GRAB_TILE" } },
    global: { window_group: new Actor(), display: { get_focus_window: () => null } },
  });
  for (const [file, exports] of [
    ["mutter-safe.js", "isWindowAlive, safeRaise, safeFocus, safeActivate"],
    ["tab-metadata.js", "resolveWindowApp, TabMetadata"],
    ["tree.js", "Node, Tree"],
    ["window.js", "WindowManager"],
  ]) {
    const code = fs
      .readFileSync(path.join(__dirname, "../lib/extension", file), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, "");
    vm.runInContext(`${code}\nObject.assign(globalThis, {${exports}});`, context);
  }
  const tree = Object.assign(Object.create(context.Tree.prototype), {
    _type: "ROOT",
    _nodes: [],
  });
  const wm = Object.assign(Object.create(context.WindowManager.prototype), {
    _tree: tree,
    renderTree: () => assert.fail("Tab updates must not render the layout"),
    layouts: { rendered: () => assert.fail("Tab updates must not capture layouts") },
  });
  const controller = new context.TabMetadata(wm);
  wm.tabMetadata = controller;
  const monitor = new context.Node("MONITOR", "mo0ws0");
  tree.appendChild(monitor);
  function app(icon, file) {
    const result = Object.assign(new Signals(), {
      icon,
      textures: 0,
      get_name: () => result.icon,
      get_icon: () => (file ? { get_file: () => file } : null),
      create_icon_texture: (size) => {
        result.textures++;
        return new Actor({ icon: result.icon, size });
      },
    });
    return result;
  }
  function window(id, associated = app("gear")) {
    const actor = new Actor();
    const meta = Object.assign(new Signals(), {
      id,
      title: id,
      alive: true,
      minimized: false,
      get_wm_class: () => meta.id,
      get_gtk_application_id: () => meta.gtkId,
      get_wm_class_instance: () => meta.instance,
      get_compositor_private: () => (meta.alive ? actor : null),
    });
    tracked.set(meta, associated);
    const node = new context.Node("WINDOW", meta);
    node.mode = "TILE";
    monitor.appendChild(node);
    if (controller.enabled) controller.watch(node);
    return { node, meta, actor };
  }
  function group(...nodes) {
    const node = new context.Node("CON", new Actor());
    node.layout = "TABBED";
    monitor.appendChild(node);
    for (const child of nodes) node.appendChild(child);
    return node;
  }
  function flush() {
    for (const [id, callback] of [...timers]) {
      timers.delete(id);
      callback();
    }
    assert.deepEqual(warnings, []);
  }
  return {
    app,
    window,
    group,
    flush,
    controller,
    tree,
    monitor,
    desktop,
    startup,
    tracked,
    tracker,
    appSystem,
    timers,
    context,
    wm,
    Signals,
    icon: (node) => node.tab.get_child_at_index(0).child.icon,
    title: (node) => node.tab.get_child_at_index(1).label,
    scale: (value) => {
      scale = value;
    },
  };
}

test("exact desktop IDs override wrong browser-app associations", () => {
  const h = harness();
  const edge = h.app("Edge"),
    teams = h.app("Teams"),
    outlook = h.app("Outlook"),
    whatsapp = h.app("WhatsApp");
  for (const [id, correct, wrong] of [
    ["msedge-teams-Default", teams, edge],
    ["msedge-whatsapp-Default", whatsapp, outlook],
    ["msedge-outlook-Default", outlook, teams],
  ]) {
    h.desktop.set(`${id}.desktop`, correct);
    assert.equal(h.icon(h.window(id, wrong).node), correct.icon);
  }
});

test("GTK application IDs and StartupWMClass identify apps without exact class IDs", () => {
  const h = harness();
  const native = h.app("Native"),
    pwa = h.app("PWA");
  const window = h.window("unknown");
  h.desktop.set("org.example.Native.desktop", native);
  window.meta.gtkId = "org.example.Native";
  h.controller.enable();
  h.flush();
  assert.equal(h.icon(window.node), "Native");
  window.meta.gtkId = null;
  window.meta.instance = "crx_app";
  h.startup.set("crx_app", pwa);
  window.meta.emit("notify::wm-class");
  h.flush();
  assert.equal(h.icon(window.node), "PWA");
});

test("late identity events replace a gear icon without retiling or changing shares", () => {
  const h = harness();
  const w = h.window("starting");
  w.node.percent = 0.7;
  h.controller.enable();
  h.flush();
  h.desktop.set("firefox-esr.desktop", h.app("Firefox"));
  w.meta.id = "firefox-esr";
  w.meta.title = "Firefox ready";
  w.meta.emit("notify::wm-class");
  w.meta.emit("notify::title");
  assert.equal(h.timers.size, 1);
  h.flush();
  assert.equal(h.icon(w.node), "Firefox");
  assert.equal(h.title(w.node), "Firefox ready");
  assert.equal(w.node.parentNode, h.monitor);
  assert.equal(w.node.percent, 0.7);
});

test("tracker reassociation refreshes icons even when the window ID does not change", () => {
  const h = harness();
  const w = h.window("unknown");
  h.controller.enable();
  h.flush();
  h.tracked.set(w.meta, h.app("Correct"));
  h.tracker.emit("tracked-windows-changed");
  h.flush();
  assert.equal(h.icon(w.node), "Correct");
});

test("notification titles refresh window and split member tabs during a drag", () => {
  const h = harness();
  const w = h.window("chat", h.app("Chat"));
  const inner = h.group(w.node),
    outer = h.group(inner);
  inner.layout = "HSPLIT";
  h.tree._updateConTab(inner);
  h.controller.enable();
  h.flush();
  const icon = w.node.tab.get_child_at_index(0).child;
  w.node.mode = "GRAB_TILE";
  h.wm._freezeRender = true;
  w.meta.title = "Chat (3 unread)";
  w.meta.emit("notify::title");
  h.flush();
  for (const node of [w.node, inner]) assert.equal(h.title(node), "Chat (3 unread)");
  assert.equal(outer.getNodeByLayout("TABBED").length, 1);
  assert.equal(w.node.tab.get_child_at_index(0).child, icon);
  assert.equal(w.node.mode, "GRAB_TILE");
  assert.equal(h.wm._freezeRender, true);
});

test("app icon changes refresh window and ancestor icons on the same app object", () => {
  const h = harness();
  const app = h.app("Original");
  const w = h.window("chat", app);
  const group = h.group(w.node);
  h.tree._updateConTab(group);
  h.controller.enable();
  h.flush();
  app.icon = "Updated";
  app.emit("notify::icon");
  h.flush();
  assert.equal(h.icon(w.node), "Updated");
  assert.equal(h.icon(group), "Updated");
});

test("a dragged member keeps its own group title, icon, and member count", () => {
  const h = harness();
  const chat = h.window("Chat", h.app("Chat"));
  const browser = h.window("Browser", h.app("Browser"));
  const group = h.group(chat.node, browser.node);
  group.lastMemberFocus = chat.meta;
  h.tree._updateConTab(group);
  h.controller.enable();
  h.flush();
  chat.node.mode = "GRAB_TILE";
  chat.meta.title = "Chat (2 unread)";
  chat.meta.emit("notify::title");
  h.flush();
  assert.equal(h.title(group), "Chat (2 unread) (+1)");
  assert.equal(h.icon(group), "Chat");
  assert.equal(h.tree.memberWindow(group), browser.node);
});

test("queued metadata follows the current node after the tree is rebuilt", () => {
  const h = harness();
  const w = h.window("app", h.app("App"));
  h.controller.enable();
  h.flush();
  const oldTitle = h.title(w.node);
  w.meta.title = "Reopened";
  w.meta.emit("notify::title");
  w.node.parentNode.removeChild(w.node);
  const replacement = new h.context.Node("WINDOW", w.meta);
  replacement.mode = "TILE";
  h.monitor.appendChild(replacement);
  h.controller.watch(replacement);
  h.flush();
  assert.equal(h.title(replacement), "Reopened");
  assert.equal(h.icon(replacement), "App");
  assert.equal(h.title(w.node), oldTitle);
  assert.equal(h.controller.windows.size, 1);
  assert.equal(w.meta.handlers.size, 5);
});

test("desktop updates replace the app and detach the previous app's callbacks", () => {
  const h = harness();
  const old = h.app("Old"),
    updated = h.app("Updated");
  h.desktop.set("app.desktop", old);
  const w = h.window("app");
  h.controller.enable();
  h.flush();
  h.desktop.set("app.desktop", updated);
  h.appSystem.emit("installed-changed");
  h.flush();
  assert.equal(h.icon(w.node), "Updated");
  assert.equal(old.handlers.size, 0);
  old.emit("notify::icon");
  assert.equal(h.timers.size, 0);
});

test("recreated group tabs get an icon even when app and member are unchanged", () => {
  const h = harness();
  const w = h.window("app", h.app("App"));
  const group = h.group(w.node);
  h.tree._updateConTab(group);
  group.tab = null;
  h.tree._updateConTab(group);
  assert.equal(h.icon(group), "App");
});

test("reshuffling and member focus keep each title and icon on the correct window", () => {
  const h = harness();
  const a = h.window("Teams", h.app("Teams")),
    b = h.window("Outlook", h.app("Outlook"));
  const group = h.group(a.node, b.node);
  group.lastMemberFocus = a.meta;
  h.tree._updateConTab(group);
  assert.match(h.title(group), /^Teams/);
  assert.equal(h.icon(group), "Teams");
  group.lastMemberFocus = b.meta;
  h.tree._updateConTab(group);
  assert.match(h.title(group), /^Outlook/);
  assert.equal(h.icon(group), "Outlook");
  const other = h.group();
  other.appendChild(b.node);
  h.tree._updateConTab(other);
  assert.equal(h.title(other), "Outlook");
  assert.equal(h.icon(other), "Outlook");
});

test("unknown apps still have tabs and recover when their identity becomes available", () => {
  const h = harness();
  const w = h.window("unknown", null);
  assert.equal(w.node.tab.get_child_at_index(0).child.icon_name, "application-x-executable");
  h.controller.enable();
  h.flush();
  h.tracked.set(w.meta, h.app("Ready"));
  h.tracker.emit("tracked-windows-changed");
  h.flush();
  assert.equal(h.icon(w.node), "Ready");
});

test("scale changes resize tab icons without replacing their app associations", () => {
  const h = harness();
  const w = h.window("app", h.app("App"));
  h.scale(2);
  w.node.render();
  assert.equal(w.node.tab.get_child_at_index(0).child.size, 48);
});

test("a closing window cancels pending updates and releases app and window subscriptions", () => {
  const h = harness();
  const app = h.app("App");
  const w = h.window("app", app);
  h.controller.enable();
  h.flush();
  w.meta.emit("notify::title");
  w.meta.alive = false;
  w.meta.emit("unmanaged");
  assert.equal(h.timers.size, 0);
  assert.equal(w.meta.handlers.size, 0);
  assert.equal(app.handlers.size, 0);
  h.flush();
  assert.equal(h.controller.windows.size, 0);
});

test("dead windows are ignored even when they close before an unmanaged signal", () => {
  const h = harness();
  const w = h.window("app");
  h.controller.enable();
  h.flush();
  w.meta.emit("notify::title");
  w.meta.alive = false;
  h.flush();
  assert.equal(h.controller.windows.size, 0);
  assert.equal(w.meta.handlers.size, 0);
});

test("disable disconnects global sources and cancels pending tab updates", () => {
  const h = harness();
  const w = h.window("app");
  h.controller.enable();
  h.flush();
  w.meta.emit("notify::title");
  h.controller.disable();
  assert.equal(h.timers.size, 0);
  assert.equal(h.tracker.handlers.size, 0);
  assert.equal(h.appSystem.handlers.size, 0);
  assert.equal(w.meta.handlers.size, 0);
  h.controller.enable();
  h.flush();
  assert.equal(h.controller.windows.size, 1);
});

test("absolute icon file changes refresh textures and cancel their monitor on close", () => {
  const h = harness();
  const monitor = Object.assign(new h.Signals(), {
    cancel() {
      this.cancelled = true;
    },
  });
  const file = {
    get_path: () => "/icons/app.png",
    get_uri: () => "file:///icons/app.png",
    monitor_file: () => monitor,
  };
  const app = h.app("Old file", file);
  const w = h.window("app", app);
  h.controller.enable();
  h.flush();
  app.icon = "New file";
  monitor.emit("changed");
  h.flush();
  assert.equal(h.icon(w.node), "New file");
  w.meta.emit("unmanaged");
  assert.equal(monitor.handlers.size, 0);
  assert.equal(monitor.cancelled, true);
});
