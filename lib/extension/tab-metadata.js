import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Shell from "gi://Shell";
import { Logger } from "../shared/logger.js";
import { isWindowAlive } from "./mutter-safe.js";

// Exact desktop IDs avoid the browser/process heuristics that can associate
// several browser apps with the wrong application during startup.
export function resolveWindowApp(
  window,
  tracker = Shell.WindowTracker.get_default(),
  appSystem = Shell.AppSystem.get_default()
) {
  try {
    const wmClass = window.get_wm_class?.();
    const ids = [wmClass, window.get_gtk_application_id?.(), window.get_sandboxed_app_id?.()];
    for (const id of new Set(ids.filter(Boolean))) {
      const app = appSystem.lookup_app(id.endsWith(".desktop") ? id : `${id}.desktop`);
      if (app) return app;
    }
    for (const id of [window.get_wm_class_instance?.(), wmClass].filter(Boolean)) {
      const app = appSystem.lookup_startup_wmclass?.(id) || appSystem.lookup_desktop_wmclass?.(id);
      if (app) return app;
    }
    return tracker.get_window_app(window);
  } catch (_) {
    return null; // The window may have been unmanaged during the lookup.
  }
}

function disconnect(signals) {
  for (const [object, id] of signals.splice(0)) {
    try {
      object.disconnect(id);
    } catch (_) {} // A closing window can already have been finalized.
  }
}

// Tab content updates have their own event queue. They never render the tiling
// tree, move windows, change resize weights, or capture a saved layout.
export class TabMetadata {
  constructor(wm, { tracker, appSystem } = {}) {
    this.wm = wm;
    this.tracker = tracker;
    this.appSystem = appSystem;
    this.windows = new Map();
    this.pending = new Map();
    this.signals = [];
    this.enabled = false;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.tracker ??= Shell.WindowTracker.get_default();
    this.appSystem ??= Shell.AppSystem.get_default();
    this.signals.push(
      [this.tracker, this.tracker.connect("tracked-windows-changed", () => this.queueAll())],
      [this.appSystem, this.appSystem.connect("installed-changed", () => this.queueAll(true))]
    );
    for (const node of this.wm.tree.nodeWindows) this.watch(node);
  }

  watch(node) {
    const window = node.nodeValue;
    if (!this.enabled || !isWindowAlive(window)) return;
    if (!this.windows.has(window)) {
      const record = { signals: [], appSignals: [] };
      this.windows.set(window, record);
      for (const signal of ["notify::title", "notify::wm-class", "notify::gtk-application-id"])
        record.signals.push([window, window.connect(signal, () => this.queue(window))]);
      // Older Mutter versions expose a window icon. On current GNOME this
      // detailed notify signal is harmless, but there is no icon property.
      record.signals.push(
        [window, window.connect("notify::icon", () => this.queue(window, true))],
        [window, window.connect("unmanaged", () => this.unwatch(window))]
      );
    }
    this.queue(window);
  }

  queueAll(forceIcon = false) {
    for (const window of this.windows.keys()) this.queue(window, forceIcon);
  }

  queue(window, forceIcon = false) {
    if (!this.enabled || !this.windows.has(window)) return;
    this.pending.set(window, forceIcon || this.pending.get(window) || false);
    if (this.source) return;
    // Run after GNOME's window tracker has finished processing identity changes.
    this.source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      this.source = 0;
      this.flush();
      return GLib.SOURCE_REMOVE;
    });
  }

  flush() {
    const pending = [...this.pending];
    this.pending.clear();
    if (!this.enabled) return;
    for (const [window, forceIcon] of pending) {
      const record = this.windows.get(window);
      if (!record) continue;
      if (!isWindowAlive(window)) {
        this.unwatch(window);
        continue;
      }
      const node = this.wm.tree.findNode(window);
      if (!node) continue;
      try {
        const app = resolveWindowApp(window, this.tracker, this.appSystem);
        if (record.app !== app) {
          disconnect(record.appSignals);
          record.app = app;
          if (app)
            for (const signal of ["notify::icon", "notify::app-info"])
              record.appSignals.push([app, app.connect(signal, () => this.queue(window, true))]);
        }
        this.watchIconFile(record, window);
        node.app = app;
        node.refreshWindowTab(forceIcon);
        for (
          let parent = node.parentNode;
          parent && !parent.isMonitor();
          parent = parent.parentNode
        )
          if (parent.isCon() && parent.tab) this.wm.tree._updateConTab(parent, forceIcon);
      } catch (error) {
        if (isWindowAlive(window)) Logger.warn(`Unable to update tab content: ${error.message}`);
      }
    }
  }

  watchIconFile(record, window) {
    const file = record.app?.get_icon?.()?.get_file?.();
    const uri = file?.get_path() ? file.get_uri() : null;
    if (record.iconUri === uri) return;
    record.iconMonitor?.cancel();
    disconnect(record.fileSignals || []);
    record.iconMonitor = null;
    record.iconUri = uri;
    record.fileSignals = [];
    if (!uri) return;
    try {
      record.iconMonitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
      record.fileSignals.push([
        record.iconMonitor,
        record.iconMonitor.connect("changed", () => this.queue(window, true)),
      ]);
    } catch (_) {} // Unreadable icons still use GNOME's fallback texture.
  }

  unwatch(window) {
    const record = this.windows.get(window);
    if (!record) return;
    this.windows.delete(window);
    this.pending.delete(window);
    disconnect(record.signals);
    disconnect(record.appSignals);
    disconnect(record.fileSignals || []);
    record.iconMonitor?.cancel();
    if (!this.pending.size && this.source) {
      GLib.Source.remove(this.source);
      this.source = 0;
    }
  }

  disable() {
    this.enabled = false;
    disconnect(this.signals);
    for (const window of this.windows.keys()) this.unwatch(window);
    this.pending.clear();
  }
}
