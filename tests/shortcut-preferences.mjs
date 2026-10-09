// Run through shortcut_preferences_test.py in an isolated GTK display and memory settings.
import Adw from "gi://Adw";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";
import { KeyboardPage } from "../lib/prefs/keyboard.js";
import { canonicalAccelerator, findShortcutConflicts } from "../lib/shared/shortcut-conflicts.js";
import { SystemShortcuts, shortcutRecords } from "../lib/shared/shortcut-settings.js";
function assert(value, message) {
  if (!value) throw Error(message);
}
function drain() {
  const context = GLib.MainContext.default();
  while (context.pending()) context.iteration(false);
}
Adw.init();
const source = Gio.SettingsSchemaSource.new_from_directory(
  Gio.File.new_for_uri(import.meta.url)
    .get_parent()
    .get_parent()
    .get_child("schemas")
    .get_path(),
  Gio.SettingsSchemaSource.get_default(),
  false
);
const settings = new Gio.Settings({
  settings_schema: source.lookup("org.gnome.shell.extensions.forge.keybindings", false),
});
const system = new SystemShortcuts();
const records = [...shortcutRecords(settings), ...system.records()];
for (const record of shortcutRecords(settings)) {
  assert(
    !findShortcutConflicts(record.accelerators, records, record).length,
    "Default conflict: " + record.key
  );
  for (const value of record.accelerators) {
    const [ok, key, mods] = Gtk.accelerator_parse(value);
    assert(ok && Gtk.accelerator_valid(key, mods), "Invalid default: " + value);
    assert(
      canonicalAccelerator(value) === canonicalAccelerator(Gtk.accelerator_name(key, mods)),
      "Canonical mismatch: " + value
    );
  }
}
settings.set_strv("window-focus-right", ["<Super>l"]);
settings.set_string("mod-mask-mouse-tile", "Alt");
const window = new Adw.PreferencesWindow();
const page = new KeyboardPage({ kbdSettings: settings, window });
window.add(page);
assert(
  settings.get_strv("window-focus-right")[0] === "<Super>l",
  "Opening preferences rewrote saved shortcut"
);
assert(page.rows.get("window-focus-right").warning.visible, "Saved lock-screen conflict not shown");
const right = page.rows.get("window-focus-right").row;
right.set_text("<Super>l");
page._commit("window-focus-right");
assert(
  settings.get_strv("window-focus-right")[0] === "<Super>l",
  "Conflict commit changed saved setting"
);
right.set_text("<Alt><Super>l");
assert(
  settings.get_strv("window-focus-right")[0] === "<Super>l",
  "Typing wrote shortcut prematurely"
);
right.emit("apply");
assert(
  canonicalAccelerator(settings.get_strv("window-focus-right")[0]) ===
    canonicalAccelerator("<Alt><Super>l"),
  "Apply did not save valid shortcut"
);
const left = page.rows.get("window-focus-left").row;
left.set_text("<Super><Alt>l");
assert(page.rows.get("window-focus-left").warning.visible, "Duplicate Forge binding not shown");
left.emit("apply");
assert(
  canonicalAccelerator(settings.get_strv("window-focus-left")[0]) ===
    canonicalAccelerator("<Alt><Super>h"),
  "Duplicate Forge shortcut was saved"
);
left.set_text("invalid shortcut");
assert(page.rows.get("window-focus-left").warning.visible, "Invalid shortcut not shown");
page._confirmRecommended();
for (const top of Gtk.Window.get_toplevels()) {
  if (top instanceof Adw.MessageDialog) {
    assert(top.default_response === "cancel", "Confirmation defaults to apply");
    top.response("cancel");
  }
}
settings.set_strv("window-focus-right", ["<Ctrl><Super>F12"]);
page._confirmRecommended();
for (const top of Gtk.Window.get_toplevels()) {
  if (top instanceof Adw.MessageDialog) top.response("apply");
}
drain();
assert(
  canonicalAccelerator(settings.get_strv("window-focus-right")[0]) ===
    canonicalAccelerator("<Alt><Super>l"),
  "Recommended shortcuts not applied"
);
assert(
  settings.get_user_value("window-focus-right") === null,
  "Recommended shortcut override not reset"
);
assert(
  settings.get_string("mod-mask-mouse-tile") === "Alt",
  "Recommended action changed drag modifier"
);
settings.set_string("mod-mask-mouse-tile", "Ctrl");
assert(
  new Gio.Settings({ settings_schema: settings.settings_schema }).get_string(
    "mod-mask-mouse-tile"
  ) === "Ctrl",
  "Recommended action left shared settings delayed"
);
const media = system.settings.find(
  (s) => s.schema_id === "org.gnome.settings-daemon.plugins.media-keys"
);
const customPath = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/forge-test/";
const custom = new Gio.Settings({
  schema_id: "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding",
  path: customPath,
});
custom.set_string("name", "Native test launcher");
custom.set_string("binding", "<Alt><Super>l");
media.set_strv("custom-keybindings", [customPath]);
drain();
assert(page.rows.get("window-focus-right").warning.visible, "Custom shortcut conflict not shown");
assert(
  page._recommendedProblems().some((v) => v.includes("Native test launcher")),
  "Recommended plan failed to check custom shortcuts"
);
settings.set_strv("window-focus-right", ["<Ctrl><Super>F12"]);
page._applyRecommended();
assert(
  settings.get_strv("window-focus-right")[0] === "<Ctrl><Super>F12",
  "Conflicting recommended plan applied"
);
custom.set_string("binding", "<Alt><Super>F11");
drain();
assert(!page._recommendedProblems().length, "Custom binding watcher did not update");
for (const top of Gtk.Window.get_toplevels())
  if (top instanceof Adw.MessageDialog) top.response("cancel");
window.emit("close-request");
assert(page.systemShortcuts.signals.length === 0, "System signals leaked after close");
assert(page._settingsSignal === 0, "Forge signal leaked after close");
window.destroy();
system.destroy();
print(
  "Native GTK/GSettings checks passed: defaults, edits, conflicts, confirmation, migration, custom watchers and cleanup."
);
