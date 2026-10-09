const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load(context, file) {
  vm.runInContext(
    fs
      .readFileSync(path.join(__dirname, "../lib", file), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, ""),
    context
  );
}

const comparison = vm.createContext({});
load(comparison, "shared/shortcut-conflicts.js");
const record = (source, key, accelerators) => ({ source, key, label: key, accelerators });

test("accelerators compare modifier aliases, order and letter case", () => {
  assert.equal(
    comparison.canonicalAccelerator("<Primary><Super>L"),
    comparison.canonicalAccelerator("<Mod4><Control>l")
  );
  assert.equal(
    comparison.canonicalAccelerator("<Ctrl><Alt>."),
    comparison.canonicalAccelerator("<Alt><Ctl>period")
  );
  assert.notEqual(
    comparison.canonicalAccelerator("<Super>l"),
    comparison.canonicalAccelerator("<Shift><Super>l")
  );
  assert.equal(comparison.canonicalAccelerator("disabled"), null);
  assert.equal(comparison.canonicalAccelerator(""), null);
});

test("conflicts include GNOME, custom shortcuts and other Forge actions but exclude the owner", () => {
  const records = [
    record("forge", "focus-right", ["<Super>l"]),
    record("gnome", "Lock screen", ["<Super>L"]),
    record("custom", "My launcher", ["<Control><Super>l"]),
    record("forge", "swap-right", ["<Primary><Super>l"]),
  ];
  const conflicts = comparison.findShortcutConflicts(["<Super>l", "<Ctrl><Super>l"], records, {
    source: "forge",
    key: "focus-right",
  });
  assert.deepEqual(
    Array.from(conflicts, ({ key }) => key),
    ["Lock screen", "My launcher", "swap-right"]
  );
});

test("repeating an accelerator under an alias is a duplicate", () => {
  const conflicts = comparison.findShortcutConflicts(["<Ctrl>h", "<Primary>H"], [], {
    source: "forge",
    key: "focus",
  });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, "duplicate");
});

function runtimeHarness() {
  const values = new Map([
    ["window-focus-right", ["<Alt><Super>l"]],
    ["window-focus-left", ["<Alt><Super>h"]],
    ["prefs-open", []],
  ]);
  let system = [];
  let changed;
  let systemChanged;
  let nextId = 1;
  const idles = new Map();
  const registered = new Set();
  const notifications = [];
  const failures = new Set();
  const attempts = [];
  const context = vm.createContext({
    GObject: { Object: class {}, registerClass() {} },
    GLib: {
      PRIORITY_DEFAULT_IDLE: 0,
      SOURCE_REMOVE: false,
      idle_add(_priority, callback) {
        const id = nextId++;
        idles.set(id, callback);
        return id;
      },
      Source: {
        remove(id) {
          idles.delete(id);
        },
      },
    },
    Meta: { KeyBindingFlags: { NONE: 0 }, KeyBindingAction: { NONE: 0 } },
    Shell: { ActionMode: { NORMAL: 1 } },
    Main: {
      wm: {
        addKeybinding(key) {
          attempts.push(key);
          if (failures.has(key)) return 0;
          if (registered.has(key)) throw Error("duplicate registration");
          registered.add(key);
          return 1;
        },
        removeKeybinding(key) {
          registered.delete(key);
        },
      },
      notify(title, body) {
        notifications.push({ title, body });
      },
    },
    Logger: { debug() {}, error() {} },
    _: (text) => text,
    shortcutRecords() {
      return Array.from(values, ([key, accelerators]) => record("forge", key, accelerators));
    },
    SystemShortcuts: class {
      records() {
        return system;
      }
      watch(callback) {
        systemChanged = callback;
      }
      destroy() {
        systemChanged = null;
      }
    },
  });
  load(context, "shared/shortcut-conflicts.js");
  load(context, "extension/keybindings.js");
  const settings = {
    connect(_name, callback) {
      changed = callback;
      return 1;
    },
    disconnect() {
      changed = null;
    },
  };
  const instance = vm.runInContext("Keybindings", context);
  const bindings = new instance({ kbdSettings: settings, settings: {}, extWm: {} });
  return {
    bindings,
    values,
    registered,
    notifications,
    failures,
    attempts,
    idles,
    change() {
      changed();
    },
    setSystem(records) {
      system = records;
      systemChanged?.();
    },
    flush() {
      for (const [id, callback] of idles) {
        idles.delete(id);
        callback();
      }
    },
    watching() {
      return !!changed || !!systemChanged;
    },
  };
}

test("runtime keeps configured conflicts out of registration and reports them once", () => {
  const harness = runtimeHarness();
  harness.values.set("window-focus-right", ["<Super>l"]);
  harness.setSystem([record("gnome", "Lock screen", ["<Super>l"])]);
  harness.bindings.enable();
  assert.equal(harness.registered.has("window-focus-right"), false);
  assert.equal(harness.registered.has("window-focus-left"), true);
  assert.equal(harness.attempts.includes("prefs-open"), false);
  assert.match(harness.notifications[0].body, /Lock screen/);
  harness.change();
  harness.flush();
  assert.equal(harness.notifications.length, 1);
  harness.values.set("window-focus-right", ["<Alt><Super>l"]);
  harness.change();
  harness.flush();
  assert.equal(harness.registered.has("window-focus-right"), true);
});

test("runtime registration failures notify and enabled bindings retry after changes", () => {
  const harness = runtimeHarness();
  harness.failures.add("window-focus-right");
  harness.bindings.enable();
  assert.equal(harness.registered.has("window-focus-right"), false);
  assert.match(harness.notifications[0].body, /registration failed/);
  harness.failures.clear();
  harness.change();
  harness.change();
  assert.equal(harness.idles.size, 1);
  harness.flush();
  assert.equal(harness.registered.has("window-focus-right"), true);
});

test("system changes refresh conflicts and disable cleans signals and pending work", () => {
  const harness = runtimeHarness();
  harness.bindings.enable();
  const attempts = harness.attempts.length;
  harness.bindings.enable();
  assert.equal(harness.attempts.length, attempts);
  harness.setSystem([record("custom", "Launcher", ["<Alt><Super>l"])]);
  harness.flush();
  assert.equal(harness.registered.has("window-focus-right"), false);
  harness.change();
  harness.bindings.disable();
  assert.equal(harness.registered.size, 0);
  assert.equal(harness.idles.size, 0);
  assert.equal(harness.watching(), false);
  harness.bindings.disable();
});
