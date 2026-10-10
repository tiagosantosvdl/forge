import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Gtk from "gi://Gtk?version=4.0";

import { WindowCorners } from "../lib/extension/window-corners.js";
import { gtkCornerCss } from "../lib/shared/window-corners.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const directory = GLib.dir_make_tmp("forge-window-corners-XXXXXX");
const manager = new WindowCorners(null, directory);
manager.radius = 14;

const gtk3 = `${directory}/gtk-3.0/gtk.css`;
const gtk4 = `${directory}/gtk-4.0/gtk.css`;
const qt5 = `${directory}/qt5ct/qt5ct.conf`;
const qt6 = `${directory}/qt6ct/qt6ct.conf`;
const originalGtk = "/* User CSS */\nwindow { color: red; }";
const originalQt5 =
  '[Appearance]\nstyle=Adwaita\n[Interface]\nstylesheets="/theme/with,comma.qss"\n';
const originalQt6 = "[Appearance]\nstyle=Adwaita\n";
const linkedTheme = `${directory}/theme.css`;
manager._write(linkedTheme, originalGtk, null);
GLib.mkdir_with_parents(`${directory}/gtk-3.0`, 0o700);
Gio.File.new_for_path(gtk3).make_symbolic_link(linkedTheme, null);
manager._write(gtk4, "", null);
manager._write(qt5, originalQt5, null);
manager._write(qt6, originalQt6, null);

for (const version of [3, 4]) {
  const provider = new Gtk.CssProvider();
  provider.connect("parsing-error", (_provider, _section, error) => {
    throw new Error(`GTK ${version} override failed to parse: ${error.message}`);
  });
  const css = gtkCornerCss(14, version);
  provider.load_from_data(css, -1);
}

manager._updateThemes();
assert(
  Gio.File.new_for_path(gtk3).query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null) ===
    Gio.FileType.SYMBOLIC_LINK,
  "GTK user theme symlink not preserved"
);
assert(manager._read(gtk3).contents.includes("border-radius: 14px"), "GTK radius not applied");
assert(manager._read(qt6).contents.includes("[Interface]"), "Qt 6 list not registered");
assert(manager._read(qt5).contents.includes("window-corners.qss"), "Qt 5 list not registered");
assert(
  manager._read(manager.qssPath).contents.includes("border-radius: 0"),
  "Qt fullscreen base not square"
);

// Exercise atomic replacements, live user edits, and recovery from the on-disk
// journal with real Gio files rather than a mocked filesystem.
const editedQt = manager._read(qt5);
manager._write(qt5, editedQt.contents + "wheel_scroll_lines=7\n", editedQt);
manager.radius = 8;
manager._updateThemes();
assert(manager._read(gtk3).contents.includes("border-radius: 8px"), "GTK radius not updated");
const recovered = new WindowCorners(null, directory);
recovered.qtState = JSON.parse(recovered._read(recovered.statePath).contents);
recovered._updateThemes(false);
assert(recovered._read(gtk3).contents === originalGtk, "GTK user CSS not restored");
assert(recovered._read(gtk4).contents === "", "Existing empty GTK file not preserved");
assert(
  recovered._read(qt5).contents === originalQt5 + "wheel_scroll_lines=7\n",
  "Qt user edit lost"
);
assert(recovered._read(qt6).contents === originalQt6, "Qt 6 section not restored");
assert(recovered._read(recovered.qssPath) === null, "Qt stylesheet not removed");
assert(recovered._read(recovered.statePath) === null, "Ownership journal not removed");

for (const path of [gtk3, gtk4, qt5, qt6, linkedTheme]) Gio.File.new_for_path(path).delete(null);

// Files created by Forge are removed when no user CSS was added to them.
const fresh = new WindowCorners(null, directory);
fresh.radius = 14;
fresh._updateThemes();
fresh._updateThemes(false);
assert(fresh._read(gtk3) === null && fresh._read(gtk4) === null, "Created GTK files not removed");
for (const name of ["gtk-3.0", "gtk-4.0", "qt5ct", "qt6ct", "forge"]) {
  Gio.File.new_for_path(`${directory}/${name}`).delete(null);
}
Gio.File.new_for_path(directory).delete(null);
print("Native window corner configuration checks passed");
