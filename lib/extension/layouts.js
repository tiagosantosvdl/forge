import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Logger } from "../shared/logger.js";
import {
  configurationKey,
  monitorIdentity,
  windowIdentity,
  layoutKeys,
  readState,
  mergeProfile,
  migrateProfile,
  projectLayout,
  fitLayout,
} from "../shared/layout-state.js";
import { Node, NODE_TYPES, LAYOUT_TYPES } from "./tree.js";

export class Layouts {
  constructor(wm) {
    this.wm = wm;
    this.monitors = [];
    this.state = { version: 1, configurations: {} };
    this.file = Gio.File.new_for_path(`${GLib.get_user_state_dir()}/forge/layouts.json`);
    this.generation = 0;
    this.pendingWindows = new Set();
    this.pendingParents = new Map();
    try {
      if (this.file.query_exists(null)) {
        const [, bytes] = this.file.load_contents(null);
        this.state = readState(JSON.parse(new TextDecoder().decode(bytes)));
      }
    } catch (error) {
      Logger.error(`Unable to load layouts: ${error.message}`);
    }
  }

  enable() {
    this.signal = Main.layoutManager.connect("monitors-changed", () => this.monitorsChanged());
    this.monitorsChanged();
  }

  disable() {
    this.disabled = true;
    this.generation++;
    if (this.signal) Main.layoutManager.disconnect(this.signal);
    for (const name of ["monitorSource", "restoreSource", "saveSource"]) this.cancel(name);
    this.write();
  }

  cancel(name) {
    if (this[name]) GLib.Source.remove(this[name]);
    this[name] = 0;
  }

  schedule(name, delay, callback) {
    this.cancel(name);
    this[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
      this[name] = 0;
      if (!this.disabled) callback();
      return GLib.SOURCE_REMOVE;
    });
  }

  geometryMatches() {
    const display = global.display;
    if (display.get_n_monitors() !== this.monitors.length) return false;
    return this.monitors.every((monitor) => {
      const rect = display.get_monitor_geometry(monitor.index);
      return ["x", "y", "width", "height"].every((key) => rect[key] === monitor[key]);
    });
  }

  monitorsChanged() {
    this.wm.cancelPendingMoves?.();
    // The latest stable snapshot was captured before Mutter moved any windows.
    this.transitioning = true;
    this.generation++;
    this.monitorFailures = 0;
    this.cancel("restoreSource");
    this.cancel("saveSource");
    this.write();
    this.schedule("monitorSource", 1500, () => this.refreshMonitors());
  }

  refreshMonitors() {
    const generation = this.generation;
    Gio.DBus.session.call(
      "org.gnome.Mutter.DisplayConfig",
      "/org/gnome/Mutter/DisplayConfig",
      "org.gnome.Mutter.DisplayConfig",
      "GetCurrentState",
      null,
      null,
      Gio.DBusCallFlags.NONE,
      3000,
      null,
      (connection, result) => {
        if (this.disabled || generation !== this.generation) return;
        try {
          const [, , logical] = connection.call_finish(result).deep_unpack();
          const monitors = Main.layoutManager.monitors.map((geometry) => {
            const output = logical.find(([x, y]) => x === geometry.x && y === geometry.y);
            if (!output) throw new Error("Display configuration is still changing");
            const specs = output[5];
            const ids = specs.map(monitorIdentity).sort();
            return { ...geometry, id: JSON.stringify(ids), primary: output[4] };
          });
          // Identical displays without unique serials need connector disambiguation.
          const ids = monitors.map((monitor) => monitor.id);
          for (const monitor of monitors) {
            if (ids.filter((id) => id === monitor.id).length > 1) {
              const output = logical.find(([x, y]) => x === monitor.x && y === monitor.y);
              monitor.id = JSON.stringify(output[5]);
            }
          }
          if (!monitors.length) throw new Error("No active displays");
          this.activate(monitors);
        } catch (error) {
          Logger.warn(`Waiting for monitor configuration: ${error.message}`);
          if (++this.monitorFailures >= 5 && Main.layoutManager.monitors.length) {
            Logger.error("Display identity lookup failed; using a separate fallback configuration");
            this.activate(
              Main.layoutManager.monitors.map((monitor) => ({
                ...monitor,
                id: `unidentified-display-${monitor.index}`,
                primary: monitor.index === global.display.get_primary_monitor(),
              }))
            );
            return;
          }
          this.schedule("monitorSource", 1500, () => this.refreshMonitors());
        }
      }
    );
  }

  activate(monitors) {
    if (this.wm.isDraggingWindow) {
      this.schedule("monitorSource", 500, () => this.activate(monitors));
      return;
    }
    const key = configurationKey(monitors);
    const previous = this.state.configurations[this.key || this.state.lastConfiguration];
    this.profile = this.state.configurations[key] || migrateProfile(previous, monitors);
    this.key = key;
    this.monitors = monitors;
    this.transitioning = false;
    this.restoring = true;
    try {
      // Keep Meta.Window nodes and their signal handlers; only monitor/group actors
      // are rebuilt. Indices may have changed even for an unchanged monitor set.
      this.rebuildMonitors();
      this.wm.trackCurrentWindows();
      this.apply();
      this.pendingWindows.clear();
      this.pendingParents.clear();
      Logger.info(`Restored layout for ${monitors.length} active display(s)`);
    } catch (error) {
      Logger.error(`Unable to restore layout: ${error.message}`);
    } finally {
      this.restoring = false;
      this.wm.renderTree("restore-monitor-configuration");
    }
  }

  rebuildMonitors() {
    const tree = this.wm.tree;
    const windows = [...tree.nodeWindows];
    for (const node of windows) {
      node.tab?.get_parent()?.remove_child(node.tab);
      if (node.parentNode) node.parentNode.childNodes.splice(node.index, 1);
      node.parentNode = null;
    }
    for (const workspace of tree.nodeWorkpaces) {
      this.destroyGroups(workspace);
      workspace.childNodes.length = 0;
      tree.addMonitor(Number(workspace.nodeValue.slice(2)));
    }
    tree._initWorkspaces();
    tree.attachNode = null;
    for (const node of windows) {
      const window = node.nodeValue;
      const workspace = window.get_workspace();
      if (!workspace) continue;
      const monitor =
        this.monitors.find((monitor) => monitor.index === window.get_monitor()) ||
        this.monitors.find((monitor) => monitor.primary) ||
        this.monitors[0];
      const index = Math.min(workspace.index(), global.workspace_manager.get_n_workspaces() - 1);
      const parent = tree.findNode(`mo${monitor.index}ws${index}`);
      parent?.appendChild(node);
    }
  }

  destroyGroups(node) {
    for (const child of node.childNodes) {
      if (child.isWindow()) continue;
      this.destroyGroups(child);
      child.tab?.destroy();
      child.decoration?.destroy();
      child.actorBin?.destroy();
      if (child.nodeType === NODE_TYPES.CON) child.actor?.destroy();
    }
  }

  windowTracked(window) {
    if (this.restoring || this.disabled) return;
    this.pendingWindows.add(window);
    const parent = this.wm.tree.findNode(window)?.parentNode;
    if (parent && !this.pendingParents.has(parent)) {
      this.pendingParents.set(
        parent,
        parent.childNodes
          .filter((child) => !this.pendingWindows.has(child.nodeValue))
          .map((child) => [child, child.percent])
      );
    }
    this.restoreAttempts = 0;
    this.schedule("restoreSource", 500, () => this.restoreWindows());
  }

  // Keep saved app slots aligned with the live workspace renumbering from PR #572
  // (mattchristenson): https://github.com/forge-ext/forge/pull/572
  workspaceRemoved(index) {
    const last = Math.max(0, global.workspace_manager.get_n_workspaces() - 1);
    const profiles = new Set([...Object.values(this.state.configurations), this.profile]);
    for (const profile of profiles) {
      if (!profile) continue;
      for (const monitor of profile.monitors) {
        const workspaces = new Map();
        for (const ws of monitor.workspaces) {
          const target =
            ws.index > index ? ws.index - 1 : ws.index === index ? Math.min(index, last) : ws.index;
          if (!workspaces.has(target)) workspaces.set(target, { index: target, tree: ws.tree });
          else {
            const existing = workspaces.get(target);
            existing.tree = { layout: "HSPLIT", children: [existing.tree, ws.tree] };
          }
        }
        monitor.workspaces = [...workspaces.values()];
      }
    }
    this.schedule("saveSource", 500, () => this.write());
  }

  restoreWindows() {
    if (this.transitioning || this.wm.isDraggingWindow || !this.profile) {
      this.schedule("restoreSource", 500, () => this.restoreWindows());
      return;
    }
    const unresolved = [...this.pendingWindows].some(
      (window) => this.wm.tree.findNode(window) && !windowIdentity(window)
    );
    if (unresolved && this.restoreAttempts++ < 10) {
      this.schedule("restoreSource", 500, () => this.restoreWindows());
      return;
    }
    this.restoring = true;
    try {
      // Only place newly tracked windows. Rebuilding every monitor here used to
      // replace live groups and session resize weights with a saved snapshot.
      const unplaced = new Set(this.pendingWindows);
      for (const window of this.pendingWindows) {
        const node = this.wm.tree.findNode(window);
        if (node && !node.isFloat() && windowIdentity(window)) this.placeWindow(node, unplaced);
        unplaced.delete(window);
      }
      for (const [parent, shares] of this.pendingParents) {
        if (
          parent.childNodes.length === shares.length &&
          shares.every(([child]) => parent.childNodes.includes(child))
        )
          for (const [child, percent] of shares) child.percent = percent;
      }
      this.pendingWindows.clear();
      this.pendingParents.clear();
    } catch (error) {
      Logger.error(`Unable to restore app groups: ${error.message}`);
    } finally {
      this.restoring = false;
      this.wm.renderTree("restore-app-groups");
    }
  }

  savedSlot(key) {
    const find = (saved) => {
      if (saved.key) return saved.key === key ? [saved] : null;
      for (const child of saved.children) {
        const path = find(child);
        if (path) return [saved, ...path];
      }
      return null;
    };
    for (const monitor of this.monitors) {
      const savedMonitor = this.profile?.monitors.find((item) => item.id === monitor.id);
      for (const ws of savedMonitor?.workspaces || []) {
        const path = find(ws.tree);
        if (!path) continue;
        const index = Math.min(ws.index, global.workspace_manager.get_n_workspaces() - 1);
        const parent = this.wm.tree.findNode(`mo${monitor.index}ws${index}`);
        if (parent) return { parent, path };
      }
    }
    return null;
  }

  placeWindow(node, unplaced) {
    const tree = this.wm.tree;
    const key = windowIdentity(node.nodeValue);
    // An app already open in this session defines its live slot, including a
    // placement deliberately changed since the last saved layout.
    const peers = tree.nodeWindows.filter(
      (other) =>
        other !== node &&
        !unplaced.has(other.nodeValue) &&
        !other.isFloat() &&
        windowIdentity(other.nodeValue) === key
    );
    const focused = tree.findNode(this.wm.focusMetaWindow);
    const peer = peers.includes(focused)
      ? focused
      : peers.sort(
          (a, b) =>
            (b.nodeValue.get_stable_sequence?.() || 0) - (a.nodeValue.get_stable_sequence?.() || 0)
        )[0];
    const slot = this.savedSlot(key);
    if (!peer && !slot) return; // Keep normal tiling for apps without a saved slot.

    node.tab?.get_parent()?.remove_child(node.tab);
    let source = node.parentNode;
    source?.removeChild(node);
    while (source?.nodeType === NODE_TYPES.CON && source.childNodes.length === 0) {
      const parent = source.parentNode;
      parent.removeChild(source);
      tree._forgetRemoved(source);
      source = parent;
    }

    const newGroup = (saved) => {
      const group = new Node(NODE_TYPES.CON, new St.Bin());
      group.settings = tree.settings;
      group.layout = LAYOUT_TYPES[saved.layout];
      group.splitLayout = saved.splitLayout;
      return group;
    };
    const wrap = (parent, group, branch) => {
      const share = this.pendingParents.get(parent)?.find(([child]) => child === branch);
      group.percent = share ? share[1] : branch.percent;
      // The wrapper still occupies the original child's space in this session.
      if (share) share[0] = group;
      parent.insertBefore(group, branch);
      group.appendChild(branch);
      branch.percent = 0;
    };
    let destination;
    if (peer) {
      destination = peer.parentNode;
      if (!destination.isTabbed() && !destination.isStacked()) {
        const group = newGroup({ layout: "TABBED" });
        wrap(destination, group, peer);
        destination = group;
      }
      destination.appendChild(node);
    } else {
      destination = slot.parent;
      const branchFor = (parent, keys) =>
        parent.childNodes.find((child) =>
          (child.isWindow() ? [child] : child.getNodeByType(NODE_TYPES.WINDOW)).some((window) =>
            keys.includes(windowIdentity(window.nodeValue))
          )
        );
      const insert = (parent, savedParent, saved, child) => {
        const following = savedParent?.children.slice(savedParent.children.indexOf(saved) + 1);
        const reference = branchFor(parent, (following || []).flatMap(layoutKeys));
        parent.insertBefore(child, reference || null);
      };
      for (let index = 0; index < slot.path.length - 1; index++) {
        const saved = slot.path[index];
        const branch = branchFor(destination, layoutKeys(saved));
        // A saved split may have become tabs to fit a smaller display. Keep
        // using those tabs as its missing apps reopen.
        if (
          branch?.isTabbed() &&
          branch.collapsedSplit &&
          ["HSPLIT", "VSPLIT"].includes(saved.layout) &&
          destination.childNodes.length === 1
        ) {
          destination = branch;
          break;
        }
        // Full restoration flattens a split root into its monitor node.
        if (index === 0 && destination.layout === LAYOUT_TYPES[saved.layout]) continue;
        if (branch?.isCon() && branch.layout === LAYOUT_TYPES[saved.layout]) {
          destination = branch;
        } else {
          const group = newGroup(saved);
          if (branch) {
            wrap(destination, group, branch);
          } else {
            insert(destination, slot.path[index - 1], saved, group);
            tree.resetSiblingPercent(destination);
          }
          destination = group;
        }
      }
      insert(destination, slot.path.at(-2), slot.path.at(-1), node);
      if (destination.isHSplit() || destination.isVSplit()) tree.resetSiblingPercent(destination);
    }
    node.percent = 0;
    let monitor = destination;
    while (monitor && monitor.nodeType !== NODE_TYPES.MONITOR) monitor = monitor.parentNode;
    const match = monitor?.nodeValue.match(/^mo(\d+)ws(\d+)$/);
    if (match) {
      const workspace = global.workspace_manager.get_workspace_by_index(Number(match[2]));
      const window = node.nodeValue;
      if (window.get_workspace() !== workspace) window.change_workspace(workspace);
      if (window.get_monitor() !== Number(match[1])) window.move_to_monitor(Number(match[1]));
    }
  }

  capture() {
    const seen = new Set();
    const preferred = new Map();
    for (const node of [...this.wm.tree.nodeWindows].sort(
      (a, b) =>
        (a.nodeValue.get_stable_sequence?.() || 0) - (b.nodeValue.get_stable_sequence?.() || 0)
    )) {
      const key = windowIdentity(node.nodeValue);
      if (key && !node.isFloat()) preferred.set(key, node);
    }
    const focus = this.wm.tree.findNode(this.wm.focusMetaWindow);
    if (focus && !focus.isFloat()) preferred.set(windowIdentity(focus.nodeValue), focus);
    const serialize = (node, savedRoot) => {
      if (!node) return { layout: "HSPLIT", children: [] };
      if (node.isWindow()) {
        if (node.isFloat()) return null;
        const key = windowIdentity(node.nodeValue);
        if (!key || seen.has(key) || preferred.get(key) !== node) return null;
        seen.add(key);
        return { key };
      }
      const children = [...node.childNodes]
        .reverse()
        .map((child) => serialize(child))
        .filter(Boolean)
        .reverse();
      if (
        node.nodeType === NODE_TYPES.CON &&
        children.length === 1 &&
        node.childNodes.length > 1 &&
        node.childNodes.every(
          (child) => child.isWindow() && windowIdentity(child.nodeValue) === children[0].key
        )
      )
        return children[0];
      // A temporarily empty sibling must not turn a saved split into its sole
      // surviving tabbed group. Only unwrap a legacy group root that was saved
      // without the monitor's split wrapper in the first place.
      if (
        node.nodeType === NODE_TYPES.MONITOR &&
        children.length === 1 &&
        ["TABBED", "STACKED"].includes(savedRoot?.layout) &&
        children[0].layout === savedRoot.layout
      )
        return children[0];
      return {
        layout: LAYOUT_TYPES[node.layout] || node.layout,
        splitLayout: node.splitLayout,
        children,
      };
    };
    // Only the last occurrence of an app/profile is saved. Multiple ordinary Edge
    // windows are subsequently placed together in that saved slot.
    return {
      monitors: [...this.monitors]
        .reverse()
        .map((monitor) => ({
          id: monitor.id,
          workspaces: [...this.wm.tree.nodeWorkpaces].reverse().map((workspace) => ({
            index: Number(workspace.nodeValue.slice(2)),
            tree: serialize(
              this.wm.tree.findNode(`mo${monitor.index}ws${workspace.nodeValue.slice(2)}`),
              this.profile?.monitors
                .find((saved) => saved.id === monitor.id)
                ?.workspaces.find((ws) => ws.index === Number(workspace.nodeValue.slice(2)))?.tree
            ),
          })),
        }))
        .reverse(),
    };
  }

  rendered() {
    if (this.disabled || this.restoring || this.transitioning || this.restoreSource || !this.key)
      return;
    if (!this.geometryMatches()) {
      this.monitorsChanged();
      return;
    }
    try {
      this.profile = mergeProfile(this.profile, this.capture());
      this.state.configurations[this.key] = this.profile;
      this.state.lastConfiguration = this.key;
      this.schedule("saveSource", 500, () => this.write());
    } catch (error) {
      Logger.error(`Unable to capture layout: ${error.message}`);
    }
  }

  write() {
    try {
      this.file.get_parent().make_directory_with_parents(null);
    } catch (error) {
      if (!error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS)) {
        Logger.error(`Unable to create layout directory: ${error.message}`);
        return;
      }
    }
    try {
      this.file.replace_contents(
        JSON.stringify(this.state),
        null,
        true,
        Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
      );
    } catch (error) {
      Logger.error(`Unable to save layouts: ${error.message}`);
    }
  }

  apply() {
    this.wm.cancelPendingMoves?.();
    const wm = this.wm;
    const tree = wm.tree;
    const available = new Map();
    for (const node of tree.nodeWindows) {
      if (node.isFloat()) continue;
      const key = windowIdentity(node.nodeValue);
      if (!key) continue;
      if (!available.has(key)) available.set(key, []);
      available.get(key).push(node);
    }
    const assigned = new Set();
    const build = (saved, parent) => {
      if (saved.key) {
        let destination = parent;
        if (saved.windows.length > 1) {
          destination = new Node(NODE_TYPES.CON, new St.Bin());
          destination.settings = tree.settings;
          destination.layout = LAYOUT_TYPES.TABBED;
          parent.appendChild(destination);
        }
        for (const node of saved.windows) {
          node.tab?.get_parent()?.remove_child(node.tab);
          node.percent = 0;
          destination.appendChild(node);
          assigned.add(node);
        }
      } else {
        const container = new Node(NODE_TYPES.CON, new St.Bin());
        container.settings = tree.settings;
        container.layout = LAYOUT_TYPES[saved.layout];
        container.collapsedSplit = saved.collapsedSplit;
        // mattchristenson, upstream PR #567: retain the split direction across sessions too.
        // https://github.com/forge-ext/forge/pull/567
        container.splitLayout = ["HSPLIT", "VSPLIT"].includes(saved.splitLayout)
          ? saved.splitLayout
          : undefined;
        parent.appendChild(container);
        for (const child of saved.children) build(child, container);
      }
    };
    const plans = [];
    for (const monitor of this.monitors) {
      const savedMonitor = this.profile.monitors.find((item) => item.id === monitor.id);
      for (let index = 0; index < global.workspace_manager.get_n_workspaces(); index++) {
        const parent = tree.findNode(`mo${monitor.index}ws${index}`);
        if (!parent) continue;
        const children = (savedMonitor?.workspaces || [])
          .filter(
            (ws) => Math.min(ws.index, global.workspace_manager.get_n_workspaces() - 1) === index
          )
          .map((ws) => projectLayout(ws.tree, available))
          .filter(Boolean);
        plans.push({ monitor, index, parent, children });
      }
    }
    // Windows opened in another configuration have no saved slot here. Place
    // them together by app in their current workspace on an active display.
    const primary = this.monitors.find((monitor) => monitor.primary) || this.monitors[0];
    for (const [key, windows] of available) {
      const window = windows[0].nodeValue;
      const index = window.get_workspace()?.index() || 0;
      const monitor = this.monitors.find((item) => item.index === window.get_monitor()) || primary;
      const plan =
        plans.find((item) => item.monitor === monitor && item.index === index) || plans[0];
      if (plan) plan.children.push({ key, windows });
    }
    // Detach all windows before destroying decorations on any monitor. A matched
    // window can move from a monitor which is rebuilt later in this loop.
    const detached = [...tree.nodeWindows];
    for (const node of detached) {
      node.tab?.get_parent()?.remove_child(node.tab);
      if (node.parentNode) node.parentNode.childNodes.splice(node.index, 1);
      node.parentNode = null;
    }
    for (const plan of plans) {
      const { monitor, index, parent, children } = plan;
      const area = global.workspace_manager
        .get_workspace_by_index(index)
        .get_work_area_for_monitor(monitor.index);
      const minimumSize = (leaf) => {
        let width = 240;
        let height = 160;
        for (const node of leaf.windows) {
          try {
            const size = node.nodeValue.get_min_size?.();
            const [w, h] = size?.length === 3 ? size.slice(1) : size || [400, 240];
            width = Math.max(width, w + 16);
            height = Math.max(height, h + 56);
          } catch (_) {}
        }
        return { width, height };
      };
      const projected =
        children.length === 1 && !children[0].key ? children[0] : { layout: "HSPLIT", children };
      const fitted = fitLayout(projected, area.width, area.height, minimumSize);
      // Remove old decorations only after matching the saved windows.
      this.destroyGroups(parent);
      parent.childNodes.length = 0;
      parent.layout = LAYOUT_TYPES.HSPLIT;
      if (["HSPLIT", "VSPLIT"].includes(fitted.layout)) {
        parent.layout = LAYOUT_TYPES[fitted.layout];
        for (const child of fitted.children) build(child, parent);
      } else if (fitted.children.length) build(fitted, parent);
    }
    // Floating and not-yet-identified windows retain their current monitor.
    for (const node of detached) {
      if (assigned.has(node)) continue;
      const window = node.nodeValue;
      const monitor = this.monitors.find((item) => item.index === window.get_monitor()) || primary;
      tree
        .findNode(`mo${monitor.index}ws${window.get_workspace()?.index() || 0}`)
        ?.appendChild(node);
    }
    for (const node of assigned) {
      let ancestor = node.parentNode;
      while (ancestor && ancestor.nodeType !== NODE_TYPES.MONITOR) ancestor = ancestor.parentNode;
      const match = ancestor?.nodeValue.match(/^mo(\d+)ws(\d+)$/);
      if (!match) continue;
      const window = node.nodeValue;
      const workspace = global.workspace_manager.get_workspace_by_index(Number(match[2]));
      if (window.get_workspace() !== workspace) window.change_workspace(workspace);
      if (window.get_monitor() !== Number(match[1])) window.move_to_monitor(Number(match[1]));
    }
    tree.attachNode = null;
  }
}
