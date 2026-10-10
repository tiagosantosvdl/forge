import Gio from "gi://Gio";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { ExtensionState } from "resource:///org/gnome/shell/misc/extensionUtils.js";

import { Logger } from "../shared/logger.js";

const UUID = "tiling-assistant@ubuntu.com";
const SCHEMA = "org.gnome.shell.extensions.tiling-assistant";
const BACKUP = "tiling-assistant-overrides";
const ASSISTANCE = {
  "enable-tiling-popup": false,
  "enable-raise-tile-group": false,
  "tilegroups-in-app-switcher": false,
  "show-layout-panel-indicator": false,
  "enable-advanced-experimental-features": false,
  "enable-tile-animations": false,
  "enable-untile-animations": false,
  "enable-hold-maximize-inverse-landscape": false,
  "enable-hold-maximize-inverse-portrait": false,
  "adapt-edge-tiling-to-favorite-layout": false,
  "monitor-switch-grace-period": false,
  "disable-tile-groups": true,
  "dynamic-keybinding-behavior": 0,
  "focus-hint": 0,
  "move-adaptive-tiling-mod": 0,
  "move-favorite-layout-mod": 0,
  "ignore-ta-mod": 0,
};

// Match shortcut keys explicitly: favorite-layouts is also an array of strings,
// but contains the user's layouts rather than accelerators.
const SHORTCUT =
  /^(tile-|activate-layout\d+$|debugging-|toggle-tiling-popup$|auto-tile$|toggle-always-on-top$|restore-window$|center-window$|search-popup-layout$)/;

export class TilingAssistant {
  constructor(extension) {
    this.extension = extension;
    this._patches = [];
    this._saved = {};
  }

  enable() {
    const schema = Gio.SettingsSchemaSource.get_default().lookup(SCHEMA, true);
    if (!schema) return;
    this._settings = new Gio.Settings({ settings_schema: schema });
    this._schema = schema;
    try {
      this._saved = JSON.parse(this.extension.settings.get_string(BACKUP));
    } catch (error) {
      Logger.error(`Cannot read saved Tiling Assistant preferences: ${error}`);
      this._settings = null;
      return;
    }
    this._forgeSignal = this.extension.settings.connect("changed::tiling-mode-enabled", () =>
      this._sync()
    );
    // Shell can also recreate other extensions while changing extension order.
    this._extensionSignal = Main.extensionManager.connect("extension-state-changed", () =>
      this._scheduleSync()
    );
    this._grabSignal = global.display.connect("grab-op-end", () => this._scheduleSync());
    this._settingsSignal = this._settings.connect("changed", (_, key) => {
      if (!this._owner || this._writing || !this._saved[key]) return;
      const saved = this._saved[key];
      if (this._settings.get_value(key).print(true) === saved.suppressed) return;
      // Preserve preference edits made while paused, then keep assistance off.
      saved.original = this._settings.get_user_value(key)?.print(true) ?? null;
      this._persist();
      this._write(key, saved.suppressed);
    });
    this._sync();
  }

  disable() {
    if (!this._settings) return;
    if (this._idle) GLib.Source.remove(this._idle);
    this._idle = 0;
    this.extension.settings.disconnect(this._forgeSignal);
    Main.extensionManager.disconnect(this._extensionSignal);
    global.display.disconnect(this._grabSignal);
    this._settings.disconnect(this._settingsSignal);
    this._release();
    this._settings = null;
  }

  _scheduleSync() {
    if (this._idle) return;
    this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
      this._idle = 0;
      this._sync();
      return GLib.SOURCE_REMOVE;
    });
  }

  _sync() {
    // Let an ongoing drag/resize complete before taking over its handlers.
    if (global.display.is_grabbed()) return;
    const extension = Main.extensionManager.lookup(UUID);
    const active = ExtensionState.ACTIVE ?? ExtensionState.ENABLED;
    const owner = extension?.state === active ? extension.stateObj : null;
    if (!owner || !this.extension.settings.get_boolean("tiling-mode-enabled")) {
      this._release();
      return;
    }
    if (this._owner === owner && this._moveHandler === owner._moveHandler) return;
    this._restoreMethods();
    this._owner = owner;
    this._moveHandler = owner._moveHandler;

    // No TA setting disables edge dragging or resizing pre-existing tile groups.
    // These entry points are looked up by its signal callbacks on every grab.
    this._pause(owner._moveHandler, "_onMoveStarted");
    this._pause(owner._resizeHandler, "_onResizeStarted");
    this._pause(owner._resizeHandler, "_onResizeFinished");
    // Also stop workspace/monitor changes and pending layout callbacks from
    // moving windows owned by Forge. Keep TA's window bookkeeping intact.
    this._pause(owner._twm, "tile", async () => {});
    this._pause(owner._twm, "untile");
    this._pause(owner._twm, "_onWindowWorkspaceChanged");

    for (const key of this._schema.list_keys()) {
      const value = SHORTCUT.test(key) ? [] : ASSISTANCE[key];
      if (value === undefined || !this._settings.is_writable(key)) continue;
      if (!this._saved[key]) {
        const type = this._settings.get_value(key).get_type_string();
        this._saved[key] = {
          original: this._settings.get_user_value(key)?.print(true) ?? null,
          suppressed: new GLib.Variant(type, value).print(true),
        };
      } else if (this._settings.get_value(key).print(true) !== this._saved[key].suppressed) {
        this._saved[key].original = this._settings.get_user_value(key)?.print(true) ?? null;
      }
    }
    // Journal before modifying another extension's preferences, so a Shell
    // restart cannot replace the user's preferences with the paused values.
    this._persist();
    this._writing = true;
    try {
      for (const [key, saved] of Object.entries(this._saved)) {
        if (this._schema.has_key(key)) this._write(key, saved.suppressed);
      }
    } finally {
      this._writing = false;
    }
  }

  _pause(object, name, replacement = () => {}) {
    if (typeof object?.[name] !== "function") {
      Logger.warn(`Tiling Assistant: unavailable handler ${name}`);
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    object[name] = replacement;
    this._patches.push({ object, name, descriptor, replacement });
  }

  _restoreMethods() {
    for (const { object, name, descriptor, replacement } of this._patches.reverse()) {
      // Leave subsequent patches made by another extension intact.
      if (object[name] !== replacement) continue;
      if (descriptor) Object.defineProperty(object, name, descriptor);
      else delete object[name];
    }
    this._patches = [];
    this._owner = null;
    this._moveHandler = null;
  }

  _release() {
    this._restoreMethods();
    this._writing = true;
    try {
      for (const [key, saved] of Object.entries(this._saved)) {
        if (!this._schema.has_key(key)) {
          delete this._saved[key];
          continue;
        }
        if (!this._settings.is_writable(key)) continue;
        // Preserve edits made while Forge was stopped or while TA shut down.
        if (this._settings.get_value(key).print(true) === saved.suppressed) {
          if (saved.original === null) this._settings.reset(key);
          else this._write(key, saved.original);
        }
        delete this._saved[key];
      }
      this._persist();
    } finally {
      this._writing = false;
    }
  }

  _write(key, text) {
    const value = GLib.Variant.parse(null, text, null, null);
    if (!this._settings.get_value(key).equal(value) && !this._settings.set_value(key, value))
      throw new Error(`Cannot update Tiling Assistant setting ${key}`);
  }

  _persist() {
    if (!this.extension.settings.set_string(BACKUP, JSON.stringify(this._saved)))
      throw new Error("Cannot save Tiling Assistant preferences");
  }
}
