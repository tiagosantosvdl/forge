import Gio from "gi://Gio";
import GLib from "gi://GLib";

function check(condition, message) {
  if (!condition) throw new Error(message);
}

class Signals {
  signals = new Map();
  connect(name, callback) {
    const id = this.signals.size + 1;
    this.signals.set(id, { name, callback });
    return id;
  }
  disconnect(id) {
    this.signals.delete(id);
  }
  is_grabbed() {
    return false;
  }
}

const owner = {
  _moveHandler: { _onMoveStarted() {} },
  _resizeHandler: { _onResizeStarted() {}, _onResizeFinished() {} },
  _twm: { async tile() {}, untile() {}, _onWindowWorkspaceChanged() {} },
};
const extensionManager = new Signals();
extensionManager.lookup = () => ({ state: 1, stateObj: owner });
globalThis.mockMain = { extensionManager };
globalThis.global = { display: new Signals() };
const { TilingAssistant } = await import("./assistant.mjs");
const forge = new Gio.Settings({ schema_id: "org.gnome.shell.extensions.forge" });
const uta = new Gio.Settings({ schema_id: "org.gnome.shell.extensions.tiling-assistant" });
uta.set_int("focus-hint", 3);
const manager = new TilingAssistant({ settings: forge });
manager.enable();
check(!uta.get_boolean("enable-tiling-popup"), "Popup should be paused");
check(uta.get_int("focus-hint") === 0, "Focus hints should be paused");
check(uta.get_strv("tile-left-half").length === 0, "Shortcut should be released");
check(uta.get_strv("favorite-layouts")[0] === "custom", "Layout should be preserved");
uta.set_int("focus-hint", 1);
check(uta.get_int("focus-hint") === 0, "Preference edit should remain paused");
forge.set_boolean("tiling-mode-enabled", false);
check(uta.get_int("focus-hint") === 1, "Edited preference should be restored");
check(uta.get_user_value("enable-tiling-popup") === null, "Default should be restored with reset");
check(uta.get_strv("tile-left-half")[0] === "<Super>Left", "Shortcut should be restored");
check(forge.get_string("tiling-assistant-overrides") === "{}", "Backup should be cleared");
forge.set_boolean("tiling-mode-enabled", true);
manager.disable();
check(uta.get_int("focus-hint") === 1, "Disabling Forge should restore preferences");
check(uta.get_boolean("enable-tiling-popup"), "Disabling Forge should restore assistance");
Gio.Settings.sync();
while (GLib.MainContext.default().pending()) GLib.MainContext.default().iteration(false);
print("Native Tiling Assistant checks passed");
