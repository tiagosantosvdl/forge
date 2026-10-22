const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  let time = 1000000;
  let current = 1;
  let enabled = true;
  const contexts = [];
  const calls = [];
  class App {
    constructor(id, windows = 0) {
      this.id = id;
      this.windows = windows;
    }
    get_id() {
      return this.id;
    }
    get_n_windows() {
      return this.windows;
    }
    activate(...args) {
      calls.push([this.id, ...args]);
      return "activated";
    }
    activate_full(...args) {
      return this.activate(...args);
    }
    open_new_window(...args) {
      calls.push([this.id, ...args]);
      return "opened";
    }
    launch() {
      return this.result ?? true;
    }
    launch_action() {}
  }
  class InjectionManager {
    constructor() {
      this.saved = [];
    }
    overrideMethod(object, name, wrapper) {
      const original = object[name];
      this.saved.push([object, name, original]);
      object[name] = wrapper(original);
    }
    clear() {
      for (const [object, name, method] of this.saved) object[name] = method;
    }
  }
  const global = {
    display: { get_current_monitor: () => current },
    create_app_launch_context(...args) {
      const callbacks = new Map();
      const context = {
        args,
        connect(name, callback) {
          callbacks.set(name, callback);
          return name;
        },
        disconnect(name) {
          callbacks.delete(name);
        },
        start(app) {
          callbacks.get("launch-started")?.(context, app);
        },
        callbacks,
      };
      contexts.push(context);
      return context;
    },
  };
  const context = vm.createContext({
    Shell: {
      App,
      WindowTracker: { get_default: () => ({ get_window_app: (window) => window.app }) },
    },
    Meta: { WindowType: { NORMAL: 0 } },
    GLib: { get_monotonic_time: () => time },
    Logger: { debug() {} },
    InjectionManager,
    global,
  });
  vm.runInContext(
    fs
      .readFileSync(path.join(__dirname, "../lib/extension/launch-placement.js"), "utf8")
      .replace(/^import .*;\n/gm, "")
      .replace(/^export /gm, "") + "\nglobalThis.Placement = LaunchPlacement;",
    context
  );
  const wm = {
    ext: { settings: { get_boolean: () => enabled } },
    layouts: {
      monitors: [
        { id: "left", index: 0 },
        { id: "right", index: 1 },
      ],
    },
  };
  const placement = new context.Placement(wm);
  const original = App.prototype.open_new_window;
  placement.enable();
  function window(app, monitor = 0, options = {}) {
    const moves = [];
    return {
      app,
      moves,
      get_window_type: () => options.type || 0,
      get_transient_for: () => options.transient || null,
      get_monitor: () => monitor,
      move_to_monitor(index) {
        moves.push(index);
        monitor = index;
      },
    };
  }
  return {
    App,
    placement,
    wm,
    global,
    window,
    calls,
    contexts,
    original,
    time: (delta) => (time += delta),
    monitor: (index) => (current = index),
    enabled: (value) => (enabled = value),
  };
}

for (const method of ["activate", "activate_full", "open_new_window", "launch", "launch_action"])
  test(`${method} captures the launch monitor before focus or pointer changes`, () => {
    const h = harness();
    const app = new h.App("browser.desktop");
    app[method](123);
    h.monitor(0);
    const window = h.window(app);
    h.placement.windowCreated(window);
    assert.deepEqual(window.moves, [1]);
    assert.equal(h.placement.requests.length, 0);
  });

test("a new Edge app window can reuse an existing process without moving other apps", () => {
  const h = harness();
  const outlook = new h.App("outlook.desktop", 1);
  outlook.open_new_window();
  const unrelated = h.window(new h.App("firefox.desktop"));
  h.placement.windowCreated(unrelated);
  assert.deepEqual(unrelated.moves, []);
  const window = h.window(outlook);
  h.placement.windowCreated(window);
  assert.deepEqual(window.moves, [1]);
  assert.equal(h.placement.place(window), true);
  assert.equal(h.placement.place(window), false);
});

test("delayed app identity is retried using the captured monitor", () => {
  const h = harness();
  const app = new h.App("outlook.desktop");
  app.open_new_window();
  const window = h.window(null);
  h.placement.windowCreated(window);
  assert.equal(h.placement.waitingForIdentity(window), true);
  h.monitor(0);
  h.time(500000);
  window.app = app;
  assert.equal(h.placement.place(window), true);
  assert.deepEqual(window.moves, [1]);
});

test("activating an existing window does not reserve a monitor for a later background window", () => {
  const h = harness();
  const app = new h.App("browser.desktop", 2);
  app.activate_full();
  const window = h.window(app);
  h.placement.windowCreated(window);
  assert.deepEqual(window.moves, []);
});

test("DesktopAppInfo launches use the monitor where the launch context was created", () => {
  const h = harness();
  const app = new h.App("outlook.desktop");
  const context = h.global.create_app_launch_context(123, 0);
  assert.deepEqual(context.args, [123, 0]);
  h.monitor(0);
  context.start(app);
  const window = h.window(app);
  h.placement.windowCreated(window);
  assert.deepEqual(window.moves, [1]);
  assert.equal(context.callbacks.size, 0);
});

test("transients and splash windows do not consume an app's launch request", () => {
  const h = harness();
  const app = new h.App("browser.desktop");
  app.launch();
  for (const options of [{ type: 4 }, { transient: {} }]) {
    const window = h.window(app, 0, options);
    h.placement.windowCreated(window);
    assert.deepEqual(window.moves, []);
  }
  const normal = h.window(app);
  h.placement.windowCreated(normal);
  assert.deepEqual(normal.moves, [1]);
});

test("expired, failed, and disconnected-display launches do not move later windows", () => {
  for (const reason of ["expired", "failed", "disconnected"]) {
    const h = harness();
    const app = new h.App("browser.desktop");
    if (reason === "failed") app.result = false;
    app.launch();
    if (reason === "expired") h.time(16000000);
    if (reason === "disconnected") h.wm.layouts.monitors.pop();
    const window = h.window(app);
    h.placement.windowCreated(window);
    assert.deepEqual(window.moves, [], reason);
  }
});

test("disable restores launch methods and disconnects pending contexts", () => {
  const h = harness();
  const context = h.global.create_app_launch_context();
  h.placement.disable();
  assert.equal(h.App.prototype.open_new_window, h.original);
  assert.equal(context.callbacks.size, 0);
  assert.equal(h.placement.requests.length, 0);
});

test("launch tracking is inactive when tiling is off or monitors are changing", () => {
  for (const disabled of ["tiling", "transition"]) {
    const h = harness();
    if (disabled === "tiling") h.enabled(false);
    else h.wm.layouts.transitioning = true;
    new h.App("browser.desktop").launch();
    assert.equal(h.placement.requests.length, 0);
  }
});

test("a compositor placement after creation is corrected before final group restoration", () => {
  const h = harness();
  const app = new h.App("outlook.desktop");
  app.open_new_window();
  const window = h.window(app);
  h.placement.windowCreated(window);
  window.move_to_monitor(0); // The application/compositor applies initial geometry later.
  h.monitor(0);
  assert.equal(h.placement.place(window), true);
  assert.deepEqual(window.moves, [1, 0, 1]);
  assert.equal(h.placement.place(window), false);
});

test("two immediate launches of the same app retain separate requests", () => {
  const h = harness();
  const app = new h.App("browser.desktop");
  app.open_new_window();
  h.monitor(0);
  app.open_new_window();
  const first = h.window(app, 0);
  const second = h.window(app, 1);
  h.placement.windowCreated(first);
  h.placement.windowCreated(second);
  assert.deepEqual(first.moves, [1]);
  assert.deepEqual(second.moves, [0]);
});
