import Gio from "gi://Gio";

const SYSTEM_SCHEMAS = [
  "org.gnome.desktop.wm.keybindings",
  "org.gnome.shell.keybindings",
  "org.gnome.mutter.keybindings",
  "org.gnome.mutter.wayland.keybindings",
  "org.gnome.settings-daemon.plugins.media-keys",
];
const CUSTOM_SCHEMA = "org.gnome.settings-daemon.plugins.media-keys.custom-keybinding";

export function shortcutRecords(settings, source = "forge", defaults = false) {
  return settings
    .list_keys()
    .filter((key) => settings.get_value(key).get_type_string() === "as")
    .map((key) => ({
      source,
      key,
      label: settings.settings_schema.get_key(key).get_summary() || key.replaceAll("-", " "),
      accelerators: defaults
        ? settings.get_default_value(key).deep_unpack()
        : settings.get_strv(key),
    }));
}

export class SystemShortcuts {
  constructor() {
    this.source = Gio.SettingsSchemaSource.get_default();
    this.settings = SYSTEM_SCHEMAS.flatMap((id) => {
      const schema = this.source.lookup(id, true);
      return schema ? [new Gio.Settings({ settings_schema: schema })] : [];
    });
    this.signals = [];
  }

  customSettings() {
    const media = this.settings.find(
      (settings) => settings.schema_id === "org.gnome.settings-daemon.plugins.media-keys"
    );
    const schema = this.source.lookup(CUSTOM_SCHEMA, true);
    if (!schema || !media?.settings_schema.has_key("custom-keybindings")) return [];
    return media.get_strv("custom-keybindings").flatMap((path) => {
      if (!path.startsWith("/") || !path.endsWith("/")) return [];
      return [new Gio.Settings({ settings_schema: schema, path })];
    });
  }

  records() {
    return [
      ...this.settings.flatMap((settings) => shortcutRecords(settings, settings.schema_id)),
      ...this.customSettings().map((settings) => ({
        source: settings.path,
        key: "binding",
        label: settings.get_string("name") || "Custom shortcut",
        accelerators: [settings.get_string("binding")],
      })),
    ];
  }

  watch(callback) {
    this.destroy();
    for (const settings of [...this.settings, ...this.customSettings()]) {
      const signal = settings.connect("changed", (_settings, key) => {
        if (key === "custom-keybindings") this.watch(callback);
        callback();
      });
      this.signals.push([settings, signal]);
    }
  }

  destroy() {
    for (const [settings, signal] of this.signals) settings.disconnect(signal);
    this.signals = [];
  }
}
