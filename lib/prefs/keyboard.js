// Gnome imports
import Adw from "gi://Adw";
import GObject from "gi://GObject";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";

// Extension Imports
import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// Prefs UI
import { PreferencesPage, RadioRow } from "./widgets.js";
import { findShortcutConflicts } from "../shared/shortcut-conflicts.js";
import { shortcutRecords, SystemShortcuts } from "../shared/shortcut-settings.js";

export class KeyboardPage extends PreferencesPage {
  static {
    GObject.registerClass(this);
  }

  constructor({ kbdSettings, window }) {
    super({ title: _("Keyboard"), icon_name: "input-keyboard-symbolic" });
    this.kbdSettings = kbdSettings;
    this.window = window;
    this.rows = new Map();
    this.systemShortcuts = new SystemShortcuts();

    const apply = new Gtk.Button({
      label: _("Apply recommended shortcuts"),
      valign: Gtk.Align.CENTER,
    });
    apply.connect("clicked", () => this._confirmRecommended());
    this.status = new Adw.ActionRow({
      title: _("Shortcut conflicts"),
      use_markup: false,
      subtitle: _("No conflicts found."),
    });
    this.add_group({
      title: _("Recommended shortcuts"),
      description: _(
        "Apply the recommended bindings to replace all saved Forge keyboard shortcuts. The drag-and-drop modifier is kept."
      ),
      children: [this.status],
      header_suffix: apply,
    });

    this.add_group({
      title: _("Drag-and-drop modifier key"),
      description: _(
        "Change the modifier key for tiling windows via drag-and-drop. Select 'None' to always tile"
      ),
      children: [
        new RadioRow({
          title: _("Modifier key"),
          settings: kbdSettings,
          bind: "mod-mask-mouse-tile",
          options: {
            Super: _("Super"),
            Ctrl: _("Ctrl"),
            Alt: _("Alt"),
            None: _("None"),
          },
        }),
      ],
    });
    this.add_group({
      title: _("Shortcuts"),
      description: _(
        'Enter shortcuts separated by commas, then press Enter or the apply button. Clear a shortcut to disable it. Conflicts with GNOME and other Forge actions must be resolved before applying. <a href="https://github.com/forge-ext/forge/wiki/Keyboard-Shortcuts">Syntax examples</a>'
      ),
      children: Object.entries({
        window: "Tiling shortcuts",
        con: "Container shortcuts",
        workspace: "Workspace shortcuts",
        focus: "Appearance shortcuts",
        prefs: "Other shortcuts",
      }).map(([prefix, gettextKey]) => this.makeKeygroupExpander(prefix, gettextKey)),
    });
    this._settingsSignal = kbdSettings.connect("changed", (_settings, key) => {
      const record = this.rows.get(key);
      if (record) {
        const saved = kbdSettings.get_strv(key).join(",");
        if (record.row.get_text() === record.saved) record.row.set_text(saved);
        record.saved = saved;
      }
      this._updateWarnings();
    });
    this.systemShortcuts.watch(() => this._updateWarnings());
    window.connect("close-request", () => {
      if (this._settingsSignal) kbdSettings.disconnect(this._settingsSignal);
      this._settingsSignal = 0;
      this.systemShortcuts.destroy();
      return false;
    });
    this._updateWarnings();
  }

  makeKeygroupExpander(prefix, gettextKey) {
    const settings = this.kbdSettings;
    const expander = new Adw.ExpanderRow({ title: _(gettextKey) });
    KeyboardPage.createKeyList(settings, prefix).forEach((key) => {
      const title = settings.settings_schema.get_key(key).get_summary() || key.replaceAll("-", " ");
      const row = new Adw.EntryRow({ title: _(title), use_markup: false, show_apply_button: true });
      const saved = settings.get_strv(key).join(",");
      row.set_text(saved);
      const warning = new Gtk.Image({ icon_name: "dialog-warning-symbolic", visible: false });
      row.add_suffix(warning);
      this.rows.set(key, { row, saved, warning });
      row.connect("changed", () => this._updateWarnings());
      row.connect("apply", () => this._commit(key));
      row.connect("entry-activated", () => this._commit(key));
      for (const [icon, tooltip, value] of [
        ["edit-clear-symbolic", _("Clear shortcut"), () => []],
        [
          "edit-undo-symbolic",
          _("Use recommended shortcut"),
          () => settings.get_default_value(key).deep_unpack(),
        ],
      ]) {
        const button = new Gtk.Button({
          icon_name: icon,
          tooltip_text: tooltip,
          valign: Gtk.Align.CENTER,
        });
        button.add_css_class("flat");
        button.connect("clicked", () => {
          row.set_text(value().join(","));
          this._commit(key);
        });
        row.add_suffix(button);
      }
      expander.add_row(row);
    });
    return expander;
  }

  _records() {
    return [...shortcutRecords(this.kbdSettings), ...this.systemShortcuts.records()];
  }

  _conflictMessages(accelerators, records, key) {
    return findShortcutConflicts(accelerators, records, { source: "forge", key }).map((conflict) =>
      conflict.kind === "duplicate"
        ? _("This shortcut is listed more than once.")
        : `${conflict.accelerator}: ${_("Already used by")} ${
            conflict.source === "forge" ? _("Forge") : _("GNOME")
          } — ${conflict.label}`
    );
  }

  _validate(key, text, records) {
    const accelerators = [];
    if (text.trim()) {
      for (const value of text.split(",")) {
        const [ok, keyval, modifiers] = Gtk.accelerator_parse(value.trim());
        if (!ok || !Gtk.accelerator_valid(keyval, modifiers))
          return {
            accelerators: [],
            errors: [_("Invalid shortcut. Use a combination such as <Super><Alt>h.")],
          };
        accelerators.push(Gtk.accelerator_name(keyval, modifiers));
      }
    }
    return { accelerators, errors: this._conflictMessages(accelerators, records, key) };
  }

  _updateWarnings() {
    const records = this._records();
    const problems = [];
    for (const [key, { row, warning }] of this.rows) {
      const { errors } = this._validate(key, row.get_text(), records);
      warning.visible = errors.length > 0;
      warning.set_tooltip_text(errors.join("\n"));
      row.set_tooltip_text(errors.length ? errors.join("\n") : null);
      if (errors.length) {
        row.add_css_class("error");
        problems.push(`${row.title}: ${errors.join("; ")}`);
      } else {
        row.remove_css_class("error");
      }
    }
    this.status.subtitle = problems.length ? problems.join("\n") : _("No conflicts found.");
  }

  _commit(key) {
    const record = this.rows.get(key);
    const { accelerators, errors } = this._validate(key, record.row.get_text(), this._records());
    if (errors.length) {
      this.window.add_toast(
        new Adw.Toast({ title: _("Choose a valid, unused shortcut before applying.") })
      );
      return;
    }
    if (!this.kbdSettings.set_strv(key, accelerators)) {
      this.window.add_toast(new Adw.Toast({ title: _("Unable to save this shortcut.") }));
      return;
    }
    record.saved = accelerators.join(",");
    record.row.set_text(record.saved);
    this._updateWarnings();
  }

  _recommendedProblems() {
    const recommended = shortcutRecords(this.kbdSettings, "forge", true);
    const records = [...recommended, ...this.systemShortcuts.records()];
    return recommended.flatMap(({ key, label, accelerators }) =>
      this._conflictMessages(accelerators, records, key).map((message) => `${label}: ${message}`)
    );
  }

  _confirmRecommended() {
    const problems = this._recommendedProblems();
    const dialog = new Adw.MessageDialog({
      transient_for: this.window,
      modal: true,
      heading: problems.length
        ? _("Recommended shortcuts have conflicts")
        : _("Replace Forge shortcuts?"),
      body: problems.length
        ? problems.join("\n")
        : _(
            "This replaces all saved Forge keyboard shortcuts with the recommended defaults. Your drag-and-drop modifier is kept."
          ),
    });
    dialog.add_response("cancel", _("Cancel"));
    dialog.set_close_response("cancel");
    dialog.set_default_response("cancel");
    if (!problems.length) {
      dialog.add_response("apply", _("Apply recommended shortcuts"));
      dialog.set_response_appearance("apply", Adw.ResponseAppearance.DESTRUCTIVE);
      dialog.connect("response::apply", () => this._applyRecommended());
    }
    dialog.present();
  }

  _applyRecommended() {
    // Recheck in case GNOME shortcuts changed while the confirmation was open.
    if (this._recommendedProblems().length) {
      this._confirmRecommended();
      return;
    }
    const settings = new Gio.Settings({ settings_schema: this.kbdSettings.settings_schema });
    const keys = shortcutRecords(settings).map(({ key }) => key);
    if (keys.some((key) => !settings.is_writable(key))) {
      this.window.add_toast(
        new Adw.Toast({ title: _("Some shortcuts are locked by your administrator.") })
      );
      return;
    }
    settings.delay();
    for (const key of keys) settings.reset(key);
    settings.apply();
    for (const [key, record] of this.rows) {
      record.saved = this.kbdSettings.get_strv(key).join(",");
      record.row.set_text(record.saved);
    }
    this._updateWarnings();
    this.window.add_toast(new Adw.Toast({ title: _("Recommended shortcuts applied.") }));
  }

  static createKeyList(settings, categoryName) {
    return settings
      .list_keys()
      .filter((keyName) => !!keyName && !!categoryName && keyName.startsWith(categoryName))
      .sort((a, b) => {
        const aUp = a.toUpperCase();
        const bUp = b.toUpperCase();
        if (aUp < bUp) return -1;
        if (aUp > bUp) return 1;
        return 0;
      });
  }
}
