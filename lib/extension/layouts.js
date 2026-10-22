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
  readMonitorState,
  mergeProfile,
  projectLayout,
  fitLayout,
  normalizeLayout,
} from "../shared/layout-state.js";
import { Node, NODE_TYPES, LAYOUT_TYPES } from "./tree.js";

export class Layouts {
  constructor(wm) {
    this.wm = wm;
    this.monitors = [];
    this.state = { version: 2, monitors: {} };
    this.fallbackHomes = new Map();
    this.fallbackLocations = new Map();
    this.temporaryWindows = new Set();
    this.file = Gio.File.new_for_path(`${GLib.get_user_state_dir()}/forge/layouts.json`);
    this.generation = 0;
    this.pendingWindows = new Set();
    this.pendingParents = new Map();
    try {
      if (this.file.query_exists(null)) {
        const [, bytes] = this.file.load_contents(null);
        this.state = readMonitorState(JSON.parse(new TextDecoder().decode(bytes)));
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
    const previousMonitors = this.monitors;
    const liveChange = !!this.key;
    const surviving = new Set(
      monitors
        .filter((monitor) => previousMonitors.some((old) => old.id === monitor.id))
        .map((monitor) => monitor.id)
    );
    this.profile = {
      monitors: monitors.map(({ id }) => this.state.monitors[id] || { id, workspaces: [] }),
    };
    this.key = key;
    this.monitors = monitors;
    this.transitioning = false;
    this.restoring = true;
    try {
      // Keep Meta.Window nodes and their signal handlers; only monitor/group actors
      // are rebuilt. Indices may have changed even for an unchanged monitor set.
      const displaced = this.rebuildMonitors(liveChange ? previousMonitors : []);
      this.wm.trackCurrentWindows();
      if (liveChange) {
        for (const [window, home] of this.fallbackHomes) {
          const node = this.wm.tree.findNode(window);
          if (!node) {
            this.windowClosed(window);
          } else if (monitors.some((monitor) => monitor.id === home)) displaced.add(node);
        }
        this.relocateWindows(displaced);
        this.apply({
          onlyMonitors: new Set(monitors.filter((m) => !surviving.has(m.id)).map((m) => m.id)),
        });
        const unplaced = new Set([...displaced].map((node) => node.nodeValue));
        for (const node of displaced) {
          const parent = this.wm.tree.findAncestorMonitor(node);
          const monitor = monitors.find((m) => parent?.nodeValue.startsWith(`mo${m.index}ws`));
          if (surviving.has(monitor?.id) && !node.isFloat()) this.placeWindow(node, unplaced);
          unplaced.delete(node.nodeValue);
        }
      } else this.apply();
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

  rebuildMonitors(previous = []) {
    const tree = this.wm.tree;
    const displaced = new Set();
    const detached = [];
    for (const workspace of tree.nodeWorkpaces) {
      const retained = new Map();
      for (const parent of [...workspace.childNodes]) {
        const index = Number(parent.nodeValue.match(/^mo(\d+)/)?.[1]);
        const old = previous.find((monitor) => monitor.index === index);
        const current = this.monitors.find((monitor) => monitor.id === old?.id);
        if (current) {
          retained.set(current.id, parent);
          parent._data = `mo${current.index}ws${workspace.nodeValue.slice(2)}`;
          // Mutter may have reassigned indices before the monitor signal arrived.
          for (const node of parent.getNodeByType(NODE_TYPES.WINDOW)) {
            if (node.nodeValue.get_monitor() !== current.index)
              node.nodeValue.move_to_monitor(current.index);
          }
        } else {
          for (const node of [...parent.getNodeByType(NODE_TYPES.WINDOW)]) {
            node.tab?.get_parent()?.remove_child(node.tab);
            node.parentNode.removeChild(node);
            detached.push(node);
            if (old) {
              displaced.add(node);
              if (!this.fallbackHomes.has(node.nodeValue))
                this.fallbackHomes.set(node.nodeValue, old.id);
            }
          }
          this.destroyGroups(parent);
          parent.decoration?.destroy();
          parent.actorBin?.destroy();
        }
      }
      workspace.childNodes.length = 0;
      for (const monitor of this.monitors) {
        let parent = retained.get(monitor.id);
        if (!parent) {
          parent = new Node(
            NODE_TYPES.MONITOR,
            `mo${monitor.index}ws${workspace.nodeValue.slice(2)}`
          );
          parent.settings = tree.settings;
          parent.layout = this.wm.determineSplitLayout();
          parent.actorBin = new St.Bin();
          global.window_group.add_child(parent.actorBin);
        }
        parent.parentNode = null;
        workspace.appendChild(parent);
      }
    }
    tree._initWorkspaces();
    tree.attachNode = null;
    for (const node of detached) {
      const window = node.nodeValue;
      const workspace = window.get_workspace();
      if (!workspace) continue;
      const monitor =
        this.monitors.find((m) => m.index === window.get_monitor()) || this.monitors[0];
      tree.findNode(`mo${monitor.index}ws${workspace.index()}`)?.appendChild(node);
    }
    return displaced;
  }

  // A fallback location never replaces the history on the original monitor.
  // Unmatched fallback windows also stay out of their temporary host's history.
  relocateWindows(nodes) {
    const tree = this.wm.tree;
    const groupKeys = (saved, key) => {
      if (saved.key || ["TABBED", "STACKED"].includes(saved.layout)) return layoutKeys(saved);
      return groupKeys(
        saved.children.find((child) => layoutKeys(child).includes(key)),
        key
      );
    };
    const busy = new Map(this.monitors.map((m) => [m.id, 0]));
    for (const node of tree.nodeWindows) {
      if (nodes.has(node) || node.isFloat()) continue;
      const parent = tree.findAncestorMonitor(node);
      const monitor = this.monitors.find((m) => parent?.nodeValue.startsWith(`mo${m.index}ws`));
      if (monitor) busy.set(monitor.id, busy.get(monitor.id) + 1);
    }
    for (const node of nodes) {
      const window = node.nodeValue;
      const key = windowIdentity(window);
      const home = this.fallbackHomes.get(window);
      const matches = [];
      for (const monitor of this.monitors) {
        const saved = this.profile.monitors.find((m) => m.id === monitor.id);
        for (const ws of saved?.workspaces || [])
          if (key && layoutKeys(ws.tree).includes(key)) {
            const index = Math.min(ws.index, global.workspace_manager.get_n_workspaces() - 1);
            const parent = tree.findNode(`mo${monitor.index}ws${index}`);
            const peers =
              parent
                ?.getNodeByType(NODE_TYPES.WINDOW)
                .filter(
                  (other) =>
                    !nodes.has(other) &&
                    !other.isFloat() &&
                    groupKeys(ws.tree, key).includes(windowIdentity(other.nodeValue))
                ).length || 0;
            matches.push({ monitor, index, peers });
          }
      }
      const rank = (a, b) =>
        busy.get(a.id) - busy.get(b.id) ||
        b.width * b.height - a.width * a.height ||
        a.index - b.index;
      matches.sort(
        (a, b) =>
          Number(b.monitor.id === home) - Number(a.monitor.id === home) ||
          b.peers - a.peers ||
          rank(a.monitor, b.monitor)
      );
      const returning = this.monitors.find((m) => m.id === home);
      const chosen =
        matches.find((match) => match.monitor === returning) ||
        (returning
          ? { monitor: returning, index: window.get_workspace()?.index() || 0 }
          : matches[0]);
      const monitor = chosen?.monitor || [...this.monitors].sort(rank)[0];
      const index = chosen?.index ?? (window.get_workspace()?.index() || 0);
      const workspace = global.workspace_manager.get_workspace_by_index(index);
      if (workspace && window.get_workspace() !== workspace) window.change_workspace(workspace);
      if (window.get_monitor() !== monitor.index) window.move_to_monitor(monitor.index);
      const parent = tree.findNode(`mo${monitor.index}ws${index}`);
      if (node.parentNode !== parent) parent?.appendChild(node);
      if (matches.some((match) => match.monitor === monitor && match.index === index) || returning)
        this.temporaryWindows.delete(window);
      else this.temporaryWindows.add(window);
      if (returning) {
        this.fallbackHomes.delete(window);
        this.fallbackLocations.delete(window);
      } else this.fallbackLocations.set(window, { id: monitor.id, workspace: index });
      busy.set(monitor.id, busy.get(monitor.id) + Number(!node.isFloat()));
    }
  }

  windowClosed(window) {
    this.windowMoved(window);
    this.pendingWindows.delete(window);
  }

  windowMoved(window) {
    this.fallbackLocations.delete(window);
    this.fallbackHomes.delete(window);
    this.temporaryWindows.delete(window);
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
    const profiles = [{ monitors: Object.values(this.state.monitors) }, this.profile];
    const visited = new Set();
    for (const profile of profiles) {
      if (!profile) continue;
      for (const monitor of profile.monitors) {
        if (visited.has(monitor)) continue;
        visited.add(monitor);
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
      (window) =>
        this.wm.tree.findNode(window) &&
        (!windowIdentity(window) || this.wm.launchPlacement?.waitingForIdentity(window))
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
        if (this.wm.launchPlacement?.place(window))
          this.wm.updateMetaWorkspaceMonitor("launch-monitor", null, window, true);
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

  savedSlot(key, parent) {
    const find = (saved) => {
      if (saved.key) return saved.key === key ? [saved] : null;
      for (const child of saved.children) {
        const path = find(child);
        if (path) return [saved, ...path];
      }
      return null;
    };
    const match = parent?.nodeValue.match(/^mo(\d+)ws(\d+)$/);
    if (!match) return null;
    const monitor = this.monitors.find((item) => item.index === Number(match[1]));
    const ws = this.profile?.monitors
      .find((item) => item.id === monitor?.id)
      ?.workspaces.find((item) => item.index === Number(match[2]));
    if (!ws) return null;
    ws.tree = normalizeLayout(ws.tree);
    const path = find(ws.tree);
    return path ? { parent, path } : null;
  }

  placeWindow(node, unplaced) {
    const tree = this.wm.tree;
    const key = windowIdentity(node.nodeValue);
    const parent = tree.findNode(
      `mo${node.nodeValue.get_monitor()}ws${node.nodeValue.get_workspace()?.index() || 0}`
    );
    if (!parent) return;
    // An app already open in this session defines its live slot, including a
    // placement deliberately changed since the last saved layout.
    const peers = tree.nodeWindows.filter(
      (other) =>
        other !== node &&
        tree.findAncestorMonitor(other) === parent &&
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
    const slot = this.savedSlot(key, parent);
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
      // An app in a split member already belongs to an outer group. Another
      // window joins that group instead of creating tabs inside its split.
      destination = destination.groupAncestor() || destination;
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
          (child.isWindow() ? [child] : child.getNodeByType(NODE_TYPES.WINDOW)).some(
            (window) => !window.isFloat() && keys.includes(windowIdentity(window.nodeValue))
          )
        );
      const insert = (parent, savedParent, saved, child) => {
        const following = savedParent?.children.slice(savedParent.children.indexOf(saved) + 1);
        const reference = branchFor(parent, (following || []).flatMap(layoutKeys));
        parent.insertBefore(child, reference || null);
      };
      // A provisional auto-split can contain members of several saved groups.
      // Reconstruct only the requested saved branch, leaving foreign windows in
      // their existing subtree. Wrapping the whole branch would merge groups.
      const partition = (saved, branch, savedParent) => {
        const keys = new Set(layoutKeys(saved));
        const windows = branch.isWindow() ? [branch] : branch.getNodeByType(NODE_TYPES.WINDOW);
        const matching = windows.filter(
          (window) => !window.isFloat() && keys.has(windowIdentity(window.nodeValue))
        );
        const available = new Map();
        for (const window of matching) {
          const key = windowIdentity(window.nodeValue);
          if (!available.has(key)) available.set(key, []);
          available.get(key).push(window);
        }
        const projected = projectLayout(saved, available);
        const group = newGroup(saved);
        const share = this.pendingParents.get(destination)?.find(([child]) => child === branch);
        const percent = share ? share[1] : branch.percent;
        group.percent = (percent * matching.length) / windows.length;
        branch.percent = percent - group.percent;
        // The source's saved share no longer describes it after partitioning.
        if (share) share[1] = branch.percent;
        insert(destination, savedParent, saved, group);
        for (const window of matching) {
          window.tab?.get_parent()?.remove_child(window.tab);
          let source = window.parentNode;
          source.removeChild(window);
          while (source?.isCon() && source.childNodes.length === 0) {
            const parent = source.parentNode;
            parent.removeChild(source);
            tree._forgetRemoved(source);
            source.actor?.destroy();
            source = parent;
          }
        }
        const build = (saved, parent) => {
          if (saved.key) {
            let target = parent;
            if (
              saved.windows.length > 1 &&
              !parent.isTabbed() &&
              !parent.isStacked() &&
              !parent.groupAncestor()
            ) {
              target = newGroup({ layout: "TABBED" });
              parent.appendChild(target);
            }
            for (const window of saved.windows) {
              window.percent = 0;
              target.appendChild(window);
            }
          } else {
            const child = newGroup(saved);
            parent.appendChild(child);
            for (const member of saved.children) build(member, child);
          }
        };
        for (const child of projected.children) build(child, group);
        return group;
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
        const windows =
          branch && (branch.isWindow() ? [branch] : branch.getNodeByType(NODE_TYPES.WINDOW));
        const keys = new Set(layoutKeys(saved));
        const exclusive = windows?.every(
          (window) => !window.isFloat() && keys.has(windowIdentity(window.nodeValue))
        );
        if (branch?.isCon() && branch.layout === LAYOUT_TYPES[saved.layout] && exclusive) {
          destination = branch;
        } else if (branch) {
          destination = partition(saved, branch, slot.path[index - 1]);
        } else {
          const group = newGroup(saved);
          insert(destination, slot.path[index - 1], saved, group);
          tree.resetSiblingPercent(destination);
          destination = group;
        }
      }
      insert(destination, slot.path.at(-2), slot.path.at(-1), node);
      if (destination.isHSplit() || destination.isVSplit()) tree.resetSiblingPercent(destination);
    }
    node.percent = 0;
  }

  capture() {
    this.wm.tree.normalizeGroups();
    const seen = new Set();
    const preferred = new Map();
    const localKey = (node) =>
      JSON.stringify([
        this.wm.tree.findAncestorMonitor(node)?.nodeValue,
        windowIdentity(node.nodeValue),
      ]);
    for (const node of [...this.wm.tree.nodeWindows].sort(
      (a, b) =>
        (a.nodeValue.get_stable_sequence?.() || 0) - (b.nodeValue.get_stable_sequence?.() || 0)
    )) {
      const key = windowIdentity(node.nodeValue);
      if (key && !node.isFloat() && !this.temporaryWindows.has(node.nodeValue))
        preferred.set(localKey(node), node);
    }
    const focus = this.wm.tree.findNode(this.wm.focusMetaWindow);
    if (focus && !focus.isFloat() && !this.temporaryWindows.has(focus.nodeValue))
      preferred.set(localKey(focus), focus);
    const serialize = (node, savedRoot) => {
      if (!node) return { layout: "HSPLIT", children: [] };
      if (node.isWindow()) {
        if (node.isFloat() || this.temporaryWindows.has(node.nodeValue)) return null;
        const key = windowIdentity(node.nodeValue);
        const slot = localKey(node);
        if (!key || seen.has(slot) || preferred.get(slot) !== node) return null;
        seen.add(slot);
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
    // Remember the last app/profile slot separately on each monitor/workspace.
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
      // Tree-driven moves (keyboard and drag/drop) can precede Meta's monitor
      // signal. Detect deliberate moves here too, before saving their new slot.
      for (const [window, location] of this.fallbackLocations) {
        const node = this.wm.tree.findNode(window);
        if (!node) {
          this.windowClosed(window);
          continue;
        }
        const parent = this.wm.tree.findAncestorMonitor(node);
        const monitor = this.monitors.find((m) => m.id === location.id);
        if (parent?.nodeValue !== `mo${monitor?.index}ws${location.workspace}`)
          this.windowMoved(window);
      }
      this.profile = mergeProfile(this.profile, this.capture());
      for (const monitor of this.profile.monitors) this.state.monitors[monitor.id] = monitor;
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

  apply({ relocate = false, onlyMonitors = null } = {}) {
    this.wm.cancelPendingMoves?.();
    const wm = this.wm;
    const tree = wm.tree;
    const available = new Map();
    const selected = (node) =>
      !onlyMonitors ||
      this.monitors.some(
        (m) =>
          onlyMonitors.has(m.id) &&
          tree.findAncestorMonitor(node)?.nodeValue.startsWith(`mo${m.index}ws`)
      );
    for (const node of tree.nodeWindows) {
      if (!selected(node)) continue;
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
        if (
          saved.windows.length > 1 &&
          !parent.isTabbed() &&
          !parent.isStacked() &&
          !parent.groupAncestor()
        ) {
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
      if (onlyMonitors && !onlyMonitors.has(monitor.id)) continue;
      const savedMonitor = this.profile.monitors.find((item) => item.id === monitor.id);
      for (let index = 0; index < global.workspace_manager.get_n_workspaces(); index++) {
        const parent = tree.findNode(`mo${monitor.index}ws${index}`);
        if (!parent) continue;
        const candidates = new Map();
        for (const [key, windows] of available) {
          const local = windows.filter(
            (node) =>
              node.nodeValue.get_monitor() === monitor.index &&
              node.nodeValue.get_workspace()?.index() === index
          );
          if (local.length) candidates.set(key, local);
          else if (relocate) candidates.set(key, windows);
        }
        const children = (savedMonitor?.workspaces || [])
          .filter(
            (ws) =>
              (relocate
                ? Math.min(ws.index, global.workspace_manager.get_n_workspaces() - 1)
                : ws.index) === index
          )
          .map((ws) => projectLayout(ws.tree, candidates))
          .filter(Boolean);
        const consume = (saved) => {
          if (saved.key) {
            const matched = new Set(saved.windows);
            const remaining = available.get(saved.key).filter((node) => !matched.has(node));
            if (remaining.length) available.set(saved.key, remaining);
            else available.delete(saved.key);
          } else saved.children.forEach(consume);
        };
        children.forEach(consume);
        plans.push({ monitor, index, parent, children });
      }
    }
    // Windows opened in another configuration have no saved slot here. Place
    // them together by app in their current workspace on an active display.
    const primary = this.monitors.find((monitor) => monitor.primary) || this.monitors[0];
    for (const [key, windows] of available) {
      const byLocation = new Map();
      for (const node of windows) {
        const window = node.nodeValue;
        const location = `${window.get_monitor()}:${window.get_workspace()?.index() || 0}`;
        if (!byLocation.has(location)) byLocation.set(location, []);
        byLocation.get(location).push(node);
      }
      for (const local of byLocation.values()) {
        const window = local[0].nodeValue;
        const index = window.get_workspace()?.index() || 0;
        const monitor =
          this.monitors.find((item) => item.index === window.get_monitor()) || primary;
        const plan =
          plans.find((item) => item.monitor === monitor && item.index === index) || plans[0];
        if (plan) plan.children.push({ key, windows: local });
      }
    }
    // Detach all windows before destroying decorations on any monitor. A matched
    // window can move from a monitor which is rebuilt later in this loop.
    const detached = [...tree.nodeWindows].filter(selected);
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
