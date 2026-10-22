import Shell from "gi://Shell";
import Meta from "gi://Meta";
import GLib from "gi://GLib";
import { InjectionManager } from "resource:///org/gnome/shell/extensions/extension.js";
import { Logger } from "../shared/logger.js";

// Launch requests are application-specific and short-lived. Never infer a
// launch from focus/pointer changes after a window has already appeared.
const REQUEST_LIFETIME = 15000000;

export class LaunchPlacement {
  constructor(wm) {
    this.wm = wm;
    this.requests = [];
    this.windows = new WeakMap();
    this.claims = new WeakMap();
    this.contexts = new Map();
    this.activeRequests = new Map();
  }

  enable() {
    if (this.injections) return;
    this.injections = new InjectionManager();
    const placement = this;
    for (const method of [
      "activate",
      "activate_full",
      "open_new_window",
      "launch",
      "launch_action",
    ]) {
      if (typeof Shell.App.prototype[method] !== "function") continue;
      this.injections.overrideMethod(
        Shell.App.prototype,
        method,
        (original) =>
          function (...args) {
            // Activating an existing app usually just focuses it. Explicit new-window
            // and desktop actions can still create a window in a running process.
            const id = this.get_id();
            const outer = placement.activeRequests.get(id);
            const request =
              outer ||
              (!["activate", "activate_full"].includes(method) || this.get_n_windows() === 0
                ? placement.remember(id)
                : null);
            if (request) placement.activeRequests.set(id, request);
            try {
              const result = original.apply(this, args);
              if (result === false) placement.forget(request);
              return result;
            } catch (error) {
              placement.forget(request);
              throw error;
            } finally {
              if (!outer) placement.activeRequests.delete(id);
            }
          }
      );
    }
    // Menus can launch DesktopAppInfo directly instead of using Shell.App.
    this.injections.overrideMethod(
      global,
      "create_app_launch_context",
      (original) =>
        function (...args) {
          const context = original.apply(this, args);
          const target = placement.target();
          const requests = new Map(placement.activeRequests);
          if (target) {
            const signal = context.connect("launch-started", (_, info) => {
              const id = info.get_id();
              if (!requests.has(id)) placement.remember(id, target);
              context.disconnect(signal);
              placement.contexts.delete(context);
            });
            placement.contexts.set(context, signal);
            if (placement.contexts.size > 64) {
              const [old, id] = placement.contexts.entries().next().value;
              old.disconnect(id);
              placement.contexts.delete(old);
            }
          }
          return context;
        }
    );
  }

  target() {
    if (!this.wm.ext.settings.get_boolean("tiling-mode-enabled") || this.wm.layouts?.transitioning)
      return null;
    const index = global.display.get_current_monitor();
    const monitor = this.wm.layouts?.monitors.find((item) => item.index === index);
    return monitor ? { id: monitor.id, time: GLib.get_monotonic_time() } : null;
  }

  remember(app, target = this.target()) {
    if (!app || !target) return null;
    const now = GLib.get_monotonic_time();
    this.requests = this.requests.filter((request) => now - request.time < REQUEST_LIFETIME);
    if (now - target.time >= REQUEST_LIFETIME) return null;
    const active = this.activeRequests.get(app);
    if (active) return active;
    const request = { app, ...target };
    this.requests.push(request);
    if (this.requests.length > 64) this.requests.shift();
    return request;
  }

  forget(request) {
    this.requests = this.requests.filter((item) => item !== request);
  }

  windowCreated(window) {
    if (window.get_transient_for?.() || window.get_window_type() !== Meta.WindowType.NORMAL) return;
    this.windows.set(window, GLib.get_monotonic_time());
    this.place(window, false);
  }

  waitingForIdentity(window) {
    const created = this.windows.get(window);
    if (this.claims.has(window)) return false;
    if (
      created === undefined ||
      !this.requests.some(
        (item) => item.time <= created && GLib.get_monotonic_time() - item.time < REQUEST_LIFETIME
      )
    )
      return false;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return !app || app.is_window_backed?.();
  }

  place(window, final = true) {
    const created = this.windows.get(window);
    if (
      created === undefined ||
      this.wm.layouts?.transitioning ||
      !this.wm.ext.settings.get_boolean("tiling-mode-enabled")
    )
      return false;
    const now = GLib.get_monotonic_time();
    if (now - created > REQUEST_LIFETIME || window.get_transient_for?.()) {
      this.windows.delete(window);
      this.claims.delete(window);
      return false;
    }
    let request = this.claims.get(window);
    if (!request) {
      const app = Shell.WindowTracker.get_default().get_window_app(window);
      if (!app) return false; // Retried once identity becomes available during tracking.
      const id = app.get_id();
      request = this.requests.find(
        (item) => item.app === id && item.time <= created && now - item.time < REQUEST_LIFETIME
      );
      if (!request) return false;
      this.forget(request);
      this.claims.set(window, request);
    }
    const monitor = this.wm.layouts?.monitors.find((item) => item.id === request.id);
    if (!monitor || final) {
      this.windows.delete(window);
      this.claims.delete(window);
    }
    if (!monitor) return false; // The launch display has since disconnected.
    Logger.debug(`Launch placement: monitor ${monitor.index}`);
    if (window.get_monitor() !== monitor.index) window.move_to_monitor(monitor.index);
    return true;
  }

  disable() {
    this.injections?.clear();
    this.injections = null;
    for (const [context, signal] of this.contexts) context.disconnect(signal);
    this.contexts.clear();
    this.requests = [];
    this.activeRequests.clear();
    this.windows = new WeakMap();
    this.claims = new WeakMap();
  }
}
