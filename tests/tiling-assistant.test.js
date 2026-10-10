const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

class Variant {
  constructor(type, value) {
    this.type = type;
    this.value = value;
  }
  print() {
    return JSON.stringify([this.type, this.value]);
  }
  equal(other) {
    return this.print() === other.print();
  }
  get_type_string() {
    return this.type;
  }
  static parse(_, text) {
    return new Variant(...JSON.parse(text));
  }
}

class Signals {
  constructor() {
    this.signals = new Map();
    this.next = 1;
  }
  connect(signal, callback) {
    const id = this.next++;
    this.signals.set(id, { signal, callback });
    return id;
  }
  disconnect(id) {
    assert.ok(this.signals.delete(id));
  }
  emit(signal, value) {
    for (const entry of [...this.signals.values()]) {
      if (entry.signal === signal || entry.signal === `${signal}::${value}`)
        entry.callback(this, value);
    }
  }
}

class Settings extends Signals {
  constructor(defaults) {
    super();
    this.defaults = defaults;
    this.user = {};
  }
  get_value(key) {
    return this.user[key] ?? this.defaults[key];
  }
  get_user_value(key) {
    return this.user[key] ?? null;
  }
  set_value(key, value) {
    this.user[key] = value;
    this.emit("changed", key);
    return true;
  }
  reset(key) {
    delete this.user[key];
    this.emit("changed", key);
  }
  is_writable() {
    return true;
  }
  get_boolean(key) {
    return this.get_value(key).value;
  }
  get_string(key) {
    return this.get_value(key).value;
  }
  set_string(key, value) {
    return this.set_value(key, new Variant("s", value));
  }
}

function setup({ installed = true, active = true, tiling = true } = {}) {
  const source = fs
    .readFileSync(path.join(__dirname, "../lib/extension/tiling-assistant.js"), "utf8")
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  const context = vm.createContext({});
  vm.runInContext(source.slice(0, source.indexOf("class TilingAssistant")), context);
  const defaults = {};
  for (const [key, value] of Object.entries(
    context.ASSISTANCE ?? vm.runInContext("ASSISTANCE", context)
  )) {
    defaults[key] = new Variant(
      typeof value === "boolean" ? "b" : "i",
      value === true ? false : value === false ? true : 2
    );
  }
  defaults["enable-tiling-popup"] = new Variant("b", true);
  defaults["tile-left-half"] = new Variant("as", ["<Super>Left"]);
  defaults["tile-edit-mode"] = new Variant("as", []);
  defaults["activate-layout0"] = new Variant("as", ["<Super>1"]);
  defaults["debugging-show-tiled-rects"] = new Variant("as", []);
  defaults["favorite-layouts"] = new Variant("as", ["My layout"]);
  defaults["focus-hint-outline-border-radius"] = new Variant("i", 8);
  const uta = new Settings(defaults);
  const forge = new Settings({
    "tiling-mode-enabled": new Variant("b", tiling),
    "tiling-assistant-overrides": new Variant("s", "{}"),
  });
  const calls = [];
  class Move {
    _onMoveStarted(...args) {
      calls.push(["move", this, ...args]);
    }
  }
  class Resize {
    _onResizeStarted() {
      calls.push(["resize"]);
    }
    _onResizeFinished() {
      calls.push(["finish"]);
    }
  }
  const owner = () => ({
    _moveHandler: new Move(),
    _resizeHandler: new Resize(),
    _twm: {
      async tile() {
        calls.push(["tile"]);
      },
      untile() {
        calls.push(["untile"]);
      },
      _onWindowWorkspaceChanged() {
        calls.push(["workspace"]);
      },
    },
  });
  const entry = { state: active ? 1 : 2, stateObj: owner() };
  const extensions = new Signals();
  extensions.lookup = () => entry;
  const display = new Signals();
  display.grabbed = false;
  display.is_grabbed = () => display.grabbed;
  const idle = new Map();
  let nextIdle = 1;
  const schema = {
    list_keys: () => Object.keys(defaults),
    has_key: (key) => key in defaults,
  };
  Object.assign(context, {
    Gio: {
      SettingsSchemaSource: { get_default: () => ({ lookup: () => (installed ? schema : null) }) },
      Settings: function () {
        return uta;
      },
    },
    GLib: {
      Variant,
      Source: { remove: (id) => idle.delete(id) },
      idle_add: (_, callback) => {
        const id = nextIdle++;
        idle.set(id, callback);
        return id;
      },
    },
    Main: { extensionManager: extensions },
    ExtensionState: { ACTIVE: 1 },
    global: { display },
    Logger: { warn: () => {}, error: () => {} },
  });
  vm.runInContext(
    source.slice(source.indexOf("class TilingAssistant")) +
      "\nglobalThis.Manager = TilingAssistant;",
    context
  );
  const manager = new context.Manager({ settings: forge });
  return {
    manager,
    uta,
    forge,
    entry,
    calls,
    owner,
    display,
    extensions,
    toggle: (value) => forge.set_value("tiling-mode-enabled", new Variant("b", value)),
    flush: () => {
      for (const [id, callback] of [...idle]) {
        idle.delete(id);
        callback();
      }
    },
  };
}

test("pause all assistance without changing extension state; restore defaults and explicit preferences", async () => {
  const h = setup();
  h.uta.set_value("focus-hint", new Variant("i", 3));
  h.uta.set_value("tile-edit-mode", new Variant("as", ["<Super>e"]));
  h.manager.enable();
  assert.equal(h.entry.state, 1);
  assert.equal(h.uta.get_boolean("enable-tiling-popup"), false);
  assert.equal(h.uta.get_value("focus-hint").value, 0);
  assert.deepEqual(Array.from(h.uta.get_value("tile-left-half").value), []);
  assert.deepEqual(Array.from(h.uta.get_value("activate-layout0").value), []);
  assert.deepEqual(h.uta.get_value("favorite-layouts").value, ["My layout"]);
  assert.equal(h.uta.get_value("focus-hint-outline-border-radius").value, 8);
  h.entry.stateObj._moveHandler._onMoveStarted("window");
  h.entry.stateObj._resizeHandler._onResizeStarted();
  await h.entry.stateObj._twm.tile();
  h.entry.stateObj._twm.untile();
  h.entry.stateObj._twm._onWindowWorkspaceChanged();
  assert.equal(h.calls.length, 0);
  h.toggle(false);
  assert.equal(h.uta.get_user_value("enable-tiling-popup"), null);
  assert.equal(h.uta.get_value("focus-hint").value, 3);
  assert.deepEqual(h.uta.get_value("tile-edit-mode").value, ["<Super>e"]);
  h.entry.stateObj._moveHandler._onMoveStarted("window");
  assert.deepEqual(h.calls[0], ["move", h.entry.stateObj._moveHandler, "window"]);
  assert.equal(Object.hasOwn(h.entry.stateObj._moveHandler, "_onMoveStarted"), false);
  assert.equal(h.forge.get_string("tiling-assistant-overrides"), "{}");
  h.manager.disable();
  assert.equal(
    h.uta.signals.size + h.forge.signals.size + h.extensions.signals.size + h.display.signals.size,
    0
  );
});

test("preference edits while paused are restored when Forge is disabled", () => {
  const h = setup();
  h.manager.enable();
  h.uta.set_value("focus-hint", new Variant("i", 3));
  assert.equal(h.uta.get_value("focus-hint").value, 0);
  h.manager.disable();
  assert.equal(h.uta.get_value("focus-hint").value, 3);
});

test("enabling TA later, disabling TA, and recreating its handlers keep ownership consistent", () => {
  const h = setup({ active: false });
  h.manager.enable();
  assert.equal(h.uta.get_user_value("enable-tiling-popup"), null);
  h.entry.state = 1;
  h.extensions.emit("extension-state-changed", h.entry);
  h.flush();
  const old = h.entry.stateObj;
  old._moveHandler._onMoveStarted();
  assert.equal(h.calls.length, 0);
  h.entry.stateObj = h.owner();
  h.extensions.emit("extension-state-changed", h.entry);
  h.flush();
  old._moveHandler._onMoveStarted();
  assert.equal(h.calls.length, 1);
  h.entry.stateObj._moveHandler._onMoveStarted();
  assert.equal(h.calls.length, 1);
  h.entry.state = 2;
  h.extensions.emit("extension-state-changed", h.entry);
  h.flush();
  assert.equal(h.uta.get_user_value("enable-tiling-popup"), null);
  h.manager.disable();
});

test("wait until the current grab ends before changing handlers", () => {
  const h = setup({ tiling: false });
  h.manager.enable();
  h.display.grabbed = true;
  h.toggle(true);
  h.entry.stateObj._moveHandler._onMoveStarted();
  assert.equal(h.calls.length, 1);
  h.display.grabbed = false;
  h.display.emit("grab-op-end");
  h.flush();
  h.entry.stateObj._moveHandler._onMoveStarted();
  assert.equal(h.calls.length, 1);
  h.manager.disable();
});

test("recover a persisted backup after restart without capturing paused values as preferences", () => {
  const h = setup();
  h.manager.enable();
  const backup = h.forge.get_string("tiling-assistant-overrides");
  h.manager.disable();
  const saved = JSON.parse(backup);
  for (const [key, entry] of Object.entries(saved))
    h.uta.set_value(key, Variant.parse(null, entry.suppressed));
  h.forge.set_string("tiling-assistant-overrides", backup);
  h.manager.enable();
  h.toggle(false);
  assert.equal(h.uta.get_user_value("enable-tiling-popup"), null);
  assert.deepEqual(h.uta.get_value("tile-left-half").value, ["<Super>Left"]);
  h.manager.disable();
});

test("missing TA is harmless and other extensions' later method overrides are preserved", () => {
  const absent = setup({ installed: false });
  absent.manager.enable();
  absent.manager.disable();
  assert.equal(absent.forge.signals.size, 0);
  const h = setup();
  h.manager.enable();
  const replacement = () => "other extension";
  h.entry.stateObj._moveHandler._onMoveStarted = replacement;
  h.manager.disable();
  assert.equal(h.entry.stateObj._moveHandler._onMoveStarted, replacement);
});
