const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function load(context, file, exports) {
  const source = fs
    .readFileSync(path.join(__dirname, "..", "lib", file), "utf8")
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export /gm, "");
  vm.runInContext(`${source}\nObject.assign(globalThis, {${exports}});`, context);
}

function helpers() {
  const context = vm.createContext({});
  load(
    context,
    "shared/window-corners.js",
    "normalizeRadius, gtkCornerCss, qtCornerCss, replaceCornerBlock, updateQtStylesheets, cornerGeometry, cornerPaintGeometry"
  );
  return context;
}

test("GTK overrides update once and restore existing CSS byte for byte", () => {
  const h = helpers();
  for (const original of [
    "",
    "/* custom theme */\nwindow { color: red; }",
    "@import 'theme.css';\n",
  ]) {
    const rounded = h.replaceCornerBlock(original, h.gtkCornerCss(14, 3));
    const updated = h.replaceCornerBlock(rounded, h.gtkCornerCss(7, 3));
    assert.equal(updated.split("BEGIN Forge").length, 2);
    assert.match(updated, /border-radius: 7px/);
    assert.equal(h.replaceCornerBlock(updated), original);
    assert.equal(
      h.replaceCornerBlock(updated + "\n/* user edit */"),
      original + "\n/* user edit */"
    );
  }
  assert.throws(() => h.replaceCornerBlock("/* BEGIN Forge window corners */\nuser CSS"));
});

test("Qt overrides preserve quoted paths, other settings, and absent or empty keys", () => {
  const h = helpers();
  const qss = '/config/forge with "quotes", and commas/window-corners.qss';
  for (const value of [null, "", "@Invalid()", '"/theme/with,comma.qss", /theme/other.qss']) {
    const original = `[Appearance]\nstyle=Fusion\n[Interface]\n${
      value === null ? "" : `stylesheets=${value}\n`
    }wheel_scroll_lines=3\n`;
    const applied = h.updateQtStylesheets(original, qss, true);
    const updated = h.updateQtStylesheets(applied.contents, qss, true, applied.previous);
    assert.equal(updated.contents, applied.contents);
    assert.equal(
      h.updateQtStylesheets(updated.contents, qss, false, updated.previous).contents,
      original
    );
  }
});

test("Qt overrides support configurations without an Interface section", () => {
  const h = helpers();
  const path = "/config/forge/window-corners.qss";
  for (const original of ["[Appearance]\nstyle=Fusion", "[Appearance]\nstyle=Fusion\n"]) {
    const applied = h.updateQtStylesheets(original, path, true);
    const updated = h.updateQtStylesheets(applied.contents, path, true, applied.previous);
    assert.equal(updated.contents, applied.contents);
    assert.equal(
      h.updateQtStylesheets(updated.contents, path, false, updated.previous).contents,
      original
    );
    const edited = applied.contents + "wheel_scroll_lines=3\n";
    const removed = h.updateQtStylesheets(edited, path, false, applied.previous);
    assert.match(removed.contents, /\[Interface\]/);
    assert.match(removed.contents, /wheel_scroll_lines=3/);
  }
});

test("Qt cleanup keeps stylesheets added by the user while Forge is running", () => {
  const h = helpers();
  const qss = "/config/forge/window-corners.qss";
  const original = "[Interface]\nstylesheets=/theme/original.qss\n";
  const applied = h.updateQtStylesheets(original, qss, true);
  const edited = applied.contents.replace(
    'window-corners.qss"',
    'window-corners.qss", /theme/new.qss'
  );
  const refreshed = h.updateQtStylesheets(edited, qss, true, applied.previous);
  const removed = h.updateQtStylesheets(refreshed.contents, qss, false, refreshed.previous);
  assert.match(removed.contents, /original.qss, \/theme\/new.qss/);
  assert.doesNotMatch(removed.contents, /window-corners/);
  assert.throws(() => h.updateQtStylesheets('[Interface]\nstylesheets="broken\n', qss, true));
});

test("clipping uses frame bounds within shadow buffers and scales the radius", () => {
  const h = helpers();
  const geometry = h.cornerGeometry(
    { x: 100, y: 100, width: 200, height: 120 },
    { x: 90, y: 90, width: 220, height: 140 },
    440,
    280,
    14
  );
  assert.deepEqual(JSON.parse(JSON.stringify(geometry)), {
    size: [440, 280],
    bounds: [20, 20, 420, 260],
    radius: 28,
  });
  assert.equal(h.cornerGeometry({}, { width: 0, height: 0 }, 0, 0, 14), null);
  assert.equal(h.normalizeRadius("0px"), 0);
  assert.equal(h.normalizeRadius(undefined), 14);
});

test("paint coordinates account for padding, negative paint origins, and resource scaling", () => {
  const h = helpers();
  const geometry = h.cornerGeometry(
    { x: 100, y: 100, width: 200, height: 120 },
    { x: 90, y: 90, width: 220, height: 140 },
    220,
    140,
    8
  );
  const paint = h.cornerPaintGeometry(
    geometry,
    { x: -10, y: -10, width: 240, height: 160 },
    486,
    326,
    2
  );
  assert.deepEqual([...paint.size], [243, 163]);
  assert.deepEqual([...paint.origin], [-12, -12]);
  // Texture coordinate (22,22) maps to the frame origin (10,10).
  assert.equal(22 + paint.origin[0], geometry.bounds[0]);
  assert.equal(paint.radius, 8);
  const fallback = h.cornerPaintGeometry(
    geometry,
    { x: 100.25, y: 80.25, width: 220, height: 140, allocation: true },
    223,
    143,
    1
  );
  assert.deepEqual([...fallback.origin], [-2, -2]);
});

test("both shader APIs refresh uniforms from the current render target on every paint", () => {
  for (const legacy of [true, false]) {
    const context = helpers();
    const uniforms = new Map();
    let paints = 0;
    let target = [true, 406, 246];
    const actor = {
      get_resource_scale: () => 2,
      get_paint_volume: () => ({
        get_origin: () => ({ x: 0, y: 0 }),
        get_width: () => 200,
        get_height: () => 120,
      }),
    };
    class Effect {
      get_actor() {
        return actor;
      }
      get_target_size() {
        return target;
      }
      get_uniform_location(name) {
        return name;
      }
      set_uniform_float(name, count, values) {
        assert.equal(count, values.length);
        uniforms.set(name, [...values]);
      }
      vfunc_paint_target() {
        paints++;
      }
    }
    Object.assign(context, {
      Clutter: { ShaderEffect: Effect },
      Shell: { GLSLEffect: legacy ? Effect : null, SnippetHook: { FRAGMENT: 0 } },
      Cogl: { SnippetHook: { FRAGMENT: 0 } },
      GObject: { registerClass: (klass) => klass },
    });
    load(context, "extension/window-corner-effect.js", "WindowCornerEffect");
    const effect = new context.WindowCornerEffect();
    effect.update({ size: [200, 120], bounds: [0, 0, 200, 120], radius: 8 });
    effect.vfunc_paint_target({}, {});
    assert.deepEqual(uniforms.get("forge_size"), [203, 123]);
    assert.deepEqual(uniforms.get("forge_origin"), [-2, -2]);
    assert.deepEqual(uniforms.get("forge_bounds"), [0, 0, 200, 120]);
    target = [true, 806, 486];
    effect.update({ bounds: [0, 0, 400, 240], radius: 12 });
    effect.vfunc_paint_target({}, {});
    assert.deepEqual(uniforms.get("forge_size"), [403, 243]);
    assert.deepEqual(uniforms.get("forge_radius"), [12]);
    assert.equal(paints, 2);
  }
});

function managerHarness() {
  const context = helpers();
  let nextSignal = 1;
  function emitter(properties = {}) {
    return Object.assign(properties, {
      signals: new Map(),
      connect(name, callback) {
        const id = nextSignal++;
        this.signals.set(id, { name, callback });
        return id;
      },
      disconnect(id) {
        assert.ok(this.signals.delete(id));
      },
      emit(name, ...args) {
        for (const signal of [...this.signals.values()]) {
          if (signal.name === name) signal.callback(this, ...args);
        }
      },
    });
  }
  class Effect {
    update(geometry) {
      this.geometry = geometry;
    }
    set_enabled(enabled) {
      this.enabled = enabled;
    }
  }
  const display = emitter();
  const wm = emitter();
  Object.assign(context, {
    console,
    WindowCornerEffect: Effect,
    Gio: { File: { new_for_path: () => ({ query_exists: () => false }) } },
    GLib: { get_user_config_dir: () => "/config", build_filenamev: (parts) => parts.join("/") },
    Meta: { WindowType: { NORMAL: 0, DIALOG: 1, MODAL_DIALOG: 2 }, MaximizeFlags: { BOTH: 3 } },
    global: { display, window_manager: wm, get_window_actors: () => [] },
  });
  load(context, "extension/window-corners.js", "WindowCorners");
  let radius = "14px";
  const manager = new context.WindowCorners({
    theme: { getCssProperty: () => ({ value: radius }) },
  });
  manager.active = true;
  manager._updateThemes = () => {};
  manager._read = () => null;
  manager.refresh();
  function actor(legacy = false) {
    const window = emitter({
      fullscreen: false,
      maximized: false,
      get_window_type: () => 0,
      get_frame_rect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      get_buffer_rect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      is_fullscreen() {
        return this.fullscreen;
      },
      get_maximized() {
        return this.maximized ? 3 : 0;
      },
    });
    if (!legacy) window.is_maximized = () => window.maximized;
    return emitter({
      width: 100,
      height: 100,
      meta_window: window,
      otherEffect: {},
      add_effect_with_name(_name, effect) {
        this.effect = effect;
      },
      remove_effect(effect) {
        assert.equal(effect, this.effect);
        this.effect = null;
      },
      queue_redraw() {},
    });
  }
  return { manager, actor, context, display, wm, setRadius: (value) => (radius = value) };
}

test("enabling rounds existing windows and maps actors that arrive after window-created", () => {
  const h = managerHarness();
  const existing = h.actor();
  h.context.global.get_window_actors = () => [existing];
  h.manager.enable();
  assert.equal(existing.effect.enabled, true);
  h.display.emit("window-created", { get_compositor_private: () => null });
  const later = h.actor();
  h.wm.emit("map", later);
  assert.equal(later.effect.enabled, true);
  const popup = h.actor();
  popup.meta_window.get_window_type = () => 99;
  h.wm.emit("map", popup);
  assert.equal(popup.effect, undefined);
  h.manager.disable();
  assert.equal(h.display.signals.size, 0);
  assert.equal(h.wm.signals.size, 0);
});

test("existing windows respond to radius, fullscreen, maximize, resize, and disable", () => {
  const h = managerHarness();
  for (const legacy of [false, true]) {
    const actor = h.actor(legacy);
    h.manager._track(actor);
    assert.equal(actor.effect.enabled, true);
    actor.width = 200;
    actor.emit("notify::allocation");
    assert.equal(actor.effect.geometry.size[0], 200);
    actor.meta_window.fullscreen = true;
    actor.meta_window.emit("notify::fullscreen");
    assert.equal(actor.effect.enabled, false);
    actor.meta_window.fullscreen = false;
    actor.meta_window.maximized = true;
    actor.meta_window.emit("size-changed");
    assert.equal(actor.effect.enabled, false);
    actor.meta_window.maximized = false;
    actor.meta_window.emit("size-changed");
    assert.equal(actor.effect.enabled, true);
  }
  h.setRadius("0px");
  h.manager.refresh();
  for (const actor of h.manager.actors.keys()) assert.equal(actor.effect.enabled, false);
  h.setRadius("8px");
  h.manager.refresh();
  const actors = [...h.manager.actors.keys()];
  h.manager.disable();
  for (const actor of actors) {
    assert.equal(actor.effect, null);
    assert.ok(actor.otherEffect);
    assert.equal(actor.signals.size, 0);
    assert.equal(actor.meta_window.signals.size, 0);
  }
});

test("destroyed windows disconnect their signals and leave no tracked actors", () => {
  const h = managerHarness();
  const actor = h.actor();
  h.manager._track(actor);
  actor.emit("destroy");
  assert.equal(h.manager.actors.size, 0);
  assert.equal(actor.meta_window.signals.size, 0);
});
