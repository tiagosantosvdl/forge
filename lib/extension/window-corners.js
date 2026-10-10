import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";

import { WindowCornerEffect } from "./window-corner-effect.js";
import {
  normalizeRadius,
  gtkCornerCss,
  qtCornerCss,
  replaceCornerBlock,
  updateQtStylesheets,
  cornerGeometry,
  CSS_BEGIN,
} from "../shared/window-corners.js";

const EFFECT_NAME = "forge-window-corners";

export class WindowCorners {
  constructor(extension, configDir = GLib.get_user_config_dir()) {
    this.extension = extension;
    this.configDir = configDir;
    this.actors = new Map();
    this.signals = [];
    this.monitors = [];
    this.qtState = {};
    this.statePath = GLib.build_filenamev([configDir, "forge", "window-corners.json"]);
    this.qssPath = GLib.build_filenamev([configDir, "forge", "window-corners.qss"]);
  }

  enable() {
    this.active = true;
    try {
      const saved = this._read(this.statePath);
      if (saved) {
        const state = JSON.parse(saved.contents);
        if (!state || typeof state !== "object" || Array.isArray(state)) {
          throw new Error("Invalid window corner ownership state");
        }
        this.qtState = state;
      }
    } catch (error) {
      console.warn(`Forge: cannot read window corner state: ${error.message}`);
    }
    this.refresh();
    this._connect(global.display, "window-created", (_display, window) => {
      this._track(window.get_compositor_private());
    });
    // Some clients do not have an actor when window-created is emitted.
    this._connect(global.window_manager, "map", (_wm, actor) => this._track(actor));
    for (const actor of global.get_window_actors()) this._track(actor);
    for (const toolkit of ["gtk-3.0", "gtk-4.0", "qt5ct", "qt6ct"]) {
      const directory = Gio.File.new_for_path(GLib.build_filenamev([this.configDir, toolkit]));
      if (!directory.query_exists(null)) continue;
      try {
        const monitor = directory.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        monitor.connect("changed", () => this._queueThemeUpdate());
        this.monitors.push(monitor);
      } catch (error) {
        console.warn(`Forge: cannot watch ${toolkit}: ${error.message}`);
      }
    }
  }

  _connect(object, signal, callback, list = this.signals) {
    list.push([object, object.connect(signal, callback)]);
  }

  refresh() {
    if (!this.active) return;
    this.radius = normalizeRadius(
      this.extension.theme.getCssProperty(".window-tiled-border", "border-radius").value
    );
    for (const actor of this.actors.keys()) this._update(actor);
    this._updateThemes();
  }

  _track(actor) {
    if (!actor || this.actors.has(actor)) return;
    const window = actor.meta_window;
    if (
      !window ||
      ![Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG].includes(
        window.get_window_type()
      )
    ) {
      return;
    }
    const entry = { window, signals: [], effect: null };
    this.actors.set(actor, entry);
    const update = () => this._update(actor);
    this._connect(actor, "destroy", () => this._untrack(actor, true), entry.signals);
    this._connect(actor, "notify::allocation", update, entry.signals);
    for (const signal of [
      "size-changed",
      "position-changed",
      "notify::fullscreen",
      "notify::maximized-horizontally",
      "notify::maximized-vertically",
    ]) {
      this._connect(window, signal, update, entry.signals);
    }
    update();
  }

  _update(actor) {
    const entry = this.actors.get(actor);
    if (!entry) return;
    try {
      const window = entry.window;
      const geometry = cornerGeometry(
        window.get_frame_rect(),
        window.get_buffer_rect(),
        actor.width,
        actor.height,
        this.radius
      );
      const maximized = window.is_maximized
        ? window.is_maximized()
        : window.get_maximized() === Meta.MaximizeFlags.BOTH;
      const rounded = this.radius > 0 && !window.is_fullscreen() && !maximized && geometry;
      if (!rounded) {
        entry.effect?.set_enabled(false);
        return;
      }
      if (!entry.effect) {
        entry.effect = new WindowCornerEffect();
        actor.add_effect_with_name(EFFECT_NAME, entry.effect);
      }
      entry.effect.update(geometry);
      entry.effect.set_enabled(true);
      actor.queue_redraw();
    } catch (error) {
      console.warn(`Forge: cannot round window: ${error.message}`);
      // A failed update must not leave a mask using the old window geometry.
      entry.effect?.set_enabled(false);
    }
  }

  _untrack(actor, destroying = false) {
    const entry = this.actors.get(actor);
    if (!entry) return;
    this.actors.delete(actor);
    for (const [object, id] of entry.signals) {
      object.disconnect(id);
    }
    if (!destroying && entry.effect) actor.remove_effect(entry.effect);
  }

  _read(path) {
    const file = Gio.File.new_for_path(path);
    try {
      const [, bytes, etag] = file.load_contents(null);
      return { contents: new TextDecoder().decode(bytes), etag };
    } catch (error) {
      if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)) return null;
      throw error;
    }
  }

  _write(path, contents, current) {
    if (current?.contents === contents) return;
    const file = Gio.File.new_for_path(path);
    if (GLib.mkdir_with_parents(file.get_parent().get_path(), 0o700) !== 0) {
      throw new Error(`Cannot create ${file.get_parent().get_path()}`);
    }
    file.replace_contents(contents, current?.etag ?? null, false, Gio.FileCreateFlags.NONE, null);
  }

  _queueThemeUpdate() {
    if (!this.active || this.themeSource) return;
    this.themeSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      this.themeSource = 0;
      this._updateThemes();
      return GLib.SOURCE_REMOVE;
    });
  }

  _updateThemes(enabled = true) {
    let cleanupFailed = false;
    for (const version of [3, 4]) {
      const path = GLib.build_filenamev([this.configDir, `gtk-${version}.0`, "gtk.css"]);
      try {
        const current = this._read(path);
        if (!enabled && !current?.contents.includes(CSS_BEGIN)) continue;
        if (enabled && !current) {
          this.qtState.createdGtkFiles ??= [];
          if (!this.qtState.createdGtkFiles.includes(path)) {
            this.qtState.createdGtkFiles.push(path);
            this._write(this.statePath, JSON.stringify(this.qtState), this._read(this.statePath));
          }
        }
        const contents = replaceCornerBlock(
          current?.contents ?? "",
          enabled ? gtkCornerCss(this.radius, version) : null
        );
        if (!enabled && !contents && this.qtState.createdGtkFiles?.includes(path)) {
          Gio.File.new_for_path(path).delete(null);
        } else this._write(path, contents, current);
      } catch (error) {
        cleanupFailed = true;
        console.warn(`Forge: cannot update GTK ${version} corners: ${error.message}`);
      }
    }

    if (enabled) {
      try {
        this._write(this.qssPath, qtCornerCss(this.radius), this._read(this.qssPath));
      } catch (error) {
        console.warn(`Forge: cannot write Qt corners: ${error.message}`);
        return;
      }
    }
    for (const toolkit of ["qt5ct", "qt6ct"]) {
      const path = GLib.build_filenamev([this.configDir, toolkit, `${toolkit}.conf`]);
      try {
        const current = this._read(path);
        // Do not switch the user's Qt platform theme or create a replacement
        // configuration. Register the override with existing qt5ct/qt6ct setups.
        if (!current) continue;
        const result = updateQtStylesheets(
          current.contents,
          this.qssPath,
          enabled,
          this.qtState[toolkit]
        );
        if (enabled) {
          this.qtState[toolkit] = result.previous;
          // Journal ownership before changing the application configuration so
          // cleanup can still restore its key after a Shell restart.
          this._write(this.statePath, JSON.stringify(this.qtState), this._read(this.statePath));
        }
        this._write(path, result.contents, current);
      } catch (error) {
        cleanupFailed = true;
        console.warn(`Forge: cannot update ${toolkit} corners: ${error.message}`);
      }
    }
    if (!enabled) {
      for (const path of cleanupFailed ? [this.qssPath] : [this.qssPath, this.statePath]) {
        try {
          if (this._read(path)) Gio.File.new_for_path(path).delete(null);
        } catch (error) {
          console.warn(`Forge: cannot remove ${path}: ${error.message}`);
        }
      }
    }
  }

  disable() {
    this.active = false;
    if (this.themeSource) GLib.Source.remove(this.themeSource);
    this.themeSource = 0;
    for (const monitor of this.monitors) monitor.cancel();
    this.monitors = [];
    for (const [object, id] of this.signals) object.disconnect(id);
    this.signals = [];
    for (const actor of this.actors.keys()) this._untrack(actor);
    this._updateThemes(false);
    this.extension = null;
  }
}
