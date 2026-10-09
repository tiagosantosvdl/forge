/*
 * This file is part of the Forge extension for GNOME
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */

// Upstream fixes adapted for this fork; credits identify the PR submitters.
// mayconrcmello: #520.
// OddballGreg: #541.
// enklht: #516.
// mattchristenson: #553, #554, #557, #559, #567, #568, #569, #570, #571, #572, #578.
// PR links: https://github.com/forge-ext/forge/pull/<number>

// Gnome imports
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import St from "gi://St";

// Shared state
import { Logger } from "../shared/logger.js";

// App imports
import * as Utils from "./utils.js";
import * as Window from "./window.js";
import { safeRaise, safeFocus, safeActivate } from "./mutter-safe.js";
import { resolveWindowApp } from "./tab-metadata.js";

export const NODE_TYPES = Utils.createEnum([
  "ROOT",
  "MONITOR", //Output in i3
  "CON", //Container in i3
  "WINDOW",
  "WORKSPACE",
]);

export const LAYOUT_TYPES = Utils.createEnum([
  "STACKED",
  "TABBED",
  "ROOT",
  "HSPLIT",
  "VSPLIT",
  "PRESET",
]);

export const ORIENTATION_TYPES = Utils.createEnum(["NONE", "HORIZONTAL", "VERTICAL"]);

export const POSITION = Utils.createEnum(["BEFORE", "AFTER", "UNKNOWN"]);

// Smallest size (logical px, gaps excluded) a tiled window can be resized to
const MIN_WINDOW_SIZE = 50;

/**
 * The Node data representation of the following elements in the user's display:
 *
 * Monitor,
 * Window,
 * Container (generic),
 * Workspace
 *
 */
export class Node extends GObject.Object {
  static {
    GObject.registerClass(this);
  }

  constructor(type, data) {
    super();
    // TODO - move to GObject property definitions?
    this._type = type; // see NODE_TYPES
    // _data: Meta.Window, unique id strings (Monitor,
    // Workspace or St.Bin - a representation of Container)
    this._data = data;
    this._parent = null;
    this._nodes = []; // Child elements of this node
    this.mode = Window.WINDOW_MODES.DEFAULT;
    this.percent = 0.0;
    this._rect = null;
    this.tab = null;
    this.decoration = null;
    this.app = null;
    this.pointer = null;

    if (this.isWindow()) {
      // When destroy() is called on Meta.Window, it might not be
      // available so we store it immediately
      this._initMetaWindow();
      this._actor = this._data.get_compositor_private();
      this._createWindowTab();
    }

    if (this.isCon()) {
      this._createDecoration();
    }
  }

  get windowActor() {
    return this._actor;
  }

  get actor() {
    switch (this.nodeType) {
      case NODE_TYPES.WINDOW:
        // A Meta.Window was assigned during creation
        // But obtain the Clutter.Actor
        return this._actor;
      case NODE_TYPES.CON:
      case NODE_TYPES.ROOT:
        // A St.Bin was assigned during creation
        return this.nodeValue;
      case NODE_TYPES.MONITOR:
      case NODE_TYPES.WORKSPACE:
        // A separate St.Bin was assigned on another attribute during creation
        return this.actorBin;
    }
  }

  set rect(rect) {
    this._rect = rect;
    switch (this.nodeType) {
      case NODE_TYPES.WINDOW:
        break;
      case NODE_TYPES.CON:
      case NODE_TYPES.MONITOR:
      case NODE_TYPES.ROOT:
      case NODE_TYPES.WORKSPACE:
        // OddballGreg, upstream PR #541: https://github.com/forge-ext/forge/pull/541
        if (this.actor && rect) {
          this.actor.set_size(rect.width, rect.height);
          this.actor.set_position(rect.x, rect.y);
        }
        break;
    }
  }

  get rect() {
    return this._rect;
  }

  get childNodes() {
    return this._nodes;
  }

  set childNodes(nodes) {
    this._nodes = nodes;
  }

  get firstChild() {
    if (this._nodes && this._nodes.length >= 1) {
      return this._nodes[0];
    }
    return null;
  }

  get level() {
    let _level = 0;
    let refNode = this.parentNode;
    while (refNode) {
      _level += 1;
      refNode = refNode.parentNode;
    }

    return _level;
  }

  /**
   * Find the index of this relative to the siblings
   */
  get index() {
    if (this.parentNode) {
      let childNodes = this.parentNode.childNodes;
      for (let i = 0; i < childNodes.length; i++) {
        if (childNodes[i] === this) {
          return i;
        }
      }
    }
    return null;
  }

  get lastChild() {
    if (this._nodes && this._nodes.length >= 1) {
      return this._nodes[this._nodes.length - 1];
    }
    return null;
  }

  get nextSibling() {
    if (this.parentNode) {
      if (this.parentNode.lastChild !== this) {
        return this.parentNode.childNodes[this.index + 1];
      }
    }
    return null;
  }

  get nodeType() {
    return this._type;
  }

  get nodeValue() {
    return this._data;
  }

  get parentNode() {
    return this._parent;
  }

  set parentNode(node) {
    this._parent = node;
  }

  get previousSibling() {
    if (this.parentNode) {
      if (this.parentNode.firstChild !== this) {
        return this.parentNode.childNodes[this.index - 1];
      }
    }
    return null;
  }

  appendChild(node) {
    if (!node) return null;
    if (node.parentNode) node.parentNode.removeChild(node);
    this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }

  /**
   * Checks if node is a descendant of this,
   * or a descendant of its childNodes, etc
   */
  contains(node) {
    if (!node) return false;
    let searchNode = this.getNodeByValue(node.nodeValue);
    return searchNode ? true : false;
  }

  getNodeByLayout(layout) {
    let results = this._search(layout, "LAYOUT");
    return results;
  }

  getNodeByMode(mode) {
    let results = this._search(mode, "MODE");
    return results;
  }

  getNodeByValue(value) {
    let results = this._search(value, "VALUE");
    return results && results.length >= 1 ? results[0] : null;
  }

  getNodeByType(type) {
    let results = this._search(type, "TYPE");
    return results;
  }

  /**
   * @param childNode - is a child of this
   */
  insertBefore(newNode, childNode) {
    if (!newNode) return null;
    if (newNode === childNode) return null;
    if (!childNode) {
      this.appendChild(newNode);
      return newNode;
    }
    if (childNode.parentNode !== this) return null;
    if (newNode.parentNode) newNode.parentNode.removeChild(newNode);
    let index = childNode.index;

    if (childNode.index === 0) {
      this.childNodes.unshift(newNode);
    } else if (childNode.index > 0) {
      this.childNodes.splice(index, 0, newNode);
    }
    newNode.parentNode = this;

    return newNode;
  }

  isLayout(name) {
    let layout = this.layout;
    if (!layout) return false;

    return name === layout;
  }

  isHSplit() {
    return this.isLayout(LAYOUT_TYPES.HSPLIT);
  }

  isVSplit() {
    return this.isLayout(LAYOUT_TYPES.VSPLIT);
  }

  isStacked() {
    return this.isLayout(LAYOUT_TYPES.STACKED);
  }

  isTabbed() {
    return this.isLayout(LAYOUT_TYPES.TABBED);
  }

  groupAncestor() {
    for (let parent = this.parentNode; parent; parent = parent.parentNode)
      if (parent.isTabbed() || parent.isStacked()) return parent;
    return null;
  }

  groupWindowCount() {
    return this.getNodeByType(NODE_TYPES.WINDOW).filter(
      (node) => (node.isTile() || node.isGrabTile()) && node.isNodeValid()
    ).length;
  }

  isType(name) {
    const type = this.nodeType;
    if (!type) return false;

    return name === type;
  }

  isWindow() {
    return this.isType(NODE_TYPES.WINDOW);
  }

  isCon() {
    return this.isType(NODE_TYPES.CON);
  }

  isMonitor() {
    return this.isType(NODE_TYPES.MONITOR);
  }

  isWorkspace() {
    return this.isType(NODE_TYPES.WORKSPACE);
  }

  isRoot() {
    return this.isType(NODE_TYPES.ROOT);
  }

  isMode(name) {
    const mode = this.mode;
    if (!name) return false;

    return name === mode;
  }

  isFloat() {
    return this.isMode(Window.WINDOW_MODES.FLOAT);
  }

  isTile() {
    return this.isMode(Window.WINDOW_MODES.TILE);
  }

  isGrabTile() {
    return this.isMode(Window.WINDOW_MODES.GRAB_TILE);
  }

  removeChild(node) {
    let refNode;
    if (this.contains(node)) {
      // Since contains() tries to find node on all descendants,
      // detach only from the immediate parent
      let parentNode = node.parentNode;
      // enklht, upstream PR #516: https://github.com/forge-ext/forge/pull/516
      refNode = parentNode.childNodes[node.index];

      parentNode.childNodes.splice(node.index, 1);
      refNode.parentNode = null;
    }
    if (!refNode) {
      throw `NodeNotFound ${node}`;
    }
    return refNode;
  }

  /**
   * Backend for getNodeBy[attribute]. It is similar to DOM.getElementBy functions
   */
  _search(term, criteria) {
    let results = [];
    let searchFn = (candidate) => {
      if (criteria) {
        switch (criteria) {
          case "VALUE":
            if (candidate.nodeValue === term) {
              results.push(candidate);
            }
            break;
          case "TYPE":
            if (candidate.nodeType === term) {
              results.push(candidate);
            }
            break;
          case "MODE":
            if (candidate.mode === term) {
              results.push(candidate);
            }
          case "LAYOUT":
            if (candidate.layout && candidate.layout === term) {
              results.push(candidate);
            }
        }
      } else {
        if (candidate === term) {
          results.push(candidate);
        }
      }
    };

    this._walk(searchFn, this._traverseBreadthFirst);
    return results;
  }

  // start walking from root and all child nodes
  _traverseBreadthFirst(callback) {
    let queue = new Queue();
    queue.enqueue(this);

    let currentNode = queue.dequeue();

    while (currentNode) {
      for (let i = 0, length = currentNode.childNodes.length; i < length; i++) {
        queue.enqueue(currentNode.childNodes[i]);
      }

      callback(currentNode);
      currentNode = queue.dequeue();
    }
  }

  // start walking from bottom to root
  _traverseDepthFirst(callback) {
    let recurse = (currentNode) => {
      for (let i = 0, length = currentNode.childNodes.length; i < length; i++) {
        recurse(currentNode.childNodes[i]);
      }

      callback(currentNode);
    };
    recurse(this);
  }

  _walk(callback, traversal) {
    traversal.call(this, callback);
  }

  _initMetaWindow() {
    if (this.isWindow()) {
      this.app = resolveWindowApp(this.nodeValue);
    }
  }

  _createWindowTab() {
    if (this.tab || !this.isWindow()) return;

    let tabContents = new St.BoxLayout({
      style_class: "window-tabbed-tab",
      x_expand: true,
    });
    let labelText = this._getTitle();
    let metaWin = this.nodeValue;
    let titleButton = new St.Button({
      x_expand: true,
      label: `${labelText}`,
    });
    let iconBin = new St.Button({
      style_class: "window-tabbed-tab-icon",
    });
    this._tabIconSize = 24 * Utils.dpi();
    this._tabIconApp = this.app;
    iconBin.child = this.createTabIcon(this._tabIconSize);
    let closeButton = new St.Button({
      style_class: "window-tabbed-tab-close",
      child: new St.Icon({ icon_name: "window-close-symbolic" }),
    });

    tabContents.add_child(iconBin);
    tabContents.add_child(titleButton);
    tabContents.add_child(closeButton);

    let clickFn = () => {
      this.parentNode.childNodes.forEach((c) => {
        if (c.tab) {
          c.tab.remove_style_class_name("window-tabbed-tab-active");
          c.render();
        }
      });
      tabContents.add_style_class_name("window-tabbed-tab-active");
      safeActivate(metaWin, global.display.get_current_time());
    };

    let closeFn = () => {
      metaWin.delete(global.get_current_time());
    };

    let middleClickCloseFn = (_, event) => {
      if (event.get_button() === Clutter.BUTTON_MIDDLE) {
        metaWin.delete(global.get_current_time());
      }
    };

    iconBin.connect("clicked", clickFn);
    iconBin.connect("button-release-event", middleClickCloseFn);
    titleButton.connect("clicked", clickFn);
    titleButton.connect("button-release-event", middleClickCloseFn);
    closeButton.connect("clicked", closeFn);
    closeButton.connect("button-release-event", middleClickCloseFn);

    if (metaWin === global.display.get_focus_window()) {
      tabContents.add_style_class_name("window-tabbed-tab-active");
    }
    this.tab = tabContents;
  }

  /**
   * The tab (or stack title row) of a container that is a member of a tabbed or stacked group,
   * e.g. a split among tabs. Tree._placeDecoration() sets its title and icon (from the window
   * last used in it); a click goes back to that window.
   */
  _createConTab(onClick) {
    if (this.tab || !this.isCon()) return;
    const tabContents = new St.BoxLayout({
      style_class: "window-tabbed-tab",
      x_expand: true,
    });
    const iconBin = new St.Button({ style_class: "window-tabbed-tab-icon" });
    const titleButton = new St.Button({ x_expand: true, label: "" });
    tabContents.add_child(iconBin);
    tabContents.add_child(titleButton);
    iconBin.connect("clicked", onClick);
    titleButton.connect("clicked", onClick);
    this.tab = tabContents;
  }

  _createDecoration() {
    if (this.decoration) return;
    let decoration = new St.BoxLayout();
    decoration.type = "forge-deco";
    decoration.parentNode = this;
    let globalWinGrp = global.window_group;
    decoration.style_class = "window-tabbed-bg";

    if (!globalWinGrp.contains(decoration)) {
      globalWinGrp.add_child(decoration);
    }

    decoration.hide();
    this.decoration = decoration;
  }

  _getTitle() {
    if (this.isWindow()) {
      return this.nodeValue.title || this.app?.get_name() || "";
    }
    return null;
  }

  // Check if the underlying window actor is still alive. GJS throws
  // on property access of finalized GObjects rather than segfaulting,
  // so a cheap get_name() call is enough to detect dead actors.
  isNodeValid() {
    if (!this.isWindow()) return true;
    try {
      let actor = this._actor;
      if (!actor) return false;
      actor.get_name();
      return true;
    } catch (e) {
      return false;
    }
  }

  createTabIcon(size) {
    return this.app
      ? this.app.create_icon_texture(size)
      : new St.Icon({ icon_name: "application-x-executable", icon_size: size });
  }

  refreshWindowTab(forceIcon = false) {
    if (!this.isWindow() || !this.isNodeValid()) return;
    this._createWindowTab();
    const title = this.tab.get_child_at_index(1);
    if (title) title.label = this._getTitle();
    const icon = this.tab.get_child_at_index(0);
    const size = 24 * Utils.dpi();
    if (icon && (forceIcon || this._tabIconApp !== this.app || this._tabIconSize !== size)) {
      this._tabIconApp = this.app;
      this._tabIconSize = size;
      icon.child = this.createTabIcon(size);
    }
  }

  render() {
    this.refreshWindowTab();
  }

  set float(value) {
    if (this.isWindow()) {
      let metaWindow = this.nodeValue;
      let floatAlwaysOnTop = this.settings.get_boolean("float-always-on-top-enabled");
      if (value) {
        this.mode = Window.WINDOW_MODES.FLOAT;
        if (!metaWindow.is_above()) {
          floatAlwaysOnTop && metaWindow.make_above();
        }
      } else {
        this.mode = Window.WINDOW_MODES.TILE;
        if (metaWindow.is_above()) {
          metaWindow.unmake_above();
        }
      }
    }
  }

  set tile(value) {
    this.float = !value;
  }

  resetLayoutSingleChild() {
    let tabbedOrStacked = this.isTabbed() || this.isStacked();
    if (tabbedOrStacked && this.groupWindowCount() <= 1) {
      this.restoreSplitLayout(LAYOUT_TYPES.HSPLIT);
    }
  }

  get layout() {
    return this._layout;
  }

  /**
   * A split container that becomes a tabbed or stacked group remembers its split direction
   * (`splitLayout`), wherever that happens, so that leaving the group can restore it.
   */
  set layout(value) {
    const split = this._layout === LAYOUT_TYPES.HSPLIT || this._layout === LAYOUT_TYPES.VSPLIT;
    if (split && (value === LAYOUT_TYPES.TABBED || value === LAYOUT_TYPES.STACKED)) {
      this.splitLayout = this._layout;
    }
    this._layout = value;
  }

  /**
   * Make this container a tabbed or stacked group; `remember = false` for a container just
   * created for the group, whose split direction means nothing yet.
   */
  setGroupLayout(layout, remember = true) {
    this.layout = layout;
    if (!remember) this.splitLayout = null;
  }

  /** Leave a tabbed or stacked group: back to the split direction it had, else `fallback`. */
  restoreSplitLayout(fallback) {
    this.layout = this.splitLayout ?? fallback;
  }

  singleOrNoChild() {
    return this.childNodes.length <= 1;
  }
}

/**
 * An implementation of Queue using arrays
 */
export class Queue extends GObject.Object {
  static {
    GObject.registerClass(this);
  }

  constructor() {
    super();
    this._elements = [];
  }

  get length() {
    return this._elements.length;
  }

  enqueue(item) {
    this._elements.push(item);
  }

  dequeue() {
    return this._elements.shift();
  }
}

export class Tree extends Node {
  static {
    GObject.registerClass(this);
  }

  /** @param {Window.WindowManager} extWm */
  constructor(extWm) {
    let rootBin = new St.Bin();
    super(NODE_TYPES.ROOT, rootBin);
    this._extWm = extWm;
    this.defaultStackHeight = 35;
    this.settings = this.extWm.ext.settings;
    this.layout = LAYOUT_TYPES.ROOT;
    if (!global.window_group.contains(rootBin)) global.window_group.add_child(rootBin);

    this._initWorkspaces();
  }

  /** @type {Window.WindowManager} */
  get extWm() {
    return this._extWm;
  }

  /**
   * Handles new and existing workspaces in the tree
   */
  _initWorkspaces() {
    let wsManager = global.display.get_workspace_manager();
    let workspaces = wsManager.get_n_workspaces();
    for (let i = 0; i < workspaces; i++) {
      this.addWorkspace(i);
    }
  }

  // TODO move to monitor.js
  addMonitor(wsIndex) {
    let monitors = global.display.get_n_monitors();
    for (let mi = 0; mi < monitors; mi++) {
      let monitorWsNode = this.createNode(
        `ws${wsIndex}`,
        NODE_TYPES.MONITOR,
        `mo${mi}ws${wsIndex}`
      );
      monitorWsNode.layout = this.extWm.determineSplitLayout();
      monitorWsNode.actorBin = new St.Bin();
      if (!global.window_group.contains(monitorWsNode.actorBin))
        global.window_group.add_child(monitorWsNode.actorBin);
    }
  }

  // TODO move to workspace.js
  addWorkspace(wsIndex) {
    let wsManager = global.display.get_workspace_manager();
    let workspaceNodeValue = `ws${wsIndex}`;

    let existingWsNode = this.findNode(workspaceNodeValue);
    if (existingWsNode) {
      return false;
    }

    let newWsNode = this.createNode(this.nodeValue, NODE_TYPES.WORKSPACE, workspaceNodeValue);

    let workspace = wsManager.get_workspace_by_index(wsIndex);
    newWsNode.layout = LAYOUT_TYPES.HSPLIT;
    newWsNode.actorBin = new St.Bin({ style_class: "workspace-actor-bg" });

    if (!global.window_group.contains(newWsNode.actorBin))
      global.window_group.add_child(newWsNode.actorBin);

    this.extWm.bindWorkspaceSignals(workspace);
    this.addMonitor(wsIndex);

    return true;
  }

  // TODO move to workspace.js
  removeWorkspace(wsIndex) {
    let workspaceNodeData = `ws${wsIndex}`;
    let existingWsNode = this.findNode(workspaceNodeData);
    if (!existingWsNode) {
      return false;
    }

    if (global.window_group.contains(existingWsNode.actorBin))
      global.window_group.remove_child(existingWsNode.actorBin);

    this.removeChild(existingWsNode);
    this._forgetRemoved(existingWsNode);

    this._renumberWorkspaces(wsIndex + 1);
    return true;
  }

  // mattchristenson, upstream PR #572: https://github.com/forge-ext/forge/pull/572
  // Also addresses the workspace renumbering reported by enklht in PR #516.
  _renumberWorkspaces(fromIndex) {
    const indexOf = (node) => Number(node.nodeValue.slice(2));
    this.nodeWorkpaces
      .filter((ws) => indexOf(ws) >= fromIndex)
      .sort((a, b) => indexOf(a) - indexOf(b))
      .forEach((ws) => {
        const index = indexOf(ws) - 1;
        ws._data = `ws${index}`;
        ws.getNodeByType(NODE_TYPES.MONITOR).forEach((monitor) => {
          monitor._data = monitor.nodeValue.replace(/ws\d+$/, `ws${index}`);
        });
      });
  }

  get nodeWorkpaces() {
    let nodeWorkspaces = this.getNodeByType(NODE_TYPES.WORKSPACE);
    return nodeWorkspaces;
  }

  get nodeWindows() {
    let nodeWindows = this.getNodeByType(NODE_TYPES.WINDOW);
    return nodeWindows;
  }

  /**
   * Creates a new Node and attaches it to a parent toData.
   * Parent can be MONITOR or CON types only.
   */
  createNode(parentObj, type, value, mode = Window.WINDOW_MODES.TILE) {
    let parentNode = this.findNode(parentObj);
    let child;

    if (parentNode) {
      child = new Node(type, value);
      child.settings = this.settings;

      if (child.isWindow()) child.mode = mode;

      // Append after a window
      if (parentNode.isWindow()) {
        const grandParentNode = parentNode.parentNode;
        grandParentNode.insertBefore(child, parentNode.nextSibling);
        Logger.debug(
          `Parent is a window, attaching to this window's parent ${grandParentNode.nodeType}`
        );
      } else {
        // Append as the last item of the container
        parentNode.appendChild(child);
      }
    }
    return child;
  }

  /**
   * Finds any Node in the tree using data
   * Data types can be in the form of Meta.Window or unique id strings
   * for Workspace, Monitor and Container
   *
   * Workspace id strings takes the form `ws{n}`.
   * Monitor id strings takes the form `mo{m}ws{n}`
   * Container id strings takes the form `mo{m}ws{n}c{x}`
   *
   */
  findNode(data) {
    let searchNode = this.getNodeByValue(data);
    return searchNode;
  }

  /**
   * Find the NodeWindow using the Meta.WindowActor
   */
  findNodeByActor(windowActor) {
    let searchNode;
    let criteriaMatchFn = (node) => {
      if (node.isWindow() && node.actor === windowActor) {
        searchNode = node;
      }
    };

    this._walk(criteriaMatchFn, this._traverseDepthFirst);

    return searchNode;
  }

  /**
   * Focuses on the next node, if metaWindow and tiled, raise it
   */
  /**
   * The window to focus when focus enters container `con` from outside it (from the `previous`
   * side): a tabbed or stacked group's last-used window; otherwise, as before, a stack's last
   * window, or the first or last tiled window.
   */
  _entryWindow(con, previous) {
    const isGroup = (n) => n.isTabbed() || n.isStacked();
    let pick = isGroup(con) ? this._lastUsedIn(con) : null;
    if (!pick) {
      const tiled = con.getNodeByType(NODE_TYPES.WINDOW).filter((w) => w.isTile());
      if (con.isStacked()) pick = tiled[tiled.length - 1] ?? con.lastChild;
      else pick = previous ? tiled[tiled.length - 1] : tiled[0];
    }
    // A window inside a group further down (e.g. a split holding tabs): that group's last-used one
    let outer = null;
    for (let p = pick?.parentNode; p && p !== con; p = p.parentNode) if (isGroup(p)) outer = p;
    return (outer && this._lastUsedIn(outer)) ?? pick;
  }

  /**
   * The window last focused in a tabbed or stacked group, if it is still a visible tile anywhere
   * inside it (null once it was closed, moved out, minimized or floated).
   */
  _lastUsedIn(group) {
    const last = group.lastTabFocus;
    const node = last ? group.getNodeByValue(last) : null;
    return node && node.isWindow() && node.isTile() && !last.minimized ? node : null;
  }

  focus(node, direction) {
    if (!node) return null;
    let next = this.next(node, direction);

    if (!next) return null;

    let type = next.nodeType;
    let position = Utils.positionFromDirection(direction);
    const previous = position === POSITION.BEFORE;

    switch (type) {
      case NODE_TYPES.WINDOW:
        break;
      case NODE_TYPES.CON:
        next = this._entryWindow(next, previous);
        break;
      case NODE_TYPES.MONITOR:
        if (next.layout === LAYOUT_TYPES.STACKED) {
          next = next.lastChild;
        } else {
          if (previous) {
            next = next.lastChild;
          } else {
            next = next.firstChild;
          }
        }

        if (next && next.nodeType === NODE_TYPES.CON) {
          next = this._entryWindow(next, previous);
        }
        break;
    }

    if (!next) return null;

    let metaWindow = next.nodeValue;
    if (!metaWindow) return null;
    const previousMetaWindow = this.extWm.focusMetaWindow;
    if (metaWindow.minimized) {
      next = this.focus(next, direction);
    } else {
      const t = global.display.get_current_time();
      if (!safeRaise(metaWindow)) return null;
      safeFocus(metaWindow, t);
      safeActivate(metaWindow, t);

      const monitorArea = metaWindow.get_work_area_current_monitor();
      const ptr = this.extWm.getPointer();
      const pointerInside = Utils.rectContainsPoint(monitorArea, [ptr[0], ptr[1]]);
      const monitorChanged =
        !!previousMetaWindow &&
        previousMetaWindow.get_monitor &&
        previousMetaWindow.get_monitor() !== metaWindow.get_monitor();

      if (this.settings.get_boolean("move-pointer-focus-enabled")) {
        this.extWm.movePointerWith(next);
      } else if (!pointerInside) {
        this.extWm.movePointerWith(next, { force: monitorChanged });
      }
    }
    return next;
  }

  /**
   * Obtains the non-floating, non-minimized list of nodes
   * Useful for calculating the rect areas
   */
  getTiledChildren(items) {
    let filterFn = (node) => {
      if (node.isWindow()) {
        let floating = node.isFloat();
        let grabTiling = node.isGrabTile();
        // A Node[Window]._data is a Meta.Window
        if (!node.nodeValue.minimized && !(floating || grabTiling)) {
          return true;
        }
      }
      // handle split containers
      if (node.isCon()) {
        return this.getTiledChildren(node.childNodes).length > 0;
      }
      return false;
    };

    return items ? items.filter(filterFn) : [];
  }

  /**
   * Move a given node into a direction
   *
   * TODO, handle minimized or floating windows
   *
   */
  move(node, direction) {
    if (!node) return false;
    let next = this.next(node, direction);
    let position = Utils.positionFromDirection(direction);
    // The workspace node of the window's own monitor (not the monitor under the pointer)
    const currMonWsNode = this.findAncestorMonitor(node) ?? this.extWm.currentMonWsNode;

    if (!next || next === -1) {
      // Nothing in that direction on any monitor
      return next === -1 && this._moveOutToWorkspace(node, position, currMonWsNode);
    }

    let parentNode = node.parentNode;
    let parentTarget;

    switch (next.nodeType) {
      case NODE_TYPES.WINDOW:
        // If same parent, swap
        if (next === node.previousSibling || next === node.nextSibling) {
          parentTarget = next.parentNode;
          this.swapPairs(node, next);
          if (this.settings.get_boolean("move-pointer-focus-enabled")) {
            this.extWm.movePointerWith(node);
          }
          // do not reset percent when swapped
          return true;
        } else {
          parentTarget = next.parentNode;
          if (parentTarget) {
            if (position === POSITION.AFTER) {
              parentTarget.insertBefore(node, next);
            } else {
              parentTarget.insertBefore(node, next.nextSibling);
            }
          }
        }
        break;
      case NODE_TYPES.CON:
        parentTarget = next;

        if (next.isStacked()) {
          next.appendChild(node);
        } else {
          if (position === POSITION.AFTER) {
            next.insertBefore(node, next.firstChild);
          } else {
            next.appendChild(node);
          }
        }
        break;
      case NODE_TYPES.MONITOR: {
        // A window at the workspace level goes to the monitor in that direction; one in a
        // container first moves out of it, onto its own monitor's workspace level
        if (parentNode !== currMonWsNode || next === currMonWsNode) {
          return this._moveOutToWorkspace(node, position, currMonWsNode);
        }
        parentTarget = next;
        const targetMonRect = this.extWm.rectForMonitor(node, Utils.monitorIndex(next.nodeValue));
        if (!targetMonRect) return false;
        if (position === POSITION.AFTER) {
          next.insertBefore(node, next.firstChild);
        } else {
          next.appendChild(node);
        }
        this.extWm.move(node.nodeValue, targetMonRect);
        this.extWm.movePointerWith(node);
        break;
      }
      default:
        break;
    }
    this._resetSharesAfterMove(parentNode, parentTarget);
    return true;
  }

  /**
   * Take a node out of its container to the start (up/left) or the end (down/right) of its
   * workspace. A node already at the workspace level stays where it is. Returns whether it moved.
   */
  _moveOutToWorkspace(node, position, currMonWsNode) {
    const parentNode = node.parentNode;
    if (!currMonWsNode || parentNode === currMonWsNode) return false;
    if (position === POSITION.AFTER) {
      currMonWsNode.appendChild(node);
    } else {
      currMonWsNode.insertBefore(node, currMonWsNode.firstChild);
    }
    this._resetSharesAfterMove(parentNode, currMonWsNode);
    return true;
  }

  /**
   * After a node moved from one container to another: both go back to equal shares, so that
   * neither keeps a share of a node it no longer has (or lacks one for its new node). Containers
   * left empty are removed later, so their shares in their parents are reset too.
   */
  _resetSharesAfterMove(from, to) {
    this.resetSiblingPercent(from);
    this.resetSiblingPercent(to);
    for (
      let empty = from;
      empty?.isCon() && empty.childNodes.length === 0;
      empty = empty.parentNode
    ) {
      this.resetSiblingPercent(empty.parentNode);
    }
    from?.resetLayoutSingleChild();
  }

  /**
   * Give the next sibling/parent/descendant on the tree based
   * on a given Meta.MotionDirection
   *
   * @param {Node} node
   * @param {Meta.MotionDirection} direction
   *
   * Credits: borrowed logic from tree.c of i3
   */
  next(node, direction) {
    if (!node) return null;
    let orientation = Utils.orientationFromDirection(direction);
    let position = Utils.positionFromDirection(direction);
    let previous = position === POSITION.BEFORE;

    const type = node.nodeType;

    switch (type) {
      case NODE_TYPES.ROOT:
        // Root is the top of the tree
        if (node.childNodes.length > 1) {
          if (previous) {
            return node.firstChild;
          } else {
            return node.lastChild;
          }
        } else {
          return node.firstChild;
        }
      case NODE_TYPES.WORKSPACE:
        // Let gnome-shell handle this?
        break;
      case NODE_TYPES.MONITOR:
        // Find the next monitor
        const nodeWindow = this.findFirstNodeWindowFrom(node);
        return this.nextMonitor(nodeWindow, position, orientation);
    }

    while (node.nodeType !== NODE_TYPES.WORKSPACE) {
      if (node.nodeType === NODE_TYPES.MONITOR) {
        return this.next(node, direction);
      }
      const parentNode = node.parentNode;
      const parentOrientation = Utils.orientationFromLayout(parentNode.layout);

      if (parentNode.childNodes.length > 1 && orientation === parentOrientation) {
        const next = previous ? node.previousSibling : node.nextSibling;
        if (next) {
          return next;
        }
      }
      node = node.parentNode;
    }
  }

  nextMonitor(nodeWindow, position, orientation) {
    if (!nodeWindow) return null;
    // Use the built in logic to determine adjacent monitors
    let monitorNode = null;
    let monitorDirection = Utils.directionFrom(position, orientation);
    let targetMonitor = -1;
    targetMonitor = global.display.get_monitor_neighbor_index(
      nodeWindow.nodeValue.get_monitor(),
      monitorDirection
    );
    if (targetMonitor < 0) return targetMonitor;
    let monWs = `mo${targetMonitor}ws${nodeWindow.nodeValue.get_workspace().index()}`;
    monitorNode = this.findNode(monWs);
    return monitorNode;
  }

  findAncestorMonitor(node) {
    return this.findAncestor(node, NODE_TYPES.MONITOR);
  }

  findAncestor(node, ancestorType) {
    let ancestorNode;

    while (node && ancestorType && !node.isRoot()) {
      if (node.isType(ancestorType)) {
        ancestorNode = node;
        break;
      } else {
        node = node.parentNode;
      }
    }

    return ancestorNode;
  }

  nextVisible(node, direction) {
    if (!node) return null;
    let next = this.next(node, direction);
    if (next && next.nodeType === NODE_TYPES.WINDOW && next.nodeValue && next.nodeValue.minimized) {
      next = this.nextVisible(next, direction);
    }
    return next;
  }

  /**
   * Credits: i3-like split
   */
  split(node, orientation, forceSplit = false) {
    if (!node) return;
    let type = node.nodeType;

    if (type === NODE_TYPES.WINDOW && node.mode === Window.WINDOW_MODES.FLOAT) {
      return;
    }

    if (!(type === NODE_TYPES.MONITOR || type === NODE_TYPES.CON || type === NODE_TYPES.WINDOW)) {
      return;
    }

    let parentNode = node.parentNode;
    let numChildren = parentNode.childNodes.length;

    // toggle the split
    if (
      !forceSplit &&
      numChildren === 1 &&
      (parentNode.layout === LAYOUT_TYPES.HSPLIT || parentNode.layout === LAYOUT_TYPES.VSPLIT)
    ) {
      parentNode.layout =
        orientation === ORIENTATION_TYPES.HORIZONTAL ? LAYOUT_TYPES.HSPLIT : LAYOUT_TYPES.VSPLIT;
      this.attachNode = parentNode;
      return;
    }

    // Wrap the existing node, including a split/group subtree, without creating
    // a second window node or dropping the container's existing children.
    let container = new St.Bin();
    let newConNode = new Node(NODE_TYPES.CON, container);
    newConNode.settings = this.settings;

    // Take the direction of the parent
    newConNode.layout =
      orientation === ORIENTATION_TYPES.HORIZONTAL ? LAYOUT_TYPES.HSPLIT : LAYOUT_TYPES.VSPLIT;
    newConNode.rect = node.rect;
    newConNode.percent = node.percent;
    parentNode.insertBefore(newConNode, node);
    newConNode.appendChild(node);
    this.attachNode = newConNode;
  }

  swap(node, direction) {
    let nextSwapNode = this.next(node, direction);
    if (!nextSwapNode) {
      return;
    }
    let nodeSwapType = nextSwapNode.nodeType;

    switch (nodeSwapType) {
      case NODE_TYPES.WINDOW:
        break;
      case NODE_TYPES.CON:
      case NODE_TYPES.MONITOR:
        let childWindowNodes = nextSwapNode
          .getNodeByMode(Window.WINDOW_MODES.TILE)
          .filter((t) => t.nodeType === NODE_TYPES.WINDOW);
        if (nextSwapNode.layout === LAYOUT_TYPES.STACKED) {
          nextSwapNode = childWindowNodes[childWindowNodes.length - 1];
        } else {
          nextSwapNode = childWindowNodes[0];
        }
        break;
    }

    let isNextNodeWin =
      nextSwapNode && nextSwapNode.nodeValue && nextSwapNode.nodeType === NODE_TYPES.WINDOW;
    if (isNextNodeWin) {
      if (!this.extWm.sameParentMonitor(node, nextSwapNode)) {
        // TODO, there is a freeze bug if there are not in same monitor.
        return;
      }
      this.swapPairs(node, nextSwapNode);
    }
    return nextSwapNode;
  }

  swapPairs(fromNode, toNode, focus = true) {
    if (!(this._swappable(fromNode) && this._swappable(toNode))) return;
    // Swap the items in the array
    let parentForFrom = fromNode ? fromNode.parentNode : undefined;
    let parentForTo = toNode.parentNode;
    if (parentForTo && parentForFrom) {
      let nextIndex = toNode.index;
      let focusIndex = fromNode.index;

      let transferMode = fromNode.mode;
      fromNode.mode = toNode.mode;
      toNode.mode = transferMode;

      let transferRect = fromNode.nodeValue.get_frame_rect();
      let transferToRect = toNode.nodeValue.get_frame_rect();
      let transferPercent = fromNode.percent;

      fromNode.percent = toNode.percent;
      toNode.percent = transferPercent;

      parentForTo.childNodes[nextIndex] = fromNode;
      fromNode.parentNode = parentForTo;
      parentForFrom.childNodes[focusIndex] = toNode;
      toNode.parentNode = parentForFrom;

      this.extWm.move(fromNode.nodeValue, transferToRect);
      this.extWm.move(toNode.nodeValue, transferRect);

      if (focus) {
        // The fromNode is now on the parent-target
        const t = global.get_current_time();
        if (safeRaise(fromNode.nodeValue)) {
          safeFocus(fromNode.nodeValue, t);
        }
      }
    }
  }

  _swappable(node) {
    if (!node) return false;
    if (node.nodeType === NODE_TYPES.WINDOW && !node.nodeValue.minimized) {
      return true;
    }
    return false;
  }

  /**
   * Performs cleanup of dangling parents in addition to removing the
   * node from the parent.
   */
  removeNode(node) {
    let oldChild;

    let cleanUpParent = (existParent) => {
      if (this.getTiledChildren(existParent.childNodes).length === 0) {
        existParent.percent = 0.0;
        this.resetSiblingPercent(existParent.parentNode);
      }
      this.resetSiblingPercent(existParent);
    };

    let parentNode = node.parentNode;
    // If parent has only this window, remove the parent instead
    const removeParent =
      parentNode.childNodes.length === 1 && parentNode.nodeType !== NODE_TYPES.MONITOR;
    const removed = removeParent ? parentNode : node;
    const existParent = removed.parentNode;
    oldChild = existParent.removeChild(removed);
    if (removeParent || !this.extWm.floatingWindow(node)) {
      cleanUpParent(existParent);
      existParent.splitChosenFor = null;
    }
    this._forgetRemoved(removed);

    // If only a single tab remains, exit tabbed layout
    if (
      this.settings.get_boolean("auto-exit-tabbed") &&
      existParent.nodeType === NODE_TYPES.CON &&
      existParent.layout === LAYOUT_TYPES.TABBED &&
      existParent.groupWindowCount() === 1
    ) {
      existParent.restoreSplitLayout(this.extWm.determineSplitLayout());
      this.resetSiblingPercent(existParent);
      existParent.lastTabFocus = null;
    }

    if (node === this.attachNode) {
      this.attachNode = null;
    } else {
      // Find the next focus node as attachNode
      this.attachNode = this.findNode(this.extWm.focusMetaWindow);
    }

    return oldChild ? true : false;
  }

  /**
   * A subtree has left the tree for good: destroy the tabs of its windows and the tab bars of its
   * containers (whatever their layout: a container can still show tabs after it stopped being
   * tabbed, e.g. when all of its windows close at once). Tab bars of other containers keep their
   * tabs; a tab bar being destroyed only detaches tabs that belong to windows still in the tree.
   */
  _forgetRemoved(root) {
    const windows = root.isWindow() ? [root] : root.getNodeByType(NODE_TYPES.WINDOW);
    windows.forEach((w) => {
      w.tab?.destroy();
      w.tab = null;
    });
    const cons = new Set([...(root.isCon() ? [root] : []), ...root.getNodeByType(NODE_TYPES.CON)]);
    cons.forEach((con) => {
      con.tab?.destroy();
      con.tab = null;
      if (!con.decoration) return;
      con.decoration.remove_all_children();
      con.decoration.destroy();
      con.decoration = null;
    });
  }

  // Remove nested tab/stack wrappers while retaining splits inside their outer
  // group. Window nodes, actors, tabs, and signal handlers stay intact.
  normalizeGroups() {
    const visit = (parent, grouped = false) => {
      const withinGroup = grouped || parent.isTabbed() || parent.isStacked();
      for (let index = 0; index < parent.childNodes.length; index++) {
        const child = parent.childNodes[index];
        if (withinGroup && (child.isTabbed() || child.isStacked())) {
          const members = [...child.childNodes];
          for (const member of members) {
            member.tab?.get_parent()?.remove_child(member.tab);
            parent.insertBefore(member, child);
            member.percent = child.percent / Math.max(1, members.length);
          }
          parent.removeChild(child);
          // Detach any stale foreign window tabs before destroying this bar.
          child.decoration?.remove_all_children();
          child.decoration?.destroy();
          child.decoration = null;
          child.tab?.destroy();
          child.tab = null;
          child.actor?.destroy();
          if (this.attachNode === child) this.attachNode = parent;
          index--;
          continue;
        }
        visit(child, withinGroup);
      }
    };
    visit(this);
  }

  render(from) {
    Logger.debug(`render tree ${from ? "from " + from : ""}`);
    this.processNode(this);
    this.apply(this);
    this.cleanTree();
    let debugMode = true;
    if (debugMode) {
      this.debugTree();
    }
    Logger.debug(`*********************************************`);
  }

  apply(node) {
    if (!node) return;
    let tiledChildren = node
      .getNodeByMode(Window.WINDOW_MODES.TILE)
      .filter((t) => t.nodeType === NODE_TYPES.WINDOW);
    const moves = [];
    tiledChildren.forEach((w) => {
      if (w.renderRect) {
        if (w.renderRect.width > 0 && w.renderRect.height > 0) {
          moves.push([w.nodeValue, w.renderRect]);
        } else {
          Logger.debug(`ignoring apply for ${w.renderRect.width}x${w.renderRect.height}`);
        }
      }

      if (w.nodeValue.firstRender) w.nodeValue.firstRender = false;
    });
    // all together, so that windows giving up space are moved before those taking it
    this.extWm.moveAll(moves);
  }

  cleanTree() {
    // Phase 1: remove any cons with empty children
    const orphanCons = this.getNodeByType(NODE_TYPES.CON).filter((c) => c.childNodes.length === 0);
    const hasOrphanCons = orphanCons.length > 0;

    orphanCons.forEach((o) => {
      this.removeNode(o);
    });

    const invalidWindows = this.getNodeByType(NODE_TYPES.WINDOW).filter((w) => {
      const metaWindow = w.nodeValue;
      const title = metaWindow.title;
      const wmClass = metaWindow.wm_class;
      return wmClass === "gjs";
    });

    invalidWindows.forEach((w) => {
      this.removeNode(w);
    });

    // Phase 2: remove any empty parent cons up to the single intermediate parent-window level
    // Basically, flatten them?
    // [con[con[con[con[window]]]]] --> [con[window]]
    // TODO: help :)
    const grandParentCons = this.getNodeByType(NODE_TYPES.CON).filter(
      (c) =>
        !c.isTabbed() &&
        !c.isStacked() &&
        c.childNodes.length === 1 &&
        c.childNodes[0].nodeType === NODE_TYPES.CON
    );

    grandParentCons.forEach((c) => {
      c.layout = LAYOUT_TYPES.HSPLIT;
    });

    if (hasOrphanCons || invalidWindows.length > 0) {
      this.processNode(this);
      this.apply(this);
    }
  }

  /**
   *
   * Credits: Do the i3-like calculations
   *
   */
  processNode(node) {
    if (!node) return;
    if (node === this) this.normalizeGroups();

    // Render the Root, Workspace and Monitor
    // For now, we let them render their children recursively
    if (node.nodeType === NODE_TYPES.ROOT) {
      node.childNodes.forEach((child) => {
        this.processNode(child);
      });
    }

    if (node.nodeType === NODE_TYPES.WORKSPACE) {
      node.childNodes.forEach((child) => {
        this.processNode(child);
      });
    }

    let params = {};

    if (node.nodeType === NODE_TYPES.MONITOR || node.nodeType === NODE_TYPES.CON) {
      // The workarea from Meta.Window's assigned monitor
      // is important so it computes to `remove` the panel size
      // really well. However, this type of workarea would only
      // appear if there is window present on the monitor.
      if (node.childNodes.length === 0) {
        return;
      }

      // If monitor, get the workarea
      if (node.nodeType === NODE_TYPES.MONITOR) {
        let monitorIndex = Utils.monitorIndex(node.nodeValue);
        let monitorArea = global.display
          .get_workspace_manager()
          .get_active_workspace()
          .get_work_area_for_monitor(monitorIndex);
        if (!monitorArea) return; // there is no visible child window
        node.rect = monitorArea;
        node.rect = this.processGap(node);
      }

      let tiledChildren = this.getTiledChildren(node.childNodes);
      // Skip windows whose actors were destroyed mid-render
      let validChildren = tiledChildren.filter((c) => c.isNodeValid());
      let sizes = this.computeSizes(node, validChildren);

      params.sizes = sizes;
      let showTabs = this.settings.get_boolean("showtab-decoration-enabled");
      params.stackedHeight = showTabs ? this.defaultStackHeight * Utils.dpi() : 0;
      params.tiledChildren = tiledChildren;

      let decoration = node.decoration;

      if (decoration) {
        let decoChildren = decoration.get_children();
        decoChildren.forEach((decoChild) => {
          decoration.remove_child(decoChild);
        });
      }

      validChildren.forEach((child, index) => {
        // A monitor can contain a window or container child
        if (node.layout === LAYOUT_TYPES.HSPLIT || node.layout === LAYOUT_TYPES.VSPLIT) {
          this.processSplit(node, child, params, index);
        } else if (node.layout === LAYOUT_TYPES.STACKED) {
          this.processStacked(node, child, params, index);
        } else if (node.layout === LAYOUT_TYPES.TABBED) {
          this.processTabbed(node, child, params, index);
        }
        this.processNode(child);
      });
    }

    if (node.isWindow()) {
      if (!node.rect) node.rect = node.nodeValue.get_work_area_current_monitor();
      node.renderRect = this.processGap(node);
    }
  }

  /**
   * Forge processes both non-Window and Window gaps
   */
  processGap(node) {
    let nodeWidth = node.rect.width;
    let nodeHeight = node.rect.height;
    let nodeX = node.rect.x;
    let nodeY = node.rect.y;
    let gap = this.extWm.calculateGaps(node);

    if (nodeWidth > gap * 2 && nodeHeight > gap * 2) {
      nodeX += gap;
      nodeY += gap;

      // TODO - detect inbetween windows and adjust accordingly
      // Also adjust depending on display scaling
      nodeWidth -= gap * 2;
      nodeHeight -= gap * 2;
    }
    return { x: nodeX, y: nodeY, width: nodeWidth, height: nodeHeight };
  }

  processSplit(node, child, params, index) {
    let layout = node.layout;
    let nodeRect = node.rect;
    let nodeWidth;
    let nodeHeight;
    let nodeX;
    let nodeY;

    if (layout === LAYOUT_TYPES.HSPLIT) {
      // Divide the parent container's width
      // depending on number of children. And use this
      // to setup each child window's width.
      nodeWidth = params.sizes[index];
      nodeHeight = nodeRect.height;
      nodeX = nodeRect.x;
      if (index != 0) {
        let i = 1;
        while (i <= index) {
          nodeX += params.sizes[i - 1];
          i++;
        }
      }
      nodeY = nodeRect.y;
    } else if (layout === LAYOUT_TYPES.VSPLIT) {
      // split vertically
      // Conversely for vertical split, divide the parent container's height
      // depending on number of children. And use this
      // to setup each child window's height.
      nodeWidth = nodeRect.width;
      nodeHeight = params.sizes[index];
      nodeX = nodeRect.x;
      nodeY = nodeRect.y;
      if (index != 0) {
        let i = 1;
        while (i <= index) {
          nodeY += params.sizes[i - 1];
          i++;
        }
      }
    }

    child.rect = {
      x: nodeX,
      y: nodeY,
      width: nodeWidth,
      height: nodeHeight,
    };
  }

  /**
   * Process the child node here for the dimensions of the child stack/window,
   * It will be moved to the Node class in the future as Node.render()
   *
   */
  processStacked(node, child, params, index) {
    if (node.layout !== LAYOUT_TYPES.STACKED) return;
    const rect = node.rect;
    const rows = params.tiledChildren.length;
    if (!this.hasTitleList(node)) {
      // The cascade as before, where the top of each window before the focused one shows
      const stackHeight = node.childNodes.length > 1 ? this.defaultStackHeight : 0;
      child.rect = {
        x: rect.x,
        y: rect.y + stackHeight * index,
        width: rect.width,
        height: rect.height - stackHeight * index,
      };
      return;
    }
    // A list of every window's title at the top (like i3), and all the windows in the same place
    // below it: the focused one is raised, and any other is one click (or Super+J/K) away
    const listHeight = params.stackedHeight * rows;
    this._placeDecoration(node, child, index, listHeight, params.stackedHeight);
    child.rect = {
      x: rect.x,
      y: rect.y + listHeight,
      width: rect.width,
      height: rect.height - listHeight,
    };
  }

  /**
   * Whether a stacked container shows a title list (else the old cascade): title bars are on
   * (showtab-decoration-enabled), it has a bar to draw them in (a workspace-level stack has none),
   * and every tiled child has a title row: a container always gets one, a window has one unless
   * its app is unknown.
   */
  hasTitleList(node) {
    if (!node.isStacked() || !node.decoration) return false;
    if (!this.settings.get_boolean("showtab-decoration-enabled")) return false;
    const tiled = this.getTiledChildren(node.childNodes);
    return (
      tiled.length > 0 &&
      tiled.every((c) => c.isCon() || (c.isWindow() && c.isNodeValid() && c.tab))
    );
  }

  /**
   * Process the child node here for the dimensions of the child tab/window,
   * It will be moved to the Node class in the future as Node.render()
   *
   */
  processTabbed(node, child, params, index) {
    if (node.layout !== LAYOUT_TYPES.TABBED) return;
    const rect = node.rect;
    const height = node.groupWindowCount() > 1 ? params.stackedHeight : 0;
    this._placeDecoration(node, child, index, height);
    child.rect = {
      x: rect.x,
      y: rect.y + height,
      width: rect.width,
      height: rect.height - height,
    };
  }

  /**
   * Put a tabbed or stacked container's title bar at its top, `height` px high, and `child`'s tab
   * in it: side by side for tabs, or, with `rowHeight`, one row of that height per window (a stack).
   * The bar itself is placed once per container, with its first child (`index` 0).
   */
  _placeDecoration(node, child, index, height, rowHeight = 0) {
    const vertical = rowHeight > 0;
    const decoration = node.decoration;
    if (!decoration) return;
    if (index === 0) this._placeBar(node, child, decoration, height, vertical);
    if (!child.isNodeValid()) return;
    if (child.isCon()) this._updateConTab(child);
    if (child.tab && !decoration.contains(child.tab)) {
      try {
        child.tab.get_parent()?.remove_child(child.tab); // still in the bar of a group it left
        decoration.add_child(child.tab);
      } catch (e) {}
    }
    // A stack's rows get their share of the list exactly, less their CSS margins, so that they
    // neither overflow it nor take their natural height
    let rowSize = -1;
    if (vertical && child.tab) {
      rowSize = rowHeight;
      try {
        const theme = child.tab.get_theme_node();
        rowSize -= theme.get_margin(St.Side.TOP) + theme.get_margin(St.Side.BOTTOM);
      } catch (e) {
        rowSize -= 2; // not styled yet: the default theme's margins
      }
    }
    child.tab?.set_height(Math.max(rowSize, -1));
    child.render();
  }

  /**
   * Create or refresh the tab of `con`, a container in a tabbed or stacked group: the title and
   * icon of the window it shows (the one last used in it), and how many more windows it holds.
   */
  _updateConTab(con, forceIcon = false) {
    con._createConTab(() =>
      safeActivate(this.memberWindow(con)?.nodeValue, global.display.get_current_time())
    );
    // A dragged window still belongs to its group until the drop commits.
    // Keep its tab content current without including it in layout calculations.
    const shown = this.memberWindow(con, true);
    const count = con
      .getNodeByType(NODE_TYPES.WINDOW)
      .filter((w) => w.isTile() || w.isGrabTile()).length;
    if (!shown || !shown.isNodeValid() || !con.tab) return;
    // (not _getTitle(): the app of a window can be unknown, and this runs in the middle of a render)
    const title = shown.nodeValue?.title || shown.app?.get_name() || "";
    const titleButton = con.tab.get_child_at_index(1);
    if (titleButton) titleButton.label = count > 1 ? `${title} (+${count - 1})` : title;
    const iconBin = con.tab.get_child_at_index(0);
    const size = 24 * Utils.dpi();
    if (
      iconBin &&
      (forceIcon ||
        !iconBin.child ||
        con._tabApp !== shown.app ||
        con._tabWindow !== shown.nodeValue ||
        con._tabIconSize !== size)
    ) {
      con._tabApp = shown.app;
      con._tabWindow = shown.nodeValue;
      con._tabIconSize = size;
      iconBin.child = shown.createTabIcon(size);
    }
  }

  /**
   * The window a group member shows and goes back to: the member itself if it is a window,
   * otherwise the window last used in it (or its first).
   */
  memberWindow(member, includeGrabbed = false) {
    if (member.isWindow()) return member;
    const isMember = (node) => node.isTile() || (includeGrabbed && node.isGrabTile());
    // the window last focused in it (see WindowManager._rememberInGroups), if still a visible tile
    const last = member.lastMemberFocus;
    const node = last ? member.getNodeByValue(last) : null;
    if (node && node.isWindow() && isMember(node) && !last.minimized) return node;
    // else one that is shown (a minimized window still counts as tiled)
    const shown = member
      .getNodeByType(NODE_TYPES.WINDOW)
      .find((w) => isMember(w) && !w.nodeValue.minimized);
    return shown ?? this._entryWindow(member, false);
  }

  /**
   * The windows that show when `node` is shown: all of a split's, and of a tabbed or stacked
   * group only its current member's (the one holding `focus`, else the one last used). A stack
   * without a title list is the old cascade, where every member shows: then all of them, the
   * one holding `focus` last.
   */
  shownWindows(node, focus = null) {
    if (node.isWindow()) return node.isTile() && !node.nodeValue.minimized ? [node] : [];
    const tiled = this.getTiledChildren(node.childNodes);
    if (node.isStacked() && !this.hasTitleList(node)) {
      const holds = (c) => focus && (c === focus || c.contains(focus));
      const ordered = [...tiled.filter((c) => !holds(c)), ...tiled.filter(holds)];
      return ordered.flatMap((c) => this.shownWindows(c, focus));
    }
    if (node.isTabbed() || node.isStacked()) {
      const holds = (c, w) => w && (c === w || c.contains(w));
      const member =
        tiled.find((c) => holds(c, focus)) ??
        tiled.find((c) => holds(c, this._lastUsedIn(node))) ??
        tiled[0];
      return member ? this.shownWindows(member, focus) : [];
    }
    return tiled.flatMap((c) => this.shownWindows(c, focus));
  }

  /** The container-level part of _placeDecoration(): the bar's place, size and direction. */
  _placeBar(node, child, decoration, height, vertical) {
    let gap = this.extWm.calculateGaps(node);
    let renderRect = this.processGap(node);
    // The windows' border, from a window of the group (the first child may be a container).
    // Border actor may be gone if the window was destroyed mid-render
    const window = child.isWindow() ? child : node.childNodes.find((c) => c.isWindow());
    let borderWidth = 0;
    try {
      if (window?.actor?.border) {
        borderWidth = window.actor.border.get_theme_node().get_border_width(St.Side.TOP);
      }
    } catch (e) {}

    // Make adjustments to the gaps
    let adjust = 4 * Utils.dpi();
    let adjustWidth = renderRect.width + (borderWidth * 2 + gap) / adjust;
    let adjustX = renderRect.x - (gap + borderWidth * 2) / (adjust * 2);
    let adjustY = renderRect.y - adjust;

    if (gap === 0) {
      adjustY = renderRect.y;
    }

    if ("orientation" in decoration) {
      decoration.orientation = vertical
        ? Clutter.Orientation.VERTICAL
        : Clutter.Orientation.HORIZONTAL;
    } else {
      decoration.vertical = vertical; // GNOME < 48
    }
    decoration.set_size(adjustWidth, height);
    decoration.set_position(adjustX, adjustY);
    if (height !== 0) {
      decoration.show();
    } else {
      decoration.hide();
    }
  }

  computeSizes(node, childItems) {
    let orientation = Utils.orientationFromLayout(node.layout);
    let totalSize =
      orientation === ORIENTATION_TYPES.HORIZONTAL ? node.rect.width : node.rect.height;
    let grabTiled = node.getNodeByMode(Window.WINDOW_MODES.GRAB_TILE).length > 0;
    let percents = childItems.map((childNode) =>
      childNode.percent && childNode.percent > 0.0 && !grabTiled
        ? childNode.percent
        : 1.0 / childItems.length
    );
    // Only splits use the sizes (tabbed and stacked children share the whole container)
    let split = node.isHSplit() || node.isVSplit();
    let mins = childItems.map((childNode) => (split ? this.minSizeOf(childNode, orientation) : 0));
    return this.fitSizes(percents, mins, totalSize);
  }

  /**
   * Split `totalSize` px between children in proportion to `percents`, but give every child at
   * least its minimum size: a child that would get less gets its minimum and the difference comes
   * from the others. If the minimums don't all fit, they are scaled down together, so every
   * child is short of its minimum by the same fraction. The sizes always add up to exactly
   * `totalSize`, so the children fill their container without a gap or overlap, even if the
   * percents do not sum to 1.
   */
  fitSizes(percents, mins, totalSize) {
    const count = percents.length;
    const minTotal = mins.reduce((sum, min) => sum + min, 0);
    if (minTotal > totalSize) mins = mins.map((min) => (min * totalSize) / minTotal);
    const sizes = new Array(count).fill(0);
    const atMin = new Array(count).fill(false);

    let changed = true;
    while (changed) {
      changed = false;
      let free = totalSize;
      let share = 0;
      for (let i = 0; i < count; i++) {
        if (atMin[i]) free -= mins[i];
        else share += percents[i];
      }
      for (let i = 0; i < count; i++) {
        if (atMin[i]) {
          sizes[i] = mins[i];
          continue;
        }
        sizes[i] = share > 0 ? (free * percents[i]) / share : 0;
        if (sizes[i] < mins[i]) {
          atMin[i] = true;
          changed = true;
        }
      }
    }

    const rounded = sizes.map((size) => Math.round(size));
    const rest = totalSize - rounded.reduce((sum, size) => sum + size, 0);
    if (count > 0 && rest !== 0) {
      // The rounding remainder goes to the child with the most room above its minimum
      let k = 0;
      for (let i = 1; i < count; i++) if (rounded[i] - mins[i] > rounded[k] - mins[k]) k = i;
      rounded[k] += rest;
    }
    return rounded;
  }

  /**
   * The smallest size (px, gaps included) that `node` can take along `orientation`
   * without any of its windows going below the minimum size its app allows.
   * Windows without a minimum size, and GNOME versions that cannot report it (< 50),
   * use a small floor so that a node can never shrink to nothing.
   */
  minSizeOf(node, orientation, gap = null) {
    if (!node) return 0;
    const horizontal = orientation === ORIENTATION_TYPES.HORIZONTAL;
    // The gap only depends on the monitor, so it is looked up once per call
    if (gap === null) {
      const firstWindow = node.isWindow() ? node : node.getNodeByType(NODE_TYPES.WINDOW)[0];
      gap = firstWindow ? this.extWm.calculateGaps(firstWindow) : 0;
    }

    if (node.isWindow()) {
      const metaWindow = node.nodeValue;
      let min = 0;
      if (metaWindow && typeof metaWindow.get_min_size === "function") {
        try {
          const [hasMin, minWidth, minHeight] = metaWindow.get_min_size();
          if (hasMin) {
            // The minimum is a client size; convert it to a frame size (CSD shadows, SSD title bar)
            const rect = metaWindow.get_frame_rect();
            rect.width = minWidth;
            rect.height = minHeight;
            const frame = metaWindow.client_rect_to_frame_rect(rect);
            min = horizontal ? frame.width : frame.height;
          }
        } catch (e) {
          // the window may be going away mid-render
        }
      }
      return Math.max(min, MIN_WINDOW_SIZE) + gap * 2;
    }

    const children = this.getTiledChildren(node.childNodes).filter((c) => c.isNodeValid());
    if (children.length === 0) return 0;
    const mins = children.map((child) => this.minSizeOf(child, orientation, gap));
    if ((node.isHSplit() && horizontal) || (node.isVSplit() && !horizontal)) {
      return mins.reduce((sum, min) => sum + min, 0);
    }

    // Children share the node's full size; stacked and tabbed headers take some of the height
    let min = Math.max(...mins);
    if (!horizontal && node.isStacked()) {
      min +=
        this.defaultStackHeight *
        (this.hasTitleList(node) ? Utils.dpi() * children.length : children.length - 1);
    } else if (!horizontal && node.isTabbed()) {
      const showTabs = this.settings.get_boolean("showtab-decoration-enabled");
      min += showTabs && node.groupWindowCount() > 1 ? this.defaultStackHeight * Utils.dpi() : 0;
    }
    return min;
  }

  /**
   * Set the shares of the split `node`'s tiled children from their current sizes (what is
   * shown), so that a resize which changes some of them leaves the others exactly where they are.
   * Stored shares can differ from what is shown: 0 means an equal split, and minimum sizes can
   * override a share. Children that are not shown (minimized, floating) get no share. Returns
   * false (and changes nothing) if a child has not been laid out yet.
   */
  syncShares(node) {
    if (!node.rect || !(node.isHSplit() || node.isVSplit())) return false;
    const horizontal = node.isHSplit();
    const total = horizontal ? node.rect.width : node.rect.height;
    const shown = this.getTiledChildren(node.childNodes).filter((c) => c.isNodeValid());
    if (!total || shown.some((c) => !c.rect)) return false;
    node.childNodes.forEach((c) => {
      c.percent = shown.includes(c) ? (horizontal ? c.rect.width : c.rect.height) / total : 0;
    });
    return true;
  }

  findFirstNodeWindowFrom(node) {
    let results = node.getNodeByType(NODE_TYPES.WINDOW);
    if (results.length > 0) {
      return results[0];
    }
    return null;
  }

  resetSiblingPercent(parentNode) {
    if (!parentNode) return;
    let children = parentNode.childNodes;
    children.forEach((n) => {
      n.percent = 0.0;
    });
  }

  debugTree() {
    // this.debugChildNodes(this);
  }

  debugChildNodes(node) {
    this.debugNode(this);
    node.childNodes.forEach((child) => {
      this.debugChildNodes(child);
    });
  }

  debugParentNodes(node) {
    if (node) {
      if (node.parentNode) {
        this.debugParentNodes(node.parentNode);
      }
      this.debugNode(node);
    }
  }

  debugNode(node) {
    let spacing = "";
    let dashes = "-->";
    let level = node.level;
    for (let i = 0; i < level; i++) {
      let parentSpacing = i === 0 ? " " : "|";
      spacing += `${parentSpacing}   `;
    }
    let rootSpacing = level === 0 ? "#" : "*";

    let attributes = "";

    if (node.isWindow && node.isWindow()) {
      let metaWindow = node.nodeValue;
      attributes += `class:'${metaWindow.get_wm_class()}',title:'${
        metaWindow.title
      }',string:'${metaWindow}'${metaWindow === this.extWm.focusMetaWindow ? " FOCUS" : ""}`;
    } else if (node.isCon() || node.isMonitor() || node.isWorkspace()) {
      attributes += `${node.nodeValue}`;
      if (node.isCon() || node.isMonitor()) {
        attributes += `,layout:${node.layout}`;
      }
    }

    if (node.rect) {
      attributes += `,rect:${node.rect.width}x${node.rect.height}+${node.rect.x}+${node.rect.y}`;
      const pointerCoord = global.get_pointer();
      const pointerInside = Utils.rectContainsPoint(node.rect, pointerCoord) ? "yes" : "no";
      attributes += `,pointer:${pointerInside}`;
    }

    if (level !== 0) Logger.debug(`${spacing}|`);
    Logger.debug(
      `${spacing}${rootSpacing}${dashes} ${node.nodeType}#${
        node.index !== null ? node.index : "-"
      } @${attributes}`
    );
  }

  findParent(childNode, parentNodeType) {
    let parents = this.getNodeByType(parentNodeType);
    // Only get the first parent
    return parents.filter((p) => p.contains(childNode))[0];
  }
}
