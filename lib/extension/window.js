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
// mayconrcmello: #520, #524, #527.
// mattchristenson: #550, #551, #552, #553, #554, #555, #556, #557, #558, #562, #567, #568, #569, #570, #571, #573, #574, #575, #578, #580, #582.
// PR links: https://github.com/forge-ext/forge/pull/<number>

// Gnome imports
import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import GObject from "gi://GObject";
import Meta from "gi://Meta";
import St from "gi://St";

// Gnome Shell imports
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { PACKAGE_VERSION } from "resource:///org/gnome/shell/misc/config.js";

// Shared state
import { Logger } from "../shared/logger.js";

// App imports
import * as Utils from "./utils.js";
import { isWindowAlive, safeRaise, safeFocus, safeActivate } from "./mutter-safe.js";
import { Keybindings } from "./keybindings.js";
import { Tree, Queue, Node, LAYOUT_TYPES, ORIENTATION_TYPES, NODE_TYPES } from "./tree.js";
import { production } from "../shared/settings.js";
import { Layouts } from "./layouts.js";

/** @typedef {import('../../extension.js').default} ForgeExtension */

export const WINDOW_MODES = Utils.createEnum(["FLOAT", "TILE", "GRAB_TILE", "DEFAULT"]);

// Simplify the grab modes
export const GRAB_TYPES = Utils.createEnum(["RESIZING", "MOVING", "UNKNOWN"]);

// The longest a window waits for its new place without progress (see moveAll)
const MOVE_MAX_WAIT_MS = 500;

export class WindowManager extends GObject.Object {
  static {
    GObject.registerClass(this);
  }

  /** @type {ForgeExtension} */
  ext;

  /** @param {ForgeExtension} ext */
  constructor(ext) {
    super();
    this.ext = ext;
    this.prefsTitle = `Forge ${_("Settings")} - ${
      !production
        ? "DEV"
        : `${PACKAGE_VERSION}-${
            ext.metadata["version-name"] ?? ext.metadata.version ?? "development"
          }`
    }`;
    this.reloadWindowOverrides();
    this._kbd = this.ext.keybindings;
    this._tree = new Tree(this);
    this.eventQueue = new Queue();
    this.theme = this.ext.theme;
    this.lastFocusedWindow = null;
    this.shouldFocusOnHover = this.ext.settings.get_boolean("focus-on-hover-enabled");
    this.layouts = new Layouts(this);

    Logger.info("forge initialized");

    if (this.shouldFocusOnHover) {
      // Start the pointer loop to observe the pointer position
      // and change the focus window accordingly
      this.pointerLoopInit();
    }
  }

  pointerLoopInit() {
    if (this._pointerFocusTimeoutId) {
      GLib.Source.remove(this._pointerFocusTimeoutId);
    }

    this._pointerFocusTimeoutId = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      16,
      this._focusWindowUnderPointer.bind(this)
    );
  }

  addFloatOverride(metaWindow, withWmId) {
    let currentProps = this.ext.configMgr.windowProps;
    let overrides = currentProps.overrides;
    let wmClass = metaWindow.get_wm_class();
    let wmId = metaWindow.get_id();

    for (let override of overrides) {
      // if the window is already floating: for Super+C only a rule for this very window counts
      // (another window of the app may float already, #492), for "always float" only a rule for
      // the whole app (not one that Super+C made for a single window)
      if (override.wmClass === wmClass && override.mode === "float" && !override.wmTitle) {
        if (withWmId ? override.wmId !== wmId : override.wmId) continue;
        return;
      }
    }
    overrides.push({
      wmClass: wmClass,
      wmId: withWmId ? wmId : undefined,
      mode: "float",
    });

    // Save the updated overrides back to the ConfigManager
    currentProps.overrides = overrides;
    this.ext.configMgr.windowProps = currentProps;
  }

  removeFloatOverride(metaWindow, withWmId) {
    let currentProps = this.ext.configMgr.windowProps;
    let overrides = currentProps.overrides;
    let wmClass = metaWindow.get_wm_class();
    let wmId = metaWindow.get_id();
    overrides = overrides.filter(
      (override) =>
        !(
          override.wmClass === wmClass &&
          // rules with a Title are written by the user and peristent
          !override.wmTitle &&
          // Super+C: this window's rule; "always float": the app's rule (and this window's own),
          // not the rules Super+C made for its other windows
          (withWmId ? override.wmId === wmId : !override.wmId || override.wmId === wmId)
        )
    );

    // Save the updated overrides back to the ConfigManager
    currentProps.overrides = overrides;
    this.ext.configMgr.windowProps = currentProps;
  }

  toggleFloatingMode(action, metaWindow) {
    let nodeWindow = this.findNodeWindow(metaWindow);
    if (!nodeWindow || !(action || action.mode)) return;
    if (nodeWindow.nodeType !== NODE_TYPES.WINDOW) return;

    let withWmId = action.name === "FloatToggle";
    let floatingExempt = this.isFloatingExempt(metaWindow);

    if (floatingExempt) {
      this.removeFloatOverride(metaWindow, withWmId);
      this.windowProps = this.ext.configMgr.windowProps;
      if (!this.isActiveWindowWorkspaceTiled(metaWindow)) {
        nodeWindow.mode = WINDOW_MODES.FLOAT;
      } else {
        nodeWindow.mode = WINDOW_MODES.TILE;
      }
    } else {
      this.addFloatOverride(metaWindow, withWmId);
      this.windowProps = this.ext.configMgr.windowProps;
      nodeWindow.mode = WINDOW_MODES.FLOAT;
    }
  }

  queueEvent(eventObj, interval = 220) {
    this.eventQueue.enqueue(eventObj);

    if (!this._queueSourceId) {
      this._queueSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
        const currEventObj = this.eventQueue.dequeue();
        if (currEventObj) {
          currEventObj.callback();
        }
        const result = this.eventQueue.length !== 0;
        if (!result) {
          this._queueSourceId = 0;
        }
        return result;
      });
    }
  }

  /**
   * This is the central place to bind all the non-window signals.
   */
  _bindSignals() {
    if (this._signalsBound) return;

    const display = global.display;
    const shellWm = global.window_manager;

    this._displaySignals = [
      display.connect("window-created", this.trackWindow.bind(this)),
      display.connect("grab-op-begin", this._handleGrabOpBegin.bind(this)),
      display.connect("window-entered-monitor", (_, monitor, metaWindow) => {
        this.updateMetaWorkspaceMonitor("window-entered-monitor", monitor, metaWindow);
        this.trackCurrentMonWs();
      }),
      display.connect("grab-op-end", this._handleGrabOpEnd.bind(this)),
      display.connect("showing-desktop-changed", () => {
        this.hideWindowBorders();
        this.updateDecorationLayout();
      }),
      display.connect("in-fullscreen-changed", () => {
        this.renderTree("full-screen-changed");
      }),
      display.connect("workareas-changed", (_display) => {
        if (this.layouts?.transitioning) return;
        if (global.display.get_n_monitors() == 0) {
          Logger.debug(`workareas-changed: no monitors, ignoring signal`);
          return;
        }
        if (this.tree.getNodeByType("WINDOW").length > 0) {
          let workspaceReload = this.workspaceAdded || this.workspaceRemoved;
          if (workspaceReload) {
            this.trackCurrentWindows();
            this.workspaceRemoved = false;
            this.workspaceAdded = false;
          } else {
            this.renderTree("workareas-changed");
          }
        }
      }),
    ];

    this._windowManagerSignals = [
      shellWm.connect("minimize", () => {
        this.hideWindowBorders();
        let focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
        if (focusNodeWindow) {
          if (this.tree.getTiledChildren(focusNodeWindow.parentNode.childNodes).length === 0) {
            this.tree.resetSiblingPercent(focusNodeWindow.parentNode.parentNode);
          }
          this.tree.resetSiblingPercent(focusNodeWindow.parentNode);
        }

        let prevFrozen = this._freezeRender;
        if (prevFrozen) this.unfreezeRender();
        this.renderTree("minimize");
        if (prevFrozen) this.freezeRender();
      }),
      shellWm.connect("unminimize", () => {
        let focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
        if (focusNodeWindow) {
          this.tree.resetSiblingPercent(focusNodeWindow.parentNode);
        }

        let prevFrozen = this._freezeRender;
        if (prevFrozen) this.unfreezeRender();
        this.renderTree("unminimize");
        if (prevFrozen) this.freezeRender();
      }),
      shellWm.connect("show-tile-preview", (_, _metaWindow, _rect, _num) => {
        // Empty
      }),
    ];

    const globalWsm = global.workspace_manager;

    this._workspaceManagerSignals = [
      globalWsm.connect("showing-desktop-changed", () => {
        this.hideWindowBorders();
        this.updateDecorationLayout();
      }),
      globalWsm.connect("workspace-added", (_, wsIndex) => {
        this.tree.addWorkspace(wsIndex);
        this.trackCurrentMonWs();
        this.workspaceAdded = true;
        this.renderTree("workspace-added");
      }),
      globalWsm.connect("workspace-removed", (_, wsIndex) => {
        this.layouts?.workspaceRemoved(wsIndex);
        this.tree.removeWorkspace(wsIndex);
        this.trackCurrentMonWs();
        this.workspaceRemoved = true;
        this.updateDecorationLayout();
        this.renderTree("workspace-removed");
      }),
      globalWsm.connect("active-workspace-changed", () => {
        this.hideWindowBorders();
        this.trackCurrentMonWs();
        this.updateDecorationLayout();
        this.renderTree("active-workspace-changed");
      }),
    ];

    let numberOfWorkspaces = globalWsm.get_n_workspaces();

    for (let i = 0; i < numberOfWorkspaces; i++) {
      let workspace = globalWsm.get_workspace_by_index(i);
      this.bindWorkspaceSignals(workspace);
    }

    let settings = this.ext.settings;

    // (kept to disconnect in _removeSignals: the extension drops its settings on disable, and
    // a handler left connected failed on every later change)
    this._settings = settings;
    this._settingsChangedId = settings.connect("changed", (_, settingName) => {
      switch (settingName) {
        case "window-overrides-reload-trigger":
          // Reload window overrides when triggered by preferences
          // This prevents the main extension from overwriting changes made by preferences
          this.reloadWindowOverrides();
          break;
        case "focus-border-toggle":
          this.renderTree(settingName);
          break;
        case "focus-on-hover-enabled":
          this.shouldFocusOnHover = settings.get_boolean(settingName);

          if (this.shouldFocusOnHover) {
            this.pointerLoopInit();
          }

          break;
        case "tiling-mode-enabled":
          this.renderTree(settingName);
          break;
        case "window-gap-size-increment":
        case "window-gap-size":
        case "window-gap-hidden-on-single":
        case "workspace-skip-tile":
          this.renderTree(settingName, true);
          break;
        case "stacked-tiling-mode-enabled":
          if (!settings.get_boolean(settingName)) {
            let stackedNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.STACKED);
            stackedNodes.forEach((node) => {
              node.prevLayout = node.layout;
              node.restoreSplitLayout(this.determineSplitLayout());
            });
          } else {
            let hSplitNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.HSPLIT);
            let vSplitNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.VSPLIT);
            Array.prototype.push.apply(hSplitNodes, vSplitNodes);
            hSplitNodes.forEach((node) => {
              if (node.prevLayout && node.prevLayout === LAYOUT_TYPES.STACKED) {
                node.setGroupLayout(LAYOUT_TYPES.STACKED);
              }
            });
          }
          this.renderTree(settingName);
          break;
        case "tabbed-tiling-mode-enabled":
          if (!settings.get_boolean(settingName)) {
            let tabbedNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.TABBED);
            tabbedNodes.forEach((node) => {
              node.prevLayout = node.layout;
              node.restoreSplitLayout(this.determineSplitLayout());
            });
          } else {
            let hSplitNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.HSPLIT);
            let vSplitNodes = this.tree.getNodeByLayout(LAYOUT_TYPES.VSPLIT);
            Array.prototype.push.apply(hSplitNodes, vSplitNodes);
            hSplitNodes.forEach((node) => {
              if (node.prevLayout && node.prevLayout === LAYOUT_TYPES.TABBED) {
                node.setGroupLayout(LAYOUT_TYPES.TABBED);
              }
            });
          }
          this.renderTree(settingName);
          break;
        case "css-updated":
          this.theme.reloadStylesheet();
          break;
        case "float-always-on-top-enabled":
          if (!settings.get_boolean(settingName)) {
            this.cleanupAlwaysFloat();
          } else {
            this.restoreAlwaysFloat();
          }
          break;
        default:
          break;
      }
    });

    this._overviewSignals = [
      Main.overview.connect("hiding", () => {
        this.fromOverview = true;
        const eventObj = {
          name: "focus-after-overview",
          callback: () => {
            const focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
            this.updateStackedFocus(focusNodeWindow);
            this.updateTabbedFocus(focusNodeWindow);
            this.movePointerWith(focusNodeWindow);
          },
        };
        this.queueEvent(eventObj);
      }),
      Main.overview.connect("showing", () => {
        this.toOverview = true;
      }),
    ];

    this._signalsBound = true;
  }

  cleanupAlwaysFloat() {
    // remove the setting for each node window
    this.allNodeWindows.forEach((w) => {
      if (w.mode === WINDOW_MODES.FLOAT) {
        w.nodeValue.is_above() && w.nodeValue.unmake_above();
      }
    });
  }

  restoreAlwaysFloat() {
    this.allNodeWindows.forEach((w) => {
      if (w.mode === WINDOW_MODES.FLOAT) {
        !w.nodeValue.is_above() && w.nodeValue.make_above();
      }
    });
  }

  trackCurrentMonWs() {
    let metaWindow = this.focusMetaWindow;
    if (!metaWindow) return;
    const currentMonitor = global.display.get_current_monitor();
    const currentWorkspace = global.display.get_workspace_manager().get_active_workspace_index();

    let currentMonWs = `mo${currentMonitor}ws${currentWorkspace}`;
    let activeMetaMonWs = `mo${metaWindow.get_monitor()}ws${metaWindow.get_workspace().index()}`;
    let currentWsNode = this.tree.findNode(`ws${currentWorkspace}`);

    if (!currentWsNode) {
      return;
    }

    // Search for all the valid windows on the workspace
    const monWindows = currentWsNode.getNodeByType(NODE_TYPES.WORKSPACE).flatMap((ws) => {
      return ws
        .getNodeByType(NODE_TYPES.WINDOW)
        .filter(
          (w) =>
            !w.nodeValue.minimized &&
            w.isTile() &&
            w.nodeValue !== metaWindow &&
            // The searched window should be on the same monitor workspace
            // This ensures that Forge already updated the workspace node tree:
            currentMonWs === activeMetaMonWs
        )
        .map((w) => w.nodeValue);
    });

    this.sortedWindows = global.display.sort_windows_by_stacking(monWindows).reverse();
  }

  // TODO move this to workspace.js
  bindWorkspaceSignals(metaWorkspace) {
    if (metaWorkspace) {
      if (!metaWorkspace.workspaceSignals) {
        let workspaceSignals = [
          metaWorkspace.connect("window-added", (_, metaWindow) => {
            if (!this._wsWindowAddSrcId) {
              this._wsWindowAddSrcId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this.updateMetaWorkspaceMonitor(
                  "window-added",
                  metaWindow.get_monitor(),
                  metaWindow
                );
                this._wsWindowAddSrcId = 0;
                return false;
              });
            }
          }),
        ];
        metaWorkspace.workspaceSignals = workspaceSignals;
      }
    }
  }

  // TODO move this in command.js
  command(action) {
    let focusWindow = this.focusMetaWindow;
    // Do not check if the node window is null, some of the commands do not need the focus window
    let focusNodeWindow = this.findNodeWindow(focusWindow);
    let currentLayout;

    switch (action.name) {
      case "FloatNonPersistentToggle":
      case "FloatToggle":
      case "FloatClassToggle":
        this.toggleFloatingMode(action, focusWindow);

        const rectRequest = {
          x: action.x,
          y: action.y,
          width: action.width,
          height: action.height,
        };

        let moveRect = {
          x: Utils.resolveX(rectRequest, focusWindow),
          y: Utils.resolveY(rectRequest, focusWindow),
          width: Utils.resolveWidth(rectRequest, focusWindow),
          height: Utils.resolveHeight(rectRequest, focusWindow),
        };

        this.move(focusWindow, moveRect);

        let existParent = focusNodeWindow.parentNode;

        if (this.tree.getTiledChildren(existParent.childNodes).length <= 1) {
          existParent.percent = 0.0;
          this.tree.resetSiblingPercent(existParent.parentNode);
        }

        this.tree.resetSiblingPercent(existParent);
        this.renderTree("float-toggle", true);
        break;
      case "Move":
        this.unfreezeRender();
        let moveDirection = Utils.resolveDirection(action.direction);
        let prev = focusNodeWindow;
        let moved = this.tree.move(focusNodeWindow, moveDirection);
        if (!focusNodeWindow) {
          focusNodeWindow = this.findNodeWindow(this.focusMetaWindow);
        }
        this.queueEvent({
          name: "move",
          callback: () => {
            if (this.eventQueue.length <= 0) {
              this.unfreezeRender();
              const t = global.display.get_current_time();
              if (focusNodeWindow.parentNode.layout === LAYOUT_TYPES.STACKED) {
                if (!this.tree.hasTitleList(focusNodeWindow.parentNode))
                  focusNodeWindow.parentNode.appendChild(focusNodeWindow);
                if (safeRaise(focusNodeWindow.nodeValue)) {
                  safeActivate(focusNodeWindow.nodeValue, t);
                }
                this.renderTree("move-stacked-queue");
              }
              if (focusNodeWindow.parentNode.layout === LAYOUT_TYPES.TABBED) {
                if (safeRaise(focusNodeWindow.nodeValue)) {
                  safeActivate(focusNodeWindow.nodeValue, t);
                }
                if (prev) prev.parentNode.lastTabFocus = prev.nodeValue;
                this.renderTree("move-tabbed-queue");
              }
              this.movePointerWith(focusNodeWindow);
            }
          },
        });
        if (moved) {
          if (prev) prev.parentNode.lastTabFocus = prev.nodeValue;
          this.renderTree("move-window");
        }

        break;
      case "Focus":
        let focusDirection = Utils.resolveDirection(action.direction);
        focusNodeWindow = this.tree.focus(focusNodeWindow, focusDirection);
        if (!focusNodeWindow) {
          focusNodeWindow = this.findNodeWindow(this.focusMetaWindow);
        }
        break;
      case "Swap":
        if (!focusNodeWindow) return;
        this.unfreezeRender();
        let swapDirection = Utils.resolveDirection(action.direction);
        this.tree.swap(focusNodeWindow, swapDirection);
        safeRaise(focusNodeWindow.nodeValue);
        this.updateTabbedFocus(focusNodeWindow);
        this.updateStackedFocus(focusNodeWindow);
        this.movePointerWith(focusNodeWindow);
        this.renderTree("swap", true);
        break;
      case "Split":
        if (!focusNodeWindow) return;
        currentLayout = focusNodeWindow.parentNode.layout;
        if (currentLayout === LAYOUT_TYPES.STACKED || currentLayout === LAYOUT_TYPES.TABBED) {
          return;
        }
        let orientation = action.orientation
          ? action.orientation.toUpperCase()
          : ORIENTATION_TYPES.NONE;
        this.tree.split(focusNodeWindow, orientation);
        // mattchristenson, upstream PR #578: honor an explicit split for the next window.
        // https://github.com/forge-ext/forge/pull/578
        if (!action.auto && this.tree.attachNode)
          this.tree.attachNode.splitChosenFor = focusNodeWindow.nodeValue;
        this.renderTree("split");
        break;
      case "LayoutToggle":
        if (!focusNodeWindow) return;
        currentLayout = focusNodeWindow.parentNode.layout;
        if (currentLayout === LAYOUT_TYPES.HSPLIT) {
          focusNodeWindow.parentNode.layout = LAYOUT_TYPES.VSPLIT;
        } else if (currentLayout === LAYOUT_TYPES.VSPLIT) {
          focusNodeWindow.parentNode.layout = LAYOUT_TYPES.HSPLIT;
        } else {
          // Tabbed/stacked/monitor parent — fall back to a split layout
          // so the binding always does something. Without this, focusing
          // a window whose parent is not already an HSPLIT/VSPLIT (e.g.
          // sitting directly under MONITOR, or inside a tabbed container)
          // makes Super+G a silent no-op.
          focusNodeWindow.parentNode.layout = this.determineSplitLayout();
        }
        this.tree.attachNode = focusNodeWindow.parentNode;
        this.renderTree("layout-split-toggle");
        break;
      case "FocusBorderToggle":
        let focusBorderEnabled = this.ext.settings.get_boolean("focus-border-toggle");
        this.ext.settings.set_boolean("focus-border-toggle", !focusBorderEnabled);
        break;
      case "TilingModeToggle":
        // FIXME, not sure if this toggle is still needed from a use case
        // perspective, since Extension.disable also should do the same thing.
        let tilingModeEnabled = this.ext.settings.get_boolean("tiling-mode-enabled");
        this.ext.settings.set_boolean("tiling-mode-enabled", !tilingModeEnabled);
        if (tilingModeEnabled) {
          this.floatAllWindows();
        } else {
          this.unfloatAllWindows();
        }
        this.renderTree(`tiling-mode-toggle ${!tilingModeEnabled}`);
        break;
      case "GapSize":
        let gapIncrement = this.ext.settings.get_uint("window-gap-size-increment");
        let amount = action.amount;
        gapIncrement = gapIncrement + amount;
        if (gapIncrement < 0) gapIncrement = 0;
        if (gapIncrement > 8) gapIncrement = 8;
        this.ext.settings.set_uint("window-gap-size-increment", gapIncrement);
        break;
      case "WorkspaceActiveTileToggle":
        let activeWorkspace = global.workspace_manager.get_active_workspace_index();
        let skippedWorkspaces = this.ext.settings.get_string("workspace-skip-tile");
        let workspaceSkipped = false;
        let skippedArr = [];
        if (skippedWorkspaces.length === 0) {
          skippedArr.push(`${activeWorkspace}`);
          this.floatWorkspace(activeWorkspace);
        } else {
          skippedArr = skippedWorkspaces.split(",");

          for (let i = 0; i < skippedArr.length; i++) {
            if (`${skippedArr[i]}` === `${activeWorkspace}`) {
              workspaceSkipped = true;
              break;
            }
          }

          if (workspaceSkipped) {
            // tile this workspace
            let indexWs = skippedArr.indexOf(`${activeWorkspace}`);
            skippedArr.splice(indexWs, 1);
            this.unfloatWorkspace(activeWorkspace);
          } else {
            // skip tiling workspace
            skippedArr.push(`${activeWorkspace}`);
            this.floatWorkspace(activeWorkspace);
          }
        }
        this.ext.settings.set_string("workspace-skip-tile", skippedArr.toString());
        this.renderTree("workspace-toggle");
        break;
      case "LayoutStackedToggle":
        if (!focusNodeWindow) return;
        if (!this.ext.settings.get_boolean("stacked-tiling-mode-enabled")) return;

        // A window directly on the workspace gets a container of its own first; that container's
        // direction isn't the user's, so it isn't remembered
        const parentBefore = focusNodeWindow.parentNode;
        if (parentBefore.isMonitor()) {
          this.tree.split(focusNodeWindow, ORIENTATION_TYPES.HORIZONTAL, true);
        }
        // (a floating window isn't wrapped: then its parent, the monitor, keeps its direction)
        const wrapped = focusNodeWindow.parentNode !== parentBefore;

        currentLayout = focusNodeWindow.parentNode.layout;

        if (currentLayout === LAYOUT_TYPES.STACKED) {
          focusNodeWindow.parentNode.restoreSplitLayout(this.determineSplitLayout());
          this.tree.resetSiblingPercent(focusNodeWindow.parentNode);
        } else {
          if (currentLayout === LAYOUT_TYPES.TABBED) {
            focusNodeWindow.parentNode.lastTabFocus = null;
          }
          focusNodeWindow.parentNode.setGroupLayout(LAYOUT_TYPES.STACKED, !wrapped);
          let lastChild = focusNodeWindow.parentNode.lastChild;
          if (lastChild.nodeType === NODE_TYPES.WINDOW) {
            safeActivate(lastChild.nodeValue, global.display.get_current_time());
          }
        }
        this.unfreezeRender();
        this.tree.attachNode = focusNodeWindow.parentNode;
        this.renderTree("layout-stacked-toggle");
        this._raiseGroupMembers(this.findNodeWindow(this.focusMetaWindow));
        break;
      case "LayoutTabbedToggle":
        if (!focusNodeWindow) return;
        if (!this.ext.settings.get_boolean("tabbed-tiling-mode-enabled")) return;

        // A window directly on the workspace gets a container of its own first; that container's
        // direction isn't the user's, so it isn't remembered
        const parentBeforeTabs = focusNodeWindow.parentNode;
        if (parentBeforeTabs.isMonitor()) {
          this.tree.split(focusNodeWindow, ORIENTATION_TYPES.HORIZONTAL, true);
        }
        // (a floating window isn't wrapped: then its parent, the monitor, keeps its direction)
        const wrappedForTabs = focusNodeWindow.parentNode !== parentBeforeTabs;

        currentLayout = focusNodeWindow.parentNode.layout;

        if (currentLayout === LAYOUT_TYPES.TABBED) {
          focusNodeWindow.parentNode.restoreSplitLayout(this.determineSplitLayout());
          this.tree.resetSiblingPercent(focusNodeWindow.parentNode);
          focusNodeWindow.parentNode.lastTabFocus = null;
        } else {
          focusNodeWindow.parentNode.setGroupLayout(LAYOUT_TYPES.TABBED, !wrappedForTabs);
          focusNodeWindow.parentNode.lastTabFocus = focusNodeWindow.nodeValue;
        }
        this.unfreezeRender();
        this.tree.attachNode = focusNodeWindow.parentNode;
        this.renderTree("layout-tabbed-toggle");
        this._raiseGroupMembers(this.findNodeWindow(this.focusMetaWindow));
        break;
      case "CancelOperation":
        if (focusNodeWindow.mode === WINDOW_MODES.GRAB_TILE) {
          this.cancelGrab = true;
        }
        break;
      case "PrefsOpen":
        let existWindow = Utils.findWindowWith(this.prefsTitle);
        if (existWindow && existWindow.get_workspace()) {
          existWindow
            .get_workspace()
            .activate_with_focus(existWindow, global.display.get_current_time());
          this.moveCenter(existWindow);
        } else {
          this.ext.openPreferences();
        }
        break;
      case "WindowSwapLastActive":
        if (focusNodeWindow) {
          let lastActiveWindow = global.display.get_tab_next(
            Meta.TabList.NORMAL,
            global.display.get_workspace_manager().get_active_workspace(),
            focusNodeWindow.nodeValue,
            false
          );
          let lastActiveNodeWindow = this.tree.findNode(lastActiveWindow);
          this.tree.swapPairs(lastActiveNodeWindow, focusNodeWindow);
          this.movePointerWith(focusNodeWindow);
          this.renderTree("swap-last-active");
        }
        break;
      case "SnapLayoutMove":
        if (focusNodeWindow) {
          let workareaRect = focusNodeWindow.nodeValue.get_work_area_current_monitor();
          let layoutAmount = action.amount;
          let layoutDirection = action.direction.toUpperCase();
          let layout = {};
          let processGap = false;

          switch (layoutDirection) {
            case "LEFT":
              layout.width = layoutAmount * workareaRect.width;
              layout.height = workareaRect.height;
              layout.x = workareaRect.x;
              layout.y = workareaRect.y;
              processGap = true;
              break;
            case "RIGHT":
              layout.width = layoutAmount * workareaRect.width;
              layout.height = workareaRect.height;
              layout.x = workareaRect.x + (workareaRect.width - layout.width);
              layout.y = workareaRect.y;
              processGap = true;
              break;
            case "CENTER":
              let metaRect = this.focusMetaWindow.get_frame_rect();
              layout.x = "center";
              layout.y = "center";
              layout = {
                x: Utils.resolveX(layout, this.focusMetaWindow),
                y: Utils.resolveY(layout, this.focusMetaWindow),
                width: metaRect.width,
                height: metaRect.height,
              };
              break;
            default:
              break;
          }
          focusNodeWindow.rect = layout;
          if (processGap) {
            focusNodeWindow.rect = this.tree.processGap(focusNodeWindow);
          }
          if (!focusNodeWindow.isFloat()) {
            // Float this window, as Super+C does: a rule for this window only (not for its whole
            // app, which was saved for good and Super+C couldn't remove), applied right away (or
            // the next render tiled it again) (#469)
            this.addFloatOverride(focusNodeWindow.nodeValue, true);
            this.windowProps = this.ext.configMgr.windowProps;
            focusNodeWindow.mode = WINDOW_MODES.FLOAT;
          }
          this.move(focusNodeWindow.nodeValue, focusNodeWindow.rect);
          this.queueEvent({
            name: "snap-layout-move",
            callback: () => {
              this.renderTree("snap-layout-move");
            },
          });
          break;
        }

      case "ShowTabDecorationToggle":
        if (!focusNodeWindow) return;
        if (!this.ext.settings.get_boolean("tabbed-tiling-mode-enabled")) return;

        let showTabs = this.ext.settings.get_boolean("showtab-decoration-enabled");
        this.ext.settings.set_boolean("showtab-decoration-enabled", !showTabs);

        this.unfreezeRender();
        this.tree.attachNode = focusNodeWindow.parentNode;
        this.renderTree("showtab-decoration-enabled");
        break;

      case "WindowResizeRight":
        this.resize(Meta.GrabOp.KEYBOARD_RESIZING_E, action.amount);
        break;

      case "WindowResizeLeft":
        this.resize(Meta.GrabOp.KEYBOARD_RESIZING_W, action.amount);
        break;

      case "WindowResizeTop":
        this.resize(Meta.GrabOp.KEYBOARD_RESIZING_N, action.amount);
        break;

      case "WindowResizeBottom":
        this.resize(Meta.GrabOp.KEYBOARD_RESIZING_S, action.amount);
        break;

      default:
        break;
    }
  }

  resize(grabOp, amount) {
    let metaWindow = this.focusMetaWindow;
    if (!metaWindow) return; // no focused window, e.g. an empty workspace

    const nodeWindow = this.findNodeWindow(metaWindow);
    if (nodeWindow?.isTile() && this.ext.settings.get_boolean("tiling-mode-enabled")) {
      // Leave the layout alone while a window is being dragged, and behind a maximized or
      // fullscreen window (the change would be invisible)
      if (!this._freezeRender && !this._isMaximizedOrFullscreen(metaWindow)) {
        this._resizeTiled(nodeWindow, grabOp, amount);
      }
      return;
    }

    // Not tiled (floating, or not managed by Forge): resize its frame
    let rect = metaWindow.get_frame_rect();
    let direction = Utils.directionFromGrab(grabOp);

    switch (direction) {
      case Meta.MotionDirection.RIGHT:
        rect.width = rect.width + amount;
        break;
      case Meta.MotionDirection.LEFT:
        rect.width = rect.width + amount;
        rect.x = rect.x - amount;
        break;
      case Meta.MotionDirection.UP:
        // top edge: keep the bottom edge in place
        rect.height = rect.height + amount;
        rect.y = rect.y - amount;
        break;
      case Meta.MotionDirection.DOWN:
        // bottom edge: keep the top edge in place
        rect.height = rect.height + amount;
        break;
    }
    this.move(metaWindow, rect);
    this.updateBorderLayout();
  }

  /**
   * Resize a tiled window with the keyboard by changing the layout: the shares of the two nodes
   * on either side of the resized edge (see _resizePairFor()), within their minimum sizes; then
   * lay out that container. The layout stays the one source of truth, so a held shortcut can't
   * overshoot or snap back, and each key repeat builds on the last one.
   */
  _resizeTiled(nodeWindow, grabOp, amount) {
    const pair = this._resizePairFor(nodeWindow, grabOp);
    if (!pair) return; // no neighbour that way: the edge is the monitor's edge
    const [first, second] = pair;
    const parent = first.parentNode;
    if (!parent.rect || !first.rect || !second.rect) return;
    const orientation = Utils.orientationFromGrab(grabOp);
    const size = (rect) =>
      orientation === ORIENTATION_TYPES.HORIZONTAL ? rect.width : rect.height;

    // Start from what is shown, so that the other children stay exactly where they are
    if (!this.tree.syncShares(parent)) return; // not laid out yet
    const total = size(parent.rect);
    const firstSize = size(first.rect);
    const secondSize = size(second.rect);
    const [newFirst, newSecond] = this._resizePairSizes(
      first,
      firstSize,
      second,
      secondSize,
      firstSize + amount,
      orientation,
      first === nodeWindow ? 0 : this._pathMinSize(first, nodeWindow, orientation)
    );
    if (Math.abs(newFirst - firstSize) < 0.5) return; // at a limit: nothing to do
    first.percent = newFirst / total;
    second.percent = newSecond / total;
    this._resizeSharesAlongPath(first, nodeWindow, newFirst - firstSize, orientation);

    // Lay out that container now, so that the next key repeat sees the new sizes, and move the
    // windows whose place changed (those under the two nodes)
    this.tree.processNode(parent);
    const moves = [];
    [first, second].forEach((node) => {
      const windows = node.isWindow() ? [node] : node.getNodeByType(NODE_TYPES.WINDOW);
      windows.forEach((w) => {
        const r = w.renderRect;
        if (!w.isTile() || w.nodeValue.minimized || !r || r.width <= 0 || r.height <= 0) return;
        moves.push([w.nodeValue, r]);
      });
    });
    this.moveAll(moves);
    this.updateDecorationLayout();
    this.updateBorderLayout();
  }
  _isMaximizedOrFullscreen(metaWindow) {
    if (metaWindow.is_fullscreen()) return true;
    try {
      // GNOME 49+
      return metaWindow.is_maximized();
    } catch (e) {
      // pre-49 fallback
      return metaWindow.get_maximized() === Meta.MaximizeFlags.BOTH;
    }
  }
  /**
   * The two nodes on either side of `nodeWindow`'s edge in the direction of `grabOp`: the
   * window, or its nearest container that sits in a split in that direction with a tiled
   * sibling that way, and that sibling. Windows in a tabbed or stacked container share one
   * place, so the search goes past those; it stops at the monitor. Null if there is no
   * neighbour that way.
   */
  _resizePairFor(nodeWindow, grabOp) {
    const direction = Utils.directionFromGrab(grabOp);
    if (direction === undefined || direction === null) return null; // not an edge resize
    const horizontal =
      direction === Meta.MotionDirection.LEFT || direction === Meta.MotionDirection.RIGHT;
    const forward =
      direction === Meta.MotionDirection.RIGHT || direction === Meta.MotionDirection.DOWN;
    for (let node = nodeWindow; node?.parentNode; node = node.parentNode) {
      const parent = node.parentNode;
      if (horizontal ? parent.isHSplit() : parent.isVSplit()) {
        const siblings = this.tree
          .getTiledChildren(parent.childNodes)
          .filter((c) => c.isNodeValid());
        const i = siblings.indexOf(node);
        const j = forward ? i + 1 : i - 1;
        if (i >= 0 && j >= 0 && j < siblings.length) return [node, siblings[j]];
      }
      if (parent.isMonitor()) break;
    }
    return null;
  }
  disable() {
    this.layouts?.disable();
    Utils._disableDecorations();
    this._removeSignals();
    this.disabled = true;
    Logger.debug(`extension:disable`);
  }

  enable() {
    this._bindSignals();
    this.layouts?.enable();
    this.reloadTree("enable");
    Logger.debug(`extension:enable`);
  }

  findNodeWindow(metaWindow) {
    return this.tree.findNode(metaWindow);
  }

  get focusMetaWindow() {
    return global.display.get_focus_window();
  }

  get tree() {
    if (!this._tree) {
      this._tree = new Tree(this);
    }
    return this._tree;
  }

  get kbd() {
    if (!this._kbd) {
      this._kbd = new Keybindings(this.ext);
      this.ext.keybindings = this._kbd;
    }

    return this._kbd;
  }

  get windowsActiveWorkspace() {
    let wsManager = global.workspace_manager;
    return global.display.get_tab_list(Meta.TabList.NORMAL_ALL, wsManager.get_active_workspace());
  }

  get windowsAllWorkspaces() {
    let wsManager = global.workspace_manager;
    let windowsAll = [];

    for (let i = 0; i < wsManager.get_n_workspaces(); i++) {
      Array.prototype.push.apply(
        windowsAll,
        global.display.get_tab_list(Meta.TabList.NORMAL_ALL, wsManager.get_workspace_by_index(i))
      );
    }
    windowsAll.sort((w1, w2) => {
      return w1.get_stable_sequence() - w2.get_stable_sequence();
    });
    return windowsAll;
  }

  getWindowsOnWorkspace(workspaceIndex) {
    const workspaceNode = this.tree.findNode(`ws${workspaceIndex}`);
    const workspaceWindows = workspaceNode.getNodeByType(NODE_TYPES.WINDOW);
    return workspaceWindows;
  }

  determineSplitLayout() {
    // if the monitor width is less than height, the monitor could be vertical orientation;
    let monitorRect = global.display.get_monitor_geometry(global.display.get_current_monitor());
    if (monitorRect.width < monitorRect.height) {
      return LAYOUT_TYPES.VSPLIT;
    }
    return LAYOUT_TYPES.HSPLIT;
  }

  floatWorkspace(workspaceIndex) {
    const workspaceWindows = this.getWindowsOnWorkspace(workspaceIndex);
    if (!workspaceWindows) return;
    workspaceWindows.forEach((w) => {
      w.float = true;
    });
  }

  unfloatWorkspace(workspaceIndex) {
    const workspaceWindows = this.getWindowsOnWorkspace(workspaceIndex);
    if (!workspaceWindows) return;
    workspaceWindows.forEach((w) => {
      w.tile = true;
    });
  }

  hideActorBorder(actor) {
    if (actor.border) {
      actor.border.hide();
    }
    if (actor.splitBorder) {
      actor.splitBorder.hide();
    }
  }

  hideWindowBorders() {
    this.tree.getNodeByType(NODE_TYPES.CON).forEach((con) => {
      try {
        con.tab?.remove_style_class_name("window-tabbed-tab-active");
      } catch (e) {
        // the tab may have been destroyed
      }
    });
    this.tree.nodeWindows.forEach((nodeWindow) => {
      let actor = nodeWindow.windowActor;
      if (actor) {
        this.hideActorBorder(actor);
      }
      if (nodeWindow.parentNode.isTabbed() || nodeWindow.parentNode.isStacked()) {
        if (nodeWindow.tab) {
          // TODO: review the cleanup of the tab:St.Widget variable
          try {
            nodeWindow.tab.remove_style_class_name("window-tabbed-tab-active");
          } catch (e) {
            // Logger.warn(e);
          }
        }
      }
    });
  }

  // Window movement API
  move(metaWindow, rect) {
    if (!metaWindow) return;
    if (metaWindow.grabbed) return;
    try {
      // GNOME 49+
      metaWindow.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
      metaWindow.unmaximize();
    } catch (e) {
      // pre-49 fallback
      metaWindow.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
      metaWindow.unmaximize(Meta.MaximizeFlags.VERTICAL);
      metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
    }

    this._requestFrame(metaWindow, rect);
  }

  /**
   * Ask for `metaWindow`'s frame to be `rect`, position and size in one request: on Wayland,
   * GNOME then applies both together once the app has drawn the new size. Do not move the
   * window separately first, or it is shown at the new position with its old size meanwhile.
   */
  _requestFrame(metaWindow, rect) {
    this._queuedMoves?.delete(metaWindow); // a direct request replaces a queued one
    const windowActor = metaWindow.get_compositor_private();
    if (!windowActor) return;
    windowActor.remove_all_transitions();
    metaWindow.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
    this._rememberRequest(metaWindow, rect);
  }

  _rememberRequest(metaWindow, rect) {
    metaWindow.forgePendingFrame = {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      time: GLib.get_monotonic_time(),
    };
  }

  /**
   * Move several windows to new places without drawing one over another while the apps catch up.
   * An app takes a frame or more to draw a new size, and GNOME shows its window at the old place
   * until then (X11 apps move at once). So a window's new place is only requested once the
   * windows that still cover it have left: e.g. when one window grows into the space its neighbour
   * gives up, the neighbour shrinks first. Meanwhile there is a gap, never an overlap.
   * A window waits as long as what it waits for keeps moving (a slow app always jumps to the
   * latest place asked of it, e.g. while a resize key repeats), but at most MOVE_MAX_WAIT_MS
   * without progress, in case an app never redraws.
   * @param {Array<[Meta.Window, {x: number, y: number, width: number, height: number}]>} moves
   */
  moveAll(moves) {
    const queue = (this._queuedMoves ??= new Map());
    moves.forEach(([metaWindow, rect]) => {
      if (!metaWindow) return;
      const { x, y, width, height } = rect;
      const entry = queue.get(metaWindow) ?? { waitFor: [], waitKey: null, since: 0 };
      queue.set(metaWindow, { ...entry, rect: { x, y, width, height } });
    });
    this._flushMoves();
  }

  /** Request the queued places that are free now; keep checking every frame for the others. */
  _flushMoves() {
    const queue = this._queuedMoves;
    if (!queue) return;
    if (
      this.disabled ||
      this.layouts?.transitioning ||
      this.layouts?.restoring ||
      this.isDraggingWindow
    ) {
      this.cancelPendingMoves();
      return;
    }
    const now = GLib.get_monotonic_time();
    const covers = (a, b) =>
      Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 2 &&
      Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 2;
    const showing = (w) => isWindowAlive(w) && !w.minimized;
    const destination = (w) => queue.get(w)?.rect ?? this._targetRect(w);
    const others = this.tree.nodeWindows.map((n) => n.nodeValue).filter((w) => w && showing(w));
    // The windows that cover `rect` now but are on their way out of it. A window Forge hasn't
    // placed yet (just opened, wherever the app put it) doesn't wait, and neither does one for a
    // window that it already covers.
    const leaving = (metaWindow, rect) => {
      if (!metaWindow.forgePendingFrame) return [];
      const from = metaWindow.get_frame_rect();
      return others.filter((w) => {
        if (w === metaWindow || w.get_workspace() !== metaWindow.get_workspace()) return false;
        const frame = w.get_frame_rect();
        return covers(frame, rect) && !covers(destination(w), rect) && !covers(frame, from);
      });
    };
    const request = (metaWindow) => {
      const { rect } = queue.get(metaWindow);
      queue.delete(metaWindow);
      try {
        this.move(metaWindow, rect);
      } catch (e) {
        // the window may have gone away since it was queued
      }
    };
    for (let pass = 0; queue.size && pass < 2 * queue.size + 2; pass++) {
      let moved = false;
      const onlyQueued = [];
      for (const [metaWindow, entry] of [...queue]) {
        if (!showing(metaWindow) || !this.tree.findNode(metaWindow)) {
          queue.delete(metaWindow); // closed, minimized or no longer Forge's
          continue;
        }
        const waitFor = leaving(metaWindow, entry.rect);
        entry.waitFor = waitFor;
        // The wait starts again whenever what it waits for moves
        const where = waitFor
          .map((w) => {
            const f = w.get_frame_rect();
            return `${w.get_id()}:${f.x},${f.y},${f.width},${f.height}`;
          })
          .join(" ");
        if (where !== entry.waitKey) {
          entry.waitKey = where;
          entry.since = now;
        }
        if (!waitFor.length || now - entry.since > MOVE_MAX_WAIT_MS * 1000) {
          request(metaWindow); // (an X11 app's frame moves at once, which may free other places)
          moved = true;
        } else {
          onlyQueued.push(metaWindow);
        }
      }
      if (moved) continue;
      // Windows that wait only on each other (e.g. two that swap places) can't take turns: release
      // a group of them only if it is closed, everything it waits on waiting on it in turn. A chain
      // leading into or out of such a group, and anything waiting on a window on its way, waits.
      const waiting = new Set(onlyQueued);
      const reachable = (w) => {
        const seen = new Set();
        const todo = [...queue.get(w).waitFor];
        while (todo.length) {
          const x = todo.pop();
          if (seen.has(x)) continue;
          seen.add(x);
          if (waiting.has(x)) todo.push(...queue.get(x).waitFor);
        }
        return seen;
      };
      const reach = new Map(onlyQueued.map((w) => [w, reachable(w)]));
      const cycle = onlyQueued.filter((w) =>
        [...reach.get(w)].every((x) => waiting.has(x) && reach.get(x).has(w))
      );
      if (!cycle.length) break;
      cycle.forEach(request);
    }
    if (queue.size && !this._flushMovesSrcId) {
      this._flushMovesSrcId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
        this._flushMoves();
        if (this._queuedMoves.size) return GLib.SOURCE_CONTINUE;
        this._flushMovesSrcId = 0;
        return GLib.SOURCE_REMOVE;
      });
    }
  }

  /**
   * Where `metaWindow` is going: the place it waits for (see moveAll), or the frame Forge asked
   * for in the last half second if the app has not drawn its size yet (its position is only
   * applied together with its size), otherwise its current frame.
   */
  _targetRect(metaWindow) {
    const queued = this._queuedMoves?.get(metaWindow);
    if (queued) return queued.rect; // waiting for its place to be free (see moveAll)
    const frame = metaWindow.get_frame_rect();
    const pending = metaWindow.forgePendingFrame;
    const recent = pending && GLib.get_monotonic_time() - pending.time < 500000;
    if (recent && (pending.width !== frame.width || pending.height !== frame.height))
      return pending;
    return frame;
  }

  cancelPendingMoves() {
    if (this._flushMovesSrcId) GLib.Source.remove(this._flushMovesSrcId);
    this._flushMovesSrcId = 0;
    this._queuedMoves?.clear();
  }

  moveCenter(metaWindow) {
    if (!metaWindow) return;
    let frameRect = metaWindow.get_frame_rect();
    const rectRequest = {
      x: "center",
      y: "center",
      width: frameRect.width,
      height: frameRect.height,
    };

    let moveRect = {
      x: Utils.resolveX(rectRequest, metaWindow),
      y: Utils.resolveY(rectRequest, metaWindow),
      width: Utils.resolveWidth(rectRequest, metaWindow),
      height: Utils.resolveHeight(rectRequest, metaWindow),
    };
    this.move(metaWindow, moveRect);
  }

  rectForMonitor(node, targetMonitor) {
    if (!node || (node && node.nodeType !== NODE_TYPES.WINDOW)) return null;
    if (targetMonitor < 0) return null;
    let currentWorkArea = node.nodeValue.get_work_area_current_monitor();
    let nextWorkArea = node.nodeValue.get_work_area_for_monitor(targetMonitor);

    if (currentWorkArea && nextWorkArea) {
      let rect = node.rect;
      if (!rect && node.mode === WINDOW_MODES.FLOAT) {
        rect = node.nodeValue.get_frame_rect();
      }
      let hRatio = 1;
      let wRatio = 1;

      hRatio = nextWorkArea.height / currentWorkArea.height;
      wRatio = nextWorkArea.width / currentWorkArea.width;
      rect.height *= hRatio;
      rect.width *= wRatio;

      if (nextWorkArea.y < currentWorkArea.y) {
        rect.y =
          ((nextWorkArea.y + rect.y - currentWorkArea.y) / currentWorkArea.height) *
          nextWorkArea.height;
      } else if (nextWorkArea.y > currentWorkArea.y) {
        rect.y = (rect.y / currentWorkArea.height) * nextWorkArea.height + nextWorkArea.y;
      }

      if (nextWorkArea.x < currentWorkArea.x) {
        rect.x =
          ((nextWorkArea.x + rect.x - currentWorkArea.x) / currentWorkArea.width) *
          nextWorkArea.width;
      } else if (nextWorkArea.x > currentWorkArea.x) {
        rect.x = (rect.x / currentWorkArea.width) * nextWorkArea.width + nextWorkArea.x;
      }
      return rect;
    }
    return null;
  }

  _removeSignals() {
    if (!this._signalsBound) return;

    if (this._settingsChangedId) {
      this._settings.disconnect(this._settingsChangedId);
      this._settingsChangedId = 0;
      this._settings = null;
    }

    if (this._displaySignals) {
      for (const displaySignal of this._displaySignals) {
        global.display.disconnect(displaySignal);
      }
      this._displaySignals.length = 0;
      this._displaySignals = undefined;
    }

    if (this._windowManagerSignals) {
      for (const windowManagerSignal of this._windowManagerSignals) {
        global.window_manager.disconnect(windowManagerSignal);
      }
      this._windowManagerSignals.length = 0;
      this._windowManagerSignals = undefined;
    }

    const globalWsm = global.workspace_manager;

    if (this._workspaceManagerSignals) {
      for (const workspaceManagerSignal of this._workspaceManagerSignals) {
        globalWsm.disconnect(workspaceManagerSignal);
      }
      this._workspaceManagerSignals.length = 0;
      this._workspaceManagerSignals = undefined;
    }

    let numberOfWorkspaces = globalWsm.get_n_workspaces();

    for (let i = 0; i < numberOfWorkspaces; i++) {
      let workspace = globalWsm.get_workspace_by_index(i);
      if (workspace.workspaceSignals) {
        for (const workspaceSignal of workspace.workspaceSignals) {
          workspace.disconnect(workspaceSignal);
        }
        workspace.workspaceSignals.length = 0;
        workspace.workspaceSignals = undefined;
      }
    }

    let allWindows = this.windowsAllWorkspaces;
    // A window that is closing has left the window list, but its actor keeps its handlers and
    // borders until the close animation ends: release those too
    const windowActors = new Set(this._windowActors);
    this._windowActors?.clear();

    if (allWindows) {
      for (let metaWindow of allWindows) {
        if (metaWindow.windowSignals !== undefined) {
          for (const windowSignal of metaWindow.windowSignals) {
            metaWindow.disconnect(windowSignal);
          }
          metaWindow.windowSignals.length = 0;
          metaWindow.windowSignals = undefined;
        }

        let windowActor = metaWindow.get_compositor_private();
        if (windowActor) windowActors.add(windowActor);
      }
    }

    for (const windowActor of windowActors) {
      if (windowActor.actorSignals) {
        for (const actorSignal of windowActor.actorSignals) {
          windowActor.disconnect(actorSignal);
        }
        windowActor.actorSignals.length = 0;
        windowActor.actorSignals = undefined;
      }

      if (windowActor.border) {
        windowActor.border.hide();
        if (global.window_group) {
          global.window_group.remove_child(windowActor.border);
        }
        windowActor.border = undefined;
      }

      if (windowActor.splitBorder) {
        windowActor.splitBorder.hide();
        if (global.window_group) {
          global.window_group.remove_child(windowActor.splitBorder);
        }
        windowActor.splitBorder = undefined;
      }
    }

    if (this._renderTreeSrcId) {
      GLib.Source.remove(this._renderTreeSrcId);
      this._renderTreeSrcId = 0;
    }

    if (this._reloadTreeSrcId) {
      GLib.Source.remove(this._reloadTreeSrcId);
      this._reloadTreeSrcId = 0;
    }

    if (this._wsWindowAddSrcId) {
      GLib.Source.remove(this._wsWindowAddSrcId);
      this._wsWindowAddSrcId = 0;
    }

    if (this._queueSourceId) {
      GLib.Source.remove(this._queueSourceId);
      this._queueSourceId = 0;
    }

    if (this._flushMovesSrcId) {
      GLib.Source.remove(this._flushMovesSrcId);
      this._flushMovesSrcId = 0;
    }
    this._queuedMoves?.clear();

    if (this._pointerFocusTimeoutId) {
      GLib.Source.remove(this._pointerFocusTimeoutId);
      this._pointerFocusTimeoutId = 0;
    }

    if (this._prefsOpenSrcId) {
      GLib.Source.remove(this._prefsOpenSrcId);
      this._prefsOpenSrcId = 0;
    }

    if (this._overviewSignals) {
      for (const overviewSignal of this._overviewSignals) {
        Main.overview.disconnect(overviewSignal);
      }
      this._overviewSignals.length = 0;
      this._overviewSignals = null;
    }

    this._signalsBound = false;
  }

  get isDraggingWindow() {
    return this.tree.getNodeByMode(WINDOW_MODES.GRAB_TILE).length > 0;
  }

  renderTree(from, force = false) {
    if (this.layouts?.transitioning || this.layouts?.restoring) return;
    if (this.layouts?.key && !this.layouts.geometryMatches()) {
      this.layouts.monitorsChanged();
      return;
    }
    // Even forced renders must leave the drag preview and layout intact.
    if (this.isDraggingWindow) return;

    let wasFrozen = this._freezeRender;
    if (force && wasFrozen) this.unfreezeRender();
    if (this._freezeRender || !this.ext.settings.get_boolean("tiling-mode-enabled")) {
      this.updateDecorationLayout();
      this.updateBorderLayout();
    } else {
      if (!this._renderTreeSrcId) {
        this._renderTreeSrcId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
          if (this.layouts?.key && !this.layouts.geometryMatches()) this.layouts.monitorsChanged();
          // A grab can start after this render was queued.
          if (
            this.layouts?.transitioning ||
            this.layouts?.restoring ||
            this.isDraggingWindow ||
            this._freezeRender ||
            !this.ext.settings.get_boolean("tiling-mode-enabled")
          ) {
            this._renderTreeSrcId = 0;
            if (wasFrozen) this.freezeRender();
            return false;
          }
          this.processFloats();
          this.tree.render(from);
          this.layouts?.rendered();
          this._renderTreeSrcId = 0;
          this.updateDecorationLayout();
          this.updateBorderLayout();
          if (wasFrozen) this.freezeRender();
          return false;
        });
      }
    }
  }

  processFloats() {
    this.allNodeWindows.forEach((nodeWindow) => {
      if (nodeWindow.isGrabTile()) return;
      let metaWindow = nodeWindow.nodeValue;
      if (this.isFloatingExempt(metaWindow) || !this.isActiveWindowWorkspaceTiled(metaWindow)) {
        nodeWindow.float = true;
      } else {
        nodeWindow.float = false;
      }
    });
  }

  get allNodeWindows() {
    return this.tree.getNodeByType(NODE_TYPES.WINDOW);
  }

  /**
   * Reloads the tree. This is an expensive operation.
   * Useful when using dynamic workspaces in GNOME-shell.
   *
   * TODO: add support to reload the tree from a JSON dump file.
   * TODO: move this to tree.js
   */
  reloadTree(from) {
    if (!this._reloadTreeSrcId) {
      this._reloadTreeSrcId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
        Utils._disableDecorations();
        let treeWorkspaces = this.tree.nodeWorkpaces;
        let wsManager = global.workspace_manager;
        let globalWsNum = wsManager.get_n_workspaces();
        // empty out the root children nodes
        this.tree.childNodes.length = 0;
        this.tree.attachNode = undefined;
        // initialize the workspaces and monitors id strings
        this.tree._initWorkspaces();
        this.trackCurrentWindows();
        this.renderTree(from);
        this._reloadTreeSrcId = 0;
        return false;
      });
    }
  }

  sameParentMonitor(firstNode, secondNode) {
    if (!firstNode || !secondNode) return false;
    if (!firstNode.nodeValue || !secondNode.nodeValue) return false;
    if (!firstNode.nodeValue.get_workspace()) return false;
    if (!secondNode.nodeValue.get_workspace()) return false;
    let firstMonWs = `mo${firstNode.nodeValue.get_monitor()}ws${firstNode.nodeValue
      .get_workspace()
      .index()}`;
    let secondMonWs = `mo${secondNode.nodeValue.get_monitor()}ws${secondNode.nodeValue
      .get_workspace()
      .index()}`;
    return firstMonWs === secondMonWs;
  }

  showWindowBorders() {
    let metaWindow = this.focusMetaWindow;
    if (!metaWindow) return;
    // Right after a workspace switch, focus can still be on a window of the previous workspace:
    // its border would stay on screen over the new one (#268)
    if (!metaWindow.located_on_workspace(global.workspace_manager.get_active_workspace())) return;
    let windowActor = metaWindow.get_compositor_private();
    if (!windowActor) return;
    let nodeWindow = this.findNodeWindow(metaWindow);
    if (!nodeWindow) return;
    if (metaWindow.get_wm_class() === null) return;

    let borders = [];
    let focusBorderEnabled = this.ext.settings.get_boolean("focus-border-toggle");
    let splitBorderEnabled = this.ext.settings.get_boolean("split-border-toggle");
    let tilingModeEnabled = this.ext.settings.get_boolean("tiling-mode-enabled");
    let gap = this.calculateGaps(nodeWindow);
    let maximized = () => {
      try {
        // GNOME 49+
        return metaWindow.is_maximized() || metaWindow.is_fullscreen() || gap === 0;
      } catch (e) {
        // pre-49 fallback
        return metaWindow.get_maximized() === 3 || metaWindow.is_fullscreen() || gap === 0;
      }
    };
    let monitorCount = global.display.get_n_monitors();
    let tiledChildren = this.tree.getTiledChildren(nodeWindow.parentNode.childNodes);
    let inset = 3;
    let parentNode = nodeWindow.parentNode;

    const floatingWindow = nodeWindow.isFloat();
    const tiledBorder = windowActor.border;

    if (parentNode.isTabbed() || parentNode.isStacked()) {
      if (nodeWindow.tab) {
        nodeWindow.tab.add_style_class_name("window-tabbed-tab-active");
      }
    }
    // and the tab of each container holding it that is a member of a group
    for (let m = parentNode; m?.parentNode && !m.isMonitor(); m = m.parentNode) {
      if (m.tab && (m.parentNode.isTabbed() || m.parentNode.isStacked()))
        m.tab.add_style_class_name("window-tabbed-tab-active");
    }

    if (tiledBorder && focusBorderEnabled) {
      if (
        !maximized() ||
        (gap === 0 && tiledChildren.length === 1 && monitorCount > 1) ||
        (gap === 0 && tiledChildren.length > 1)
      ) {
        if (tilingModeEnabled) {
          if (parentNode.isStacked()) {
            if (!floatingWindow) {
              tiledBorder.set_style_class_name("window-stacked-border");
            } else {
              tiledBorder.set_style_class_name("window-floated-border");
            }
          } else if (parentNode.isTabbed()) {
            if (!floatingWindow) {
              tiledBorder.set_style_class_name("window-tabbed-border");
              if (nodeWindow.backgroundTab) {
                tiledBorder.add_style_class_name("window-tabbed-bg");
              }
            } else {
              tiledBorder.set_style_class_name("window-floated-border");
            }
          } else {
            if (!floatingWindow) {
              tiledBorder.set_style_class_name("window-tiled-border");
            } else {
              tiledBorder.set_style_class_name("window-floated-border");
            }
          }
        } else {
          tiledBorder.set_style_class_name("window-floated-border");
        }
        borders.push(tiledBorder);
      }
    }

    if (
      gap === 0 ||
      (() => {
        try {
          // GNOME 49+
          return metaWindow.is_maximized();
        } catch (e) {
          // pre-49 fallback
          return metaWindow.get_maximized() === 1 || metaWindow.get_maximized() === 2;
        }
      })()
    ) {
      inset = 0;
    }

    // handle the split border
    // It should only show when V or H-Split and with single child CONs
    if (
      splitBorderEnabled &&
      focusBorderEnabled &&
      tilingModeEnabled &&
      !nodeWindow.isFloat() &&
      !maximized() &&
      parentNode.childNodes.length === 1 &&
      (parentNode.isCon() || parentNode.isMonitor()) &&
      !(parentNode.isTabbed() || parentNode.isStacked())
    ) {
      if (!windowActor.splitBorder) {
        let splitBorder = new St.Bin({ style_class: "window-split-border" });
        global.window_group.add_child(splitBorder);
        windowActor.splitBorder = splitBorder;
      }

      let splitBorder = windowActor.splitBorder;
      splitBorder.remove_style_class_name("window-split-vertical");
      splitBorder.remove_style_class_name("window-split-horizontal");

      if (parentNode.isVSplit()) {
        splitBorder.add_style_class_name("window-split-vertical");
      } else if (parentNode.isHSplit()) {
        splitBorder.add_style_class_name("window-split-horizontal");
      }
      borders.push(splitBorder);
    }

    let rect = metaWindow.get_frame_rect();

    // Just above the focused window, each border above the one before it: the split hint (last)
    // shares the focus border's place and would be hidden under it otherwise
    let below = metaWindow.get_compositor_private();
    borders.forEach((border) => {
      border.set_size(rect.width + inset * 2, rect.height + inset * 2);
      border.set_position(rect.x - inset, rect.y - inset);
      if (metaWindow.appears_focused && !metaWindow.minimized) {
        border.show();
      }
      if (global.window_group && global.window_group.contains(border)) {
        global.window_group.remove_child(border);
        global.window_group.insert_child_above(border, below);
        below = border;
      }
    });
  }

  updateBorderLayout() {
    this.hideWindowBorders();
    this.showWindowBorders();
  }

  calculateGaps(node) {
    if (!node) return 0;

    let settings = this.ext.settings;
    let gapSize = settings.get_uint("window-gap-size");
    let gapIncrement = settings.get_uint("window-gap-size-increment");
    let gap = gapSize * gapIncrement;

    if (!node.isRoot()) {
      let hideGapWhenSingle = settings.get_boolean("window-gap-hidden-on-single");
      let parentNode = this.tree.findParent(node, NODE_TYPES.MONITOR);
      if (parentNode) {
        let tiled = parentNode
          .getNodeByMode(WINDOW_MODES.TILE)
          .filter((t) => t.isWindow() && !t.nodeValue.minimized);
        if (tiled.length == 1 && hideGapWhenSingle) gap = 0;
      }
    }

    return gap;
  }

  /**
   * Track meta/mutter windows and append them to the tree.
   * Windows can be attached on any of the following Node Types:
   * MONITOR, CONTAINER
   *
   */
  trackWindow(_display, metaWindow) {
    if (this.layouts?.transitioning) return;
    // Make window types configurable
    if (this._validWindow(metaWindow)) {
      let existNodeWindow = this.tree.findNode(metaWindow);
      Logger.debug(`Meta Window ${metaWindow.get_title()} ${metaWindow.get_window_type()}`);
      if (!existNodeWindow) {
        let attachTarget;

        const activeMonitor = this.layouts?.restoring
          ? Math.max(0, metaWindow.get_monitor())
          : global.display.get_current_monitor();
        const activeWorkspace = this.layouts?.restoring
          ? metaWindow.get_workspace()?.index() || 0
          : global.display.get_workspace_manager().get_active_workspace_index();
        let metaMonWs = `mo${activeMonitor}ws${activeWorkspace}`;

        // Check if the active monitor / workspace has windows
        let metaMonWsNode = this.tree.findNode(metaMonWs);
        if (!metaMonWsNode) {
          // Reload the tree as a last resort
          this.reloadTree("no-meta-monws");
          return;
        }

        // Repeated notifications for an existing window must not split the layout again.
        let autoSplit = this.ext.settings.get_boolean("auto-split-enabled");
        if (autoSplit && this.focusMetaWindow && !this.layouts?.restoring) {
          let currentFocusNode = this.tree.findNode(this.focusMetaWindow);
          if (currentFocusNode) {
            let currentParentFocusNode = currentFocusNode.parentNode;
            let layout = currentParentFocusNode.layout;
            const chosen =
              currentParentFocusNode.splitChosenFor === this.focusMetaWindow &&
              this.tree.getTiledChildren(currentParentFocusNode.childNodes).length === 1;
            if ((layout === LAYOUT_TYPES.HSPLIT || layout === LAYOUT_TYPES.VSPLIT) && !chosen) {
              let frameRect = this.focusMetaWindow.get_frame_rect();
              let splitHorizontal = frameRect.width > frameRect.height;
              let orientation = splitHorizontal ? "horizontal" : "vertical";
              this.command({ name: "Split", orientation: orientation, auto: true });
            }
          }
        }

        let windowNodes = metaMonWsNode.getNodeByType(NODE_TYPES.WINDOW);
        let hasWindows = windowNodes.length > 0;

        attachTarget = this.tree.attachNode;
        attachTarget = attachTarget ? this.tree.findNode(attachTarget.nodeValue) : null;

        if (!attachTarget) {
          attachTarget = metaMonWsNode;
        } else {
          if (hasWindows) {
            if (attachTarget && metaMonWsNode.contains(attachTarget)) {
              // Use the attach target
            } else {
              // Find the first window
              attachTarget = windowNodes[0];
            }
          } else {
            attachTarget = metaMonWsNode;
          }
        }

        let nodeWindow = this.tree.createNode(
          attachTarget.nodeValue,
          NODE_TYPES.WINDOW,
          metaWindow,
          WINDOW_MODES.FLOAT
        );

        metaWindow.firstRender = true;

        let windowActor = metaWindow.get_compositor_private();

        if (!metaWindow.windowSignals) {
          let windowSignals = [
            metaWindow.connect("position-changed", (_metaWindow) => {
              let from = "position-changed";
              this.updateMetaPositionSize(_metaWindow, from);
            }),
            metaWindow.connect("size-changed", (_metaWindow) => {
              let from = "size-changed";
              this.updateMetaPositionSize(_metaWindow, from);
            }),
            metaWindow.connect("unmanaged", (_metaWindow) => {
              this.hideActorBorder(windowActor);
            }),
            metaWindow.connect("focus", (_metaWindowFocus) => {
              this.queueEvent({
                name: "focus-update",
                callback: () => {
                  // Focus work queued before a grab must not unfreeze it.
                  if (this.isDraggingWindow) return;
                  this.unfreezeRender();
                  this.updateBorderLayout();
                  this.updateDecorationLayout();
                  const focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
                  this.updateStackedFocus(focusNodeWindow, true);
                  this.updateTabbedFocus(focusNodeWindow);
                  this._rememberInGroups(focusNodeWindow);
                  this.movePointerWith(focusNodeWindow);
                },
              });
              let focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
              if (focusNodeWindow) {
                // GNOME has just raised the focused window alone: bring the rest of its group
                // member (e.g. the other windows of a split among tabs) with it now, not after
                // the queued update, or another tab shows through meanwhile
                this._raiseGroupMembers(focusNodeWindow);
                // and remember it now, before the render below updates the groups' tabs
                this._rememberInGroups(focusNodeWindow);
                // handle the attach node
                this.tree.attachNode = focusNodeWindow._parent;
                if (this.floatingWindow(focusNodeWindow)) {
                  this.queueEvent({
                    name: "raise-float",
                    callback: () => {
                      this.renderTree("raise-float-queue");
                    },
                  });
                }
                this.tree.attachNode = focusNodeWindow;
              }
              this.renderTree("focus", true);
            }),
            metaWindow.connect("workspace-changed", (_metaWindow) => {
              this.updateMetaWorkspaceMonitor("metawindow-workspace-changed", null, _metaWindow);
              this.trackCurrentMonWs();
            }),
          ];
          metaWindow.windowSignals = windowSignals;
        }

        if (!windowActor.actorSignals) {
          let actorSignals = [windowActor.connect("destroy", this.windowDestroy.bind(this))];
          windowActor.actorSignals = actorSignals;
          (this._windowActors ??= new Set()).add(windowActor);
        }

        if (!windowActor.border) {
          let border = new St.Bin({ style_class: "window-tiled-border" });

          if (global.window_group) global.window_group.add_child(border);

          windowActor.border = border;
          border.show();
        }

        this.postProcessWindow(nodeWindow);
        this.queueEvent(
          {
            name: "window-create-queue",
            callback: () => {
              try {
                // GNOME 49+
                metaWindow.set_unmaximize_flags(Meta.MaximizeFlags.BOTH);
                metaWindow.unmaximize();
              } catch (e) {
                // pre-49 fallback
                metaWindow.unmaximize(Meta.MaximizeFlags.HORIZONTAL);
                metaWindow.unmaximize(Meta.MaximizeFlags.VERTICAL);
                metaWindow.unmaximize(Meta.MaximizeFlags.BOTH);
              }
              this.renderTree("window-create", true);
            },
          },
          200
        );

        let childNodes = this.tree.getTiledChildren(nodeWindow.parentNode.childNodes);
        childNodes.forEach((n) => {
          n.percent = 0.0;
        });
        this.layouts?.windowTracked(metaWindow);
      }
    }
  }

  postProcessWindow(nodeWindow) {
    let metaWindow = nodeWindow.nodeValue;
    if (metaWindow) {
      if (metaWindow.get_title() === this.prefsTitle) {
        metaWindow
          .get_workspace()
          .activate_with_focus(metaWindow, global.display.get_current_time());
        this.moveCenter(metaWindow);
      } else {
        this.movePointerWith(metaWindow);
      }
    }
  }

  /**
   * `fromFocusChange`: called for every focus change (not only moves, swaps and the overview).
   */
  updateStackedFocus(focusNodeWindow, fromFocusChange = false) {
    if (!focusNodeWindow) return;
    const parentNode = focusNodeWindow.parentNode;
    if (parentNode.layout !== LAYOUT_TYPES.STACKED || this._freezeRender) return;
    if (this.tree.hasTitleList(parentNode)) {
      // The stack keeps its order (its title list shows every window): only bring the focused
      // window to the front
      safeRaise(focusNodeWindow.nodeValue);
    } else if (!fromFocusChange) {
      // No title list (title bars off, or a window whose app is unknown): the cascade as before, the focused
      // window moved to the end so that the tops of the others show above it
      parentNode.appendChild(focusNodeWindow);
      parentNode.childNodes
        .filter((child) => child.isWindow())
        .forEach((child) => safeRaise(child.nodeValue));
      this.queueEvent({
        name: "render-focus-stack",
        callback: () => {
          this.renderTree("focus-stacked");
        },
      });
    }
  }

  /**
   * Remember a focused tiled window in every tabbed or stacked group it is in, so that focus
   * coming back to a group returns to it (a floating window doesn't count).
   */
  _rememberInGroups(nodeWindow) {
    if (!nodeWindow?.isWindow() || !nodeWindow.isTile()) return;
    for (let p = nodeWindow.parentNode; p && !p.isMonitor(); p = p.parentNode) {
      if (p.isTabbed() || p.isStacked()) p.lastTabFocus = nodeWindow.nodeValue;
      // and in each container, for its tab when it is a member of a group (Tree.memberWindow)
      if (p.isCon()) p.lastMemberFocus = nodeWindow.nodeValue;
    }
  }

  updateTabbedFocus(focusNodeWindow) {
    if (!focusNodeWindow) return;
    if (focusNodeWindow.parentNode.layout === LAYOUT_TYPES.TABBED && !this._freezeRender) {
      safeRaise(focusNodeWindow.nodeValue);
    }
    this._raiseGroupMembers(focusNodeWindow);
  }

  /**
   * Bring what the focused window belongs to in front of the other members of each tabbed or
   * stacked group it is in: when that member is a container (e.g. a split among tabs), all of its
   * windows, not only the focused one, or another tab shows through where the split's other
   * windows are. The focused window ends on top.
   */
  _raiseGroupMembers(focusNodeWindow) {
    if (this._freezeRender || !focusNodeWindow?.isWindow() || !focusNodeWindow.isTile()) return;
    const members = [];
    let member = focusNodeWindow;
    for (let p = member.parentNode; p && !p.isMonitor(); member = p, p = p.parentNode) {
      if (p.isTabbed() || p.isStacked()) members.unshift(member);
    }
    if (!members.length) return;
    // the outermost first, so that the members further in end up in front
    members.forEach((m) => {
      this.tree.shownWindows(m, focusNodeWindow).forEach((w) => {
        if (w !== focusNodeWindow) safeRaise(w.nodeValue);
      });
    });
    safeRaise(focusNodeWindow.nodeValue);
  }

  /**
   * Check if a Meta Window's workspace is skipped for tiling.
   */
  isActiveWindowWorkspaceTiled(metaWindow) {
    if (!metaWindow) return true;
    let skipWs = this.ext.settings.get_string("workspace-skip-tile");
    let skipArr = skipWs.split(",");
    let skipThisWs = false;

    for (let i = 0; i < skipArr.length; i++) {
      let activeWorkspaceForWin = metaWindow.get_workspace();
      if (activeWorkspaceForWin) {
        let wsIndex = activeWorkspaceForWin.index();
        if (skipArr[i].trim() === `${wsIndex}`) {
          skipThisWs = true;
          break;
        }
      }
    }
    return !skipThisWs;
  }

  /**
   * Check the current active workspace's tiling mode
   */
  isCurrentWorkspaceTiled() {
    let skipWs = this.ext.settings.get_string("workspace-skip-tile");
    let skipArr = skipWs.split(",");
    let skipThisWs = false;
    let wsMgr = global.workspace_manager;
    let wsIndex = wsMgr.get_active_workspace_index();

    for (let i = 0; i < skipArr.length; i++) {
      if (skipArr[i].trim() === `${wsIndex}`) {
        skipThisWs = true;
        break;
      }
    }
    return !skipThisWs;
  }

  trackCurrentWindows() {
    this.tree.attachNode = null;
    let windowsAll = this.windowsAllWorkspaces;
    for (let i = 0; i < windowsAll.length; i++) {
      let metaWindow = windowsAll[i];
      this.trackWindow(global.display, metaWindow);
      // This updates and handles dynamic workspaces
      this.updateMetaWorkspaceMonitor(
        "track-current-windows",
        metaWindow.get_monitor(),
        metaWindow
      );
    }
    this.updateDecorationLayout();
  }

  _validWindow(metaWindow) {
    let windowType = metaWindow.get_window_type();
    return (
      windowType === Meta.WindowType.NORMAL ||
      windowType === Meta.WindowType.MODAL_DIALOG ||
      windowType === Meta.WindowType.DIALOG
    );
  }

  windowDestroy(actor) {
    this._windowActors?.delete(actor);
    // Release any resources on the window
    let border = actor.border;
    if (border) {
      if (global.window_group) {
        global.window_group.remove_child(border);
        border.hide();
        border = null;
      }
    }

    let splitBorder = actor.splitBorder;
    if (splitBorder) {
      if (global.window_group) {
        global.window_group.remove_child(splitBorder);
        splitBorder.hide();
        splitBorder = null;
      }
    }

    let nodeWindow;
    nodeWindow = this.tree.findNodeByActor(actor);

    if (nodeWindow?.isWindow()) {
      this._queuedMoves?.delete(nodeWindow.nodeValue);
      if (this._grabNodeWindow === nodeWindow || nodeWindow.grabMode || nodeWindow.isGrabTile()) {
        this._stopLiveResizeLoop();
        this._grabCleanup(nodeWindow);
        if (this._renderTreeSrcId) {
          GLib.Source.remove(this._renderTreeSrcId);
          this._renderTreeSrcId = 0;
        }
        this.unfreezeRender();
      } else if (this.nodeWinAtPointer === nodeWindow) {
        this.nodeWinAtPointer = null;
        this._grabNodeWindow?.previewHint?.hide();
      }
      this.sortedWindows = this.sortedWindows?.filter((window) => window !== nodeWindow.nodeValue);
      this.tree.removeNode(nodeWindow);
      this.renderTree("window-destroy-quick", true);
      this.removeFloatOverride(nodeWindow.nodeValue, true);
    }

    // find the next attachNode here
    let focusNodeWindow = this.tree.findNode(this.focusMetaWindow);
    if (focusNodeWindow) {
      this.tree.attachNode = focusNodeWindow.parentNode;
    }

    this.queueEvent({
      name: "window-destroy",
      callback: () => {
        this.renderTree("window-destroy", true);
      },
    });
  }

  /**
   * Handles any workspace/monitor update for the Meta.Window.
   */
  updateMetaWorkspaceMonitor(from, _monitor, metaWindow) {
    if (this.layouts?.transitioning || this.layouts?.restoring) return;
    if (this.layouts?.key && !this.layouts.geometryMatches()) {
      this.layouts.monitorsChanged();
      return;
    }
    if (this._validWindow(metaWindow)) {
      if (metaWindow.get_workspace() === null) return;
      let existNodeWindow = this.tree.findNode(metaWindow);
      let metaMonWs = `mo${metaWindow.get_monitor()}ws${metaWindow.get_workspace().index()}`;
      let metaMonWsNode = this.tree.findNode(metaMonWs);
      if (existNodeWindow) {
        if (existNodeWindow.parentNode && metaMonWsNode) {
          // Uses the existing workspace, monitor that the metaWindow
          // belongs to.
          let containsWindow = metaMonWsNode.contains(existNodeWindow);
          if (!containsWindow) {
            // handle cleanup of resize percentages
            let existParent = existNodeWindow.parentNode;
            this.tree.resetSiblingPercent(existParent);
            metaMonWsNode.appendChild(existNodeWindow);

            // Ensure that the workspace tiling is honored
            if (this.isActiveWindowWorkspaceTiled(metaWindow)) {
              if (this.grabOp !== Meta.GrabOp.WINDOW_BASE) this.updateTabbedFocus(existNodeWindow);
              this.updateStackedFocus(existNodeWindow);
            } else {
              if (this.floatingWindow(existNodeWindow)) {
                safeRaise(existNodeWindow.nodeValue);
              }
            }
          }
        }
      }
      this.renderTree(from);
    }
  }

  /**
   * Handle any updates to the current focused window's position.
   * Useful for updating the active window border, etc.
   */
  updateMetaPositionSize(_metaWindow, from) {
    let focusMetaWindow = this.focusMetaWindow;
    if (!focusMetaWindow) return;

    let focusNodeWindow = this.findNodeWindow(focusMetaWindow);
    if (!focusNodeWindow) return;

    let tilingModeEnabled = this.ext.settings.get_boolean("tiling-mode-enabled");

    if (focusNodeWindow.grabMode && tilingModeEnabled) {
      if (focusNodeWindow.grabMode === GRAB_TYPES.RESIZING) {
        this._handleResizing(focusNodeWindow);
      } else if (focusNodeWindow.grabMode === GRAB_TYPES.MOVING) {
        this._handleMoving(focusNodeWindow);
      }
    } else {
      if (
        (() => {
          try {
            // GNOME 49+
            return !focusMetaWindow.is_maximized();
          } catch (e) {
            // pre-49 fallback
            return focusMetaWindow.get_maximized() === 0;
          }
        })()
      ) {
        this.renderTree(from);
      }
    }
    this.updateBorderLayout();
    this.updateDecorationLayout();
  }

  updateDecorationLayout() {
    if (this._freezeRender) return;
    let activeWsNode = this.currentWsNode;
    let allCons = this.tree.getNodeByType(NODE_TYPES.CON);

    // First, hide all decorations:
    allCons.forEach((con) => {
      if (con.decoration) {
        con.decoration.hide();
      }
    });

    // Next, handle showing-desktop usually by Super + D
    if (!activeWsNode) return;
    let allWindows = activeWsNode.getNodeByType(NODE_TYPES.WINDOW);
    let allHiddenWindows = allWindows.filter((w) => {
      let metaWindow = w.nodeValue;
      return !metaWindow.showing_on_its_workspace() || metaWindow.minimized;
    });

    // Then if all hidden, do not proceed showing the decorations at all;
    if (allWindows.length === allHiddenWindows.length) return;

    // Show the decoration where on all monitors of active workspace
    // But not on the monitor where there is a maximized or fullscreen window
    // Note, that when multi-display, user can have multi maximized windows,
    // So it needs to be fully filtered:
    let monWsNoMaxWindows = activeWsNode.getNodeByType(NODE_TYPES.MONITOR).filter((monitor) => {
      return (
        monitor.getNodeByType(NODE_TYPES.WINDOW).filter((w) => {
          return (() => {
            try {
              // GNOME 49+
              return w.nodeValue.is_maximized() || w.nodeValue.is_fullscreen();
            } catch (e) {
              // pre-49 fallback
              return (
                w.nodeValue.get_maximized() === Meta.MaximizeFlags.BOTH ||
                w.nodeValue.is_fullscreen()
              );
            }
          })();
        }).length === 0
      );
    });

    monWsNoMaxWindows.forEach((monitorWs) => {
      let activeMonWsCons = monitorWs.getNodeByType(NODE_TYPES.CON);
      activeMonWsCons.forEach((con) => {
        let tiled = this.tree.getTiledChildren(con.childNodes);
        let showTabs = this.ext.settings.get_boolean("showtab-decoration-enabled");
        const grouped = con.isTabbed() || con.isStacked();
        const hasRows = con.decoration?.get_n_children() > 0; // none yet, e.g. before a render
        if (con.decoration && grouped && tiled.length > 0 && showTabs && hasRows) {
          con.decoration.show();
          if (global.window_group.contains(con.decoration) && this.focusMetaWindow) {
            global.window_group.remove_child(con.decoration);
            // Show it below the focused window
            global.window_group.insert_child_below(
              con.decoration,
              this.focusMetaWindow.get_compositor_private()
            );
          }
          con.childNodes.forEach((cn) => {
            cn.render();
          });
        }
      });
    });
  }

  freezeRender() {
    this._freezeRender = true;
  }

  unfreezeRender() {
    this._freezeRender = false;
  }

  floatingWindow(node) {
    if (!node) return false;
    return node.nodeType === NODE_TYPES.WINDOW && node.mode === WINDOW_MODES.FLOAT;
  }

  /**
   * Moves the pointer along with the nodeWindow's meta
   *
   * This is useful for making sure that Forge calculates the attachNode
   * properly
   */
  movePointerWith(nodeWindow, { force = false } = {}) {
    if (!nodeWindow || !nodeWindow._data) return;
    const shouldWarp = force || this.ext.settings.get_boolean("move-pointer-focus-enabled");
    if (shouldWarp) {
      this.storePointerLastPosition(this.lastFocusedWindow);
      if (this.canMovePointerInsideNodeWindow(nodeWindow)) {
        this.warpPointerToNodeWindow(nodeWindow);
      }
    }
    this.lastFocusedWindow = nodeWindow;
    this.tree.debugParentNodes(nodeWindow);
  }

  warpPointerToNodeWindow(nodeWindow) {
    const newCoord = this.getPointerPositionInside(nodeWindow);
    if (newCoord && newCoord.x && newCoord.y) {
      const seat = Clutter.get_default_backend().get_default_seat();
      if (seat) {
        const wmTitle = nodeWindow.nodeValue.get_title();
        Logger.debug(`moved pointer to [${wmTitle}] at (${newCoord.x},${newCoord.y})`);
        seat.warp_pointer(newCoord.x, newCoord.y);
      }
    }
  }

  getPointer() {
    return global.get_pointer();
  }

  minimizedWindow(node) {
    if (!node) return false;
    return node._type === NODE_TYPES.WINDOW && node._data && node._data.minimized;
  }

  swapWindowsUnderPointer(focusNodeWindow) {
    if (this.cancelGrab) {
      return;
    }
    let nodeWinAtPointer = this.findNodeWindowAtPointer(focusNodeWindow);
    if (nodeWinAtPointer) this.tree.swapPairs(focusNodeWindow, nodeWinAtPointer);
  }

  /**
   *
   * Handle previewing and applying where a drag-drop window is going to be tiled
   *
   */
  moveWindowToPointer(focusNodeWindow, preview = false) {
    if (this.cancelGrab) {
      return;
    }
    if (!focusNodeWindow || focusNodeWindow.mode !== WINDOW_MODES.GRAB_TILE) return;

    let nodeWinAtPointer = this.nodeWinAtPointer;

    if (nodeWinAtPointer) {
      const targetRect = nodeWinAtPointer.nodeValue.get_frame_rect();
      const parentNodeTarget = nodeWinAtPointer.parentNode;
      const currPointer = this.getPointer();
      const horizontal = parentNodeTarget.isHSplit() || parentNodeTarget.isTabbed();
      const isMonParent = parentNodeTarget.nodeType === NODE_TYPES.MONITOR;
      const isConParent = parentNodeTarget.nodeType === NODE_TYPES.CON;
      const centerLayout = this.ext.settings.get_string("dnd-center-layout").toUpperCase();
      const stacked = parentNodeTarget.isStacked();
      const tabbed = parentNodeTarget.isTabbed();
      const stackedOrTabbed = stacked || tabbed;
      const updatePreview = (focusNodeWindow, previewParams) => {
        let previewHint = focusNodeWindow.previewHint;
        let previewHintEnabled = this.ext.settings.get_boolean("preview-hint-enabled");
        const previewRect = previewParams.targetRect;
        if (previewHint && previewHintEnabled) {
          if (!previewRect) {
            previewHint.hide();
            return;
          }
          previewHint.set_style_class_name(previewParams.className);
          previewHint.set_position(previewRect.x, previewRect.y);
          previewHint.set_size(previewRect.width, previewRect.height);
          previewHint.show();
        }
      };
      const regions = (targetRect, regionWidth) => {
        leftRegion = {
          x: targetRect.x,
          y: targetRect.y,
          width: targetRect.width * regionWidth,
          height: targetRect.height,
        };

        rightRegion = {
          x: targetRect.x + targetRect.width * (1 - regionWidth),
          y: targetRect.y,
          width: targetRect.width * regionWidth,
          height: targetRect.height,
        };

        topRegion = {
          x: targetRect.x,
          y: targetRect.y,
          width: targetRect.width,
          height: targetRect.height * regionWidth,
        };

        bottomRegion = {
          x: targetRect.x,
          y: targetRect.y + targetRect.height * (1 - regionWidth),
          width: targetRect.width,
          height: targetRect.height * regionWidth,
        };

        centerRegion = {
          x: targetRect.x + targetRect.width * regionWidth,
          y: targetRect.y + targetRect.height * regionWidth,
          width: targetRect.width - targetRect.width * regionWidth * 2,
          height: targetRect.height - targetRect.height * regionWidth * 2,
        };

        return {
          left: leftRegion,
          right: rightRegion,
          top: topRegion,
          bottom: bottomRegion,
          center: centerRegion,
        };
      };
      let referenceNode = null;
      let containerNode;
      let childNode = focusNodeWindow;
      let previewParams = {
        className: "",
        targetRect: null,
      };
      let leftRegion;
      let rightRegion;
      let topRegion;
      let bottomRegion;
      let centerRegion;
      let previewWidth = 0.5;
      let hoverWidth = 0.3;

      // Hover region detects where the pointer is on the target drop window
      const hoverRegions = regions(targetRect, hoverWidth);

      // Preview region interprets the hover intersect where the focus window
      // would go when dropped
      const previewRegions = regions(targetRect, previewWidth);

      leftRegion = hoverRegions.left;
      rightRegion = hoverRegions.right;
      topRegion = hoverRegions.top;
      bottomRegion = hoverRegions.bottom;
      centerRegion = hoverRegions.center;

      const isLeft = Utils.rectContainsPoint(leftRegion, currPointer);
      const isRight = Utils.rectContainsPoint(rightRegion, currPointer);
      const isTop = Utils.rectContainsPoint(topRegion, currPointer);
      const isBottom = Utils.rectContainsPoint(bottomRegion, currPointer);
      const isCenter = Utils.rectContainsPoint(centerRegion, currPointer);

      if (isCenter) {
        if (centerLayout == "SWAP") {
          referenceNode = nodeWinAtPointer;
          previewParams = {
            targetRect: targetRect,
          };
        } else {
          if (stackedOrTabbed) {
            containerNode = parentNodeTarget;
            referenceNode = null;
            previewParams = {
              className: stacked ? "window-tilepreview-stacked" : "window-tilepreview-tabbed",
              targetRect: targetRect,
            };
          } else {
            if (isMonParent) {
              childNode.createCon = true;
              containerNode = parentNodeTarget;
              referenceNode = nodeWinAtPointer;
              previewParams = {
                targetRect: targetRect,
              };
            } else {
              containerNode = parentNodeTarget;
              referenceNode = null;
              const parentTargetRect = this.tree.processGap(parentNodeTarget);
              previewParams = {
                targetRect: parentTargetRect,
              };
            }
          }
        }
      } else if (isLeft) {
        previewParams = {
          targetRect: previewRegions.left,
        };

        if (stackedOrTabbed) {
          // treat any windows on stacked or tabbed layouts to be
          // a single node unit: the con itself and then
          // split left, top, right or bottom accordingly (subsequent if conditions):
          childNode.detachWindow = true;
          if (!isMonParent) {
            referenceNode = parentNodeTarget;
            containerNode = parentNodeTarget.parentNode;
          } else {
            // It is a monitor that's a stack/tab
            // TODO: update the stacked/tabbed toggles to not
            // change layout if the parent is a monitor?
          }
        } else {
          if (horizontal) {
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer;
          } else {
            // vertical orientation
            childNode.createCon = true;
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer;
          }
        }
      } else if (isRight) {
        previewParams = {
          targetRect: previewRegions.right,
        };
        if (stackedOrTabbed) {
          // treat any windows on stacked or tabbed layouts to be
          // a single node unit: the con itself and then
          // split left, top, right or bottom accordingly (subsequent if conditions):
          childNode.detachWindow = true;
          if (!isMonParent) {
            referenceNode = parentNodeTarget.nextSibling;
            containerNode = parentNodeTarget.parentNode;
          } else {
            // It is a monitor that's a stack/tab
            // TODO: update the stacked/tabbed toggles to not
            // change layout if the parent is a monitor?
          }
        } else {
          if (horizontal) {
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer.nextSibling;
          } else {
            childNode.createCon = true;
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer.nextSibling;
          }
        }
      } else if (isTop) {
        previewParams = {
          targetRect: previewRegions.top,
        };
        if (stackedOrTabbed) {
          // treat any windows on stacked or tabbed layouts to be
          // a single node unit: the con itself and then
          // split left, top, right or bottom accordingly (subsequent if conditions):
          if (!isMonParent) {
            containerNode = parentNodeTarget;
            referenceNode = null;
            previewParams = {
              className: stacked ? "window-tilepreview-stacked" : "window-tilepreview-tabbed",
              targetRect: targetRect,
            };
          } else {
            // It is a monitor that's a stack/tab
            // TODO: update the stacked/tabbed toggles to not
            // change layout if the parent is a monitor?
          }
        } else {
          if (horizontal) {
            childNode.createCon = true;
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer;
          } else {
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer;
          }
        }
      } else if (isBottom) {
        previewParams = {
          targetRect: previewRegions.bottom,
        };
        if (stackedOrTabbed) {
          // treat any windows on stacked or tabbed layouts to be
          // a single node unit: the con itself and then
          // split left, top, right or bottom accordingly (subsequent if conditions):
          if (!isMonParent) {
            containerNode = parentNodeTarget;
            referenceNode = null;
            previewParams = {
              className: stacked ? "window-tilepreview-stacked" : "window-tilepreview-tabbed",
              targetRect: targetRect,
            };
          } else {
            // It is a monitor that's a stack/tab
            // TODO: update the stacked/tabbed toggles to not
            // change layout if the parent is a monitor?
          }
        } else {
          if (horizontal) {
            childNode = focusNodeWindow;
            childNode.createCon = true;
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer.nextSibling;
          } else {
            childNode = focusNodeWindow;
            containerNode = parentNodeTarget;
            referenceNode = nodeWinAtPointer.nextSibling;
          }
        }
      }

      if (!isCenter) {
        if (stackedOrTabbed) {
          if (isLeft || isRight) {
            previewParams.className = "window-tilepreview-tiled";
          } else if (isTop || isBottom) {
            previewParams.className = stacked
              ? "window-tilepreview-stacked"
              : "window-tilepreview-tabbed";
          }
        } else {
          previewParams.className = "window-tilepreview-tiled";
        }
      } else if (isCenter) {
        if (!stackedOrTabbed) previewParams.className = this._getDragDropCenterPreviewStyle();
      }

      if (!preview) {
        const previousParent = focusNodeWindow.parentNode;
        this.tree.resetSiblingPercent(containerNode);
        this.tree.resetSiblingPercent(previousParent);

        if (focusNodeWindow.tab) {
          let decoParent = focusNodeWindow.tab.get_parent();
          if (decoParent) decoParent.remove_child(focusNodeWindow.tab);
        }

        if (childNode.createCon) {
          const numWin = parentNodeTarget.childNodes.filter(
            (c) => c.nodeType === NODE_TYPES.WINDOW
          ).length;
          const numChild = parentNodeTarget.childNodes.length;
          const sameNumChild = numWin === numChild;
          // Child Node will still be created
          if (
            !isCenter &&
            ((isConParent && numWin === 1 && sameNumChild) ||
              (isMonParent && numWin == 2 && sameNumChild))
          ) {
            childNode = parentNodeTarget;
          } else {
            childNode = new Node(NODE_TYPES.CON, new St.Bin());
            containerNode.insertBefore(childNode, referenceNode);
            childNode.appendChild(nodeWinAtPointer);
          }

          if (isLeft || isTop) {
            childNode.insertBefore(focusNodeWindow, nodeWinAtPointer);
          } else if (isRight || isBottom || isCenter) {
            childNode.insertBefore(focusNodeWindow, null);
          }

          if (isLeft || isRight) {
            childNode.layout = LAYOUT_TYPES.HSPLIT;
          } else if (isTop || isBottom) {
            childNode.layout = LAYOUT_TYPES.VSPLIT;
          } else if (isCenter) {
            childNode.setGroupLayout(LAYOUT_TYPES[centerLayout], false); // a new container
          }
        } else if (childNode.detachWindow) {
          const orientation =
            isLeft || isRight ? ORIENTATION_TYPES.HORIZONTAL : ORIENTATION_TYPES.VERTICAL;
          this.tree.split(childNode, orientation);
          containerNode.insertBefore(childNode.parentNode, referenceNode);
        } else if (isCenter && centerLayout == "SWAP") {
          this.tree.swapPairs(referenceNode, focusNodeWindow);
          this.renderTree("drag-swap");
        } else {
          // Child Node is a WINDOW
          containerNode.insertBefore(childNode, referenceNode);
          if (isLeft || isRight) {
            containerNode.layout = LAYOUT_TYPES.HSPLIT;
          } else if (isTop || isBottom) {
            if (!stackedOrTabbed) containerNode.layout = LAYOUT_TYPES.VSPLIT;
          } else if (isCenter) {
            if (containerNode.isHSplit() || containerNode.isVSplit()) {
              containerNode.layout = LAYOUT_TYPES[centerLayout];
            }
          }
        }
        previousParent.resetLayoutSingleChild();
      } else {
        updatePreview(focusNodeWindow, previewParams);
      }
      childNode.createCon = false;
      childNode.detachWindow = false;
    }
  }

  canMovePointerInsideNodeWindow(nodeWindow) {
    if (nodeWindow && nodeWindow._data) {
      const metaWindow = nodeWindow.nodeValue;
      const metaRect = this._targetRect(metaWindow);
      const pointerCoord = global.get_pointer();
      return (
        metaRect &&
        // xdg-copy creates a 1x1 pixel window to capture mouse events.
        metaRect.width > 8 &&
        metaRect.height > 8 &&
        !Utils.rectContainsPoint(metaRect, pointerCoord) &&
        !metaWindow.minimized &&
        !Main.overview.visible &&
        !this.pointerIsOverParentDecoration(nodeWindow, pointerCoord)
      );
    }
    return false;
  }

  pointerIsOverParentDecoration(nodeWindow, pointerCoord) {
    if (pointerCoord && nodeWindow && nodeWindow.parentNode) {
      let node = nodeWindow.parentNode;
      if (node.isTabbed() || node.isStacked()) {
        return Utils.rectContainsPoint(node.rect, pointerCoord);
      }
    }
    return false;
  }

  getPointerPositionInside(nodeWindow) {
    if (nodeWindow && nodeWindow._data) {
      const metaWindow = nodeWindow.nodeValue;
      const metaRect = this._targetRect(metaWindow);
      // on: last position of cursor inside window
      // on: titlebar: near to app toolbars, menubar, tabs, etc...
      let [wx, wy] = nodeWindow.pointer
        ? [nodeWindow.pointer.x, nodeWindow.pointer.y]
        : [metaRect.width / 2, 8];
      let px = wx >= metaRect.width ? metaRect.width - 8 : wx;
      let py = wy >= metaRect.height ? metaRect.height - 8 : wy;
      return {
        x: metaRect.x + px,
        y: metaRect.y + py,
      };
    }
    return null;
  }

  storePointerLastPosition(nodeWindow) {
    if (nodeWindow && nodeWindow._data) {
      const metaWindow = nodeWindow.nodeValue;
      const metaRect = metaWindow.get_frame_rect();
      const pointerCoord = global.get_pointer();
      if (Utils.rectContainsPoint(metaRect, pointerCoord)) {
        let px = pointerCoord[0] - metaRect.x;
        let py = pointerCoord[1] - metaRect.y;
        if (px > 0 && py > 0) {
          nodeWindow.pointer = { x: px, y: py };
          Logger.debug(`stored pointer for [${metaWindow.get_title()}] at (${px},${py})`);
        }
      }
    }
  }

  findNodeWindowAtPointer(focusNodeWindow) {
    let pointerCoord = global.get_pointer();

    let nodeWinAtPointer = this._findNodeWindowAtPointer(focusNodeWindow.nodeValue, pointerCoord);
    return nodeWinAtPointer;
  }

  /**
   * Focus the window under the pointer and raise it.
   *
   * @returns {boolean} true if we should continue polling, false otherwise
   */
  _focusWindowUnderPointer() {
    // Break the loop if the user has disabled the feature
    // or if the window manager is disabled
    if (!this.shouldFocusOnHover || this.disabled) return false;

    // We don't want to focus windows when the overview is visible
    if (Main.overview.visible) return true;

    // Get the global mouse position
    let pointer = global.get_pointer();

    const metaWindow = this._getMetaWindowAtPointer(pointer);

    if (metaWindow) {
      const t = global.get_current_time();
      if (safeFocus(metaWindow, t)) {
        safeRaise(metaWindow);
      }
    }

    // Continue polling
    return true;
  }

  /**
   * Get the Meta.Window at the pointer coordinates
   *
   * @param {[number, number]} pointer x and y coordinates
   * @returns null if no window is found, otherwise the Meta.Window
   */
  _getMetaWindowAtPointer(pointer) {
    const windows = global.get_window_actors();
    const [x, y] = pointer;

    // Iterate through the windows in reverse order to get the top-most window
    for (let i = windows.length - 1; i >= 0; i--) {
      let window = windows[i];
      let metaWindow = window.meta_window;

      let { x: wx, y: wy, width, height } = metaWindow.get_frame_rect();

      // Check if the position is within the window bounds
      if (x >= wx && x <= wx + width && y >= wy && y <= wy + height) {
        return metaWindow;
      }
    }

    // No window found at the pointer
    return null;
  }

  /**
   * Finds the NodeWindow under the Meta.Window and the
   * current pointer coordinates;
   */
  _findNodeWindowAtPointer(metaWindow, pointer) {
    if (!metaWindow) return undefined;

    let sortedWindows = this.sortedWindows;

    if (!sortedWindows) {
      Logger.warn("No sorted windows");
      return;
    }

    for (let i = 0, n = sortedWindows.length; i < n; i++) {
      const w = sortedWindows[i];
      const metaRect = w.get_frame_rect();
      const atPointer = Utils.rectContainsPoint(metaRect, pointer);
      if (atPointer) return this.tree.getNodeByValue(w);
    }

    return null;
  }

  _handleGrabOpBegin(_display, _metaWindow, grabOp) {
    this.cancelPendingMoves();
    this.grabOp = grabOp;
    this.trackCurrentMonWs();
    let focusMetaWindow = _metaWindow || this.focusMetaWindow;

    if (focusMetaWindow) {
      let focusNodeWindow = this.findNodeWindow(focusMetaWindow);
      if (!focusNodeWindow) return;

      this._grabNodeWindow = focusNodeWindow;
      const frameRect = focusMetaWindow.get_frame_rect();
      const gaps = this.calculateGaps(focusNodeWindow);

      focusNodeWindow.grabMode = Utils.grabMode(grabOp);
      if (
        focusNodeWindow.grabMode === GRAB_TYPES.MOVING &&
        focusNodeWindow.mode === WINDOW_MODES.TILE
      ) {
        this.freezeRender();
        focusNodeWindow.mode = WINDOW_MODES.GRAB_TILE;
      }

      focusNodeWindow.initGrabOp = grabOp;
      focusNodeWindow.initRect = Utils.removeGapOnRect(frameRect, gaps);

      // Start live-resize polling loop for resize grabs
      if (focusNodeWindow.grabMode === GRAB_TYPES.RESIZING) {
        this._startLiveResizeLoop(focusNodeWindow);
      }
    }
  }

  _startLiveResizeLoop(focusNodeWindow) {
    this._stopLiveResizeLoop();

    // Cache gaps once — they don't change during a resize
    const gaps = this.calculateGaps(focusNodeWindow);
    let lastWidth = focusNodeWindow.initRect?.width;
    let lastHeight = focusNodeWindow.initRect?.height;

    this._liveResizeSrcId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 16, () => {
      const metaWindow = focusNodeWindow.nodeValue;
      if (!metaWindow || !focusNodeWindow.grabMode) {
        this._liveResizeSrcId = 0;
        return GLib.SOURCE_REMOVE;
      }

      const frameRect = metaWindow.get_frame_rect();
      const currentRect = Utils.removeGapOnRect(frameRect, gaps);

      // Skip if size hasn't changed — also prevents double-processing on X11
      // where size-changed signals fire alongside this loop
      if (currentRect.width === lastWidth && currentRect.height === lastHeight) {
        return GLib.SOURCE_CONTINUE;
      }
      lastWidth = currentRect.width;
      lastHeight = currentRect.height;

      const resizedParents = this._handleResizing(focusNodeWindow);

      // Update initRect so next tick delta is relative to current frame,
      // not the grab start (prevents percent accumulation)
      focusNodeWindow.initRect = currentRect;

      this._liveResizeNeighbors(focusNodeWindow, resizedParents);

      return GLib.SOURCE_CONTINUE;
    });
  }

  _stopLiveResizeLoop() {
    if (this._liveResizeSrcId) {
      GLib.Source.remove(this._liveResizeSrcId);
      this._liveResizeSrcId = 0;
    }
    this._liveResizeSent = null;
  }

  _handleGrabOpEnd(_display, _metaWindow, grabOp) {
    // A late grab-end for a destroyed window must not clean up a newer grab.
    if (this._grabNodeWindow && _metaWindow && this._grabNodeWindow.nodeValue !== _metaWindow)
      return;
    this._stopLiveResizeLoop();
    this.unfreezeRender();
    let focusNodeWindow = this._grabNodeWindow || this.findNodeWindow(_metaWindow);
    if (!focusNodeWindow) {
      this._grabCleanup(null);
      return;
    }
    let focusMetaWindow = focusNodeWindow.nodeValue;

    if (focusNodeWindow && !this.cancelGrab) {
      // WINDOW_BASE is when grabbing the window decoration
      // COMPOSITOR is when something like Overview requesting a grab, especially when Super is pressed.
      if (
        grabOp === Meta.GrabOp.WINDOW_BASE ||
        grabOp === Meta.GrabOp.COMPOSITOR ||
        grabOp === Meta.GrabOp.MOVING_UNCONSTRAINED
      ) {
        if (this.allowDragDropTile()) {
          this.moveWindowToPointer(focusNodeWindow);
        }
      }
    }
    this._grabCleanup(focusNodeWindow);

    if (
      (() => {
        try {
          // GNOME 49+
          return !focusMetaWindow.is_maximized();
        } catch (e) {
          // pre-49 fallback
          return focusMetaWindow.get_maximized() === 0;
        }
      })()
    ) {
      this.renderTree("grab-op-end");
    }

    this.updateStackedFocus(focusNodeWindow);
    this.updateTabbedFocus(focusNodeWindow);
    this.nodeWinAtPointer = null;
  }

  _grabCleanup(focusNodeWindow) {
    this.cancelGrab = false;
    this.grabOp = null;
    this.nodeWinAtPointer = null;
    if (!focusNodeWindow) return;
    if (this._grabNodeWindow === focusNodeWindow) this._grabNodeWindow = null;
    focusNodeWindow.initRect = null;
    focusNodeWindow.grabMode = null;
    focusNodeWindow.initGrabOp = null;

    if (focusNodeWindow.previewHint) {
      const previewHint = focusNodeWindow.previewHint;
      focusNodeWindow.previewHint = null;
      previewHint.hide();
      previewHint.get_parent()?.remove_child(previewHint);
      previewHint.destroy();
    }

    if (focusNodeWindow.mode === WINDOW_MODES.GRAB_TILE) {
      focusNodeWindow.mode = WINDOW_MODES.TILE;
    }
  }

  allowDragDropTile() {
    return this.kbd.allowDragDropTile();
  }

  /**
   * Update the percents of the resized node and its neighbour from the
   * focused window's current size.
   *
   * @returns {Set} the parent nodes whose children's percents were changed,
   *   so a live resize can re-layout exactly those containers.
   */
  _handleResizing(focusNodeWindow) {
    const resizedParents = new Set();
    if (!focusNodeWindow || focusNodeWindow.isFloat()) return resizedParents;
    let grabOps = Utils.decomposeGrabOp(this.grabOp);
    for (let grabOp of grabOps) {
      let initGrabOp = focusNodeWindow.initGrabOp;
      let orientation = Utils.orientationFromGrab(grabOp);
      let parentNodeForFocus = focusNodeWindow.parentNode;
      // normalize the rect without gaps
      let frameRect = this.focusMetaWindow.get_frame_rect();
      let gaps = this.calculateGaps(focusNodeWindow);
      let currentRect = Utils.removeGapOnRect(frameRect, gaps);
      let firstRect;
      let secondRect;
      let parentRect;
      let resizePairForWindow;

      if (initGrabOp === Meta.GrabOp.RESIZING_UNKNOWN) {
        // the direction is null so do not process yet below.
        return resizedParents;
      } else {
        // The same pair as a keyboard resize: the nearest tiled sibling in a split in that
        // direction. Windows in a tabbed or stacked group share its place, so the group's edge is
        // resized (Tree.next() would walk the group's windows as if side by side, and pick a tab).
        resizePairForWindow = this._resizePairFor(focusNodeWindow, grabOp)?.[1];
        if (!resizePairForWindow) continue; // nothing that way on this monitor: no split to resize
      }

      let sameParent = resizePairForWindow
        ? resizePairForWindow.parentNode === focusNodeWindow.parentNode
        : false;

      if (orientation === ORIENTATION_TYPES.HORIZONTAL) {
        if (sameParent) {
          // use the window or con pairs
          if (this.tree.getTiledChildren(parentNodeForFocus.childNodes).length <= 1) {
            return resizedParents;
          }

          firstRect = focusNodeWindow.initRect;
          if (resizePairForWindow) {
            if (
              !this.floatingWindow(resizePairForWindow) &&
              !this.minimizedWindow(resizePairForWindow)
            ) {
              secondRect = resizePairForWindow.rect;
            } else {
              // TODO try to get the next resize pair?
            }
          }

          if (!firstRect || !secondRect) {
            return resizedParents;
          }

          parentRect = parentNodeForFocus.rect;
          let [firstSize, secondSize] = this._resizePairSizes(
            focusNodeWindow,
            (focusNodeWindow.rect ?? firstRect).width,
            resizePairForWindow,
            secondRect.width,
            currentRect.width,
            orientation
          );
          const pairParent = parentNodeForFocus;
          const sizes = [firstSize, secondSize, parentRect.width];
          if (this._setPairShares(pairParent, focusNodeWindow, resizePairForWindow, ...sizes))
            resizedParents.add(pairParent);
        } else {
          // use the parent pairs (con to another con or window)
          if (resizePairForWindow && resizePairForWindow.parentNode) {
            if (this.tree.getTiledChildren(resizePairForWindow.parentNode.childNodes).length <= 1) {
              return resizedParents;
            }
            let firstWindowRect = focusNodeWindow.initRect;
            // The other side of the resized edge: the child of the neighbour's container that
            // holds the resized window (not simply the next index, which can be a minimized or
            // floating sibling)
            parentNodeForFocus = resizePairForWindow.parentNode.childNodes.find(
              (c) => c === focusNodeWindow || c.contains(focusNodeWindow)
            );
            if (!parentNodeForFocus) return resizedParents;
            firstRect = parentNodeForFocus.rect;
            secondRect = resizePairForWindow.rect;
            if (!firstRect || !secondRect) {
              return resizedParents;
            }

            parentRect = parentNodeForFocus.parentNode.rect;
            let [firstSize, secondSize] = this._resizePairSizes(
              parentNodeForFocus,
              firstRect.width,
              resizePairForWindow,
              secondRect.width,
              firstRect.width + currentRect.width - (focusNodeWindow.rect ?? firstWindowRect).width,
              orientation,
              this._pathMinSize(parentNodeForFocus, focusNodeWindow, orientation)
            );
            const pairParent = resizePairForWindow.parentNode;
            const sizes = [firstSize, secondSize, parentRect.width];
            if (
              this._setPairShares(pairParent, parentNodeForFocus, resizePairForWindow, ...sizes)
            ) {
              const firstShown = firstRect.width;
              this._resizeSharesAlongPath(
                parentNodeForFocus,
                focusNodeWindow,
                firstSize - firstShown,
                orientation
              );
              resizedParents.add(pairParent);
            }
          }
        }
      } else if (orientation === ORIENTATION_TYPES.VERTICAL) {
        if (sameParent) {
          // use the window or con pairs
          if (this.tree.getTiledChildren(parentNodeForFocus.childNodes).length <= 1) {
            return resizedParents;
          }
          firstRect = focusNodeWindow.initRect;
          if (resizePairForWindow) {
            if (
              !this.floatingWindow(resizePairForWindow) &&
              !this.minimizedWindow(resizePairForWindow)
            ) {
              secondRect = resizePairForWindow.rect;
            } else {
              // TODO try to get the next resize pair?
            }
          }
          if (!firstRect || !secondRect) {
            return resizedParents;
          }
          parentRect = parentNodeForFocus.rect;
          let [firstSize, secondSize] = this._resizePairSizes(
            focusNodeWindow,
            (focusNodeWindow.rect ?? firstRect).height,
            resizePairForWindow,
            secondRect.height,
            currentRect.height,
            orientation
          );
          const pairParent = parentNodeForFocus;
          const sizes = [firstSize, secondSize, parentRect.height];
          if (this._setPairShares(pairParent, focusNodeWindow, resizePairForWindow, ...sizes))
            resizedParents.add(pairParent);
        } else {
          // use the parent pairs (con to another con or window)
          if (resizePairForWindow && resizePairForWindow.parentNode) {
            if (this.tree.getTiledChildren(resizePairForWindow.parentNode.childNodes).length <= 1) {
              return resizedParents;
            }
            let firstWindowRect = focusNodeWindow.initRect;
            // The other side of the resized edge: the child of the neighbour's container that
            // holds the resized window (not simply the next index, which can be a minimized or
            // floating sibling)
            parentNodeForFocus = resizePairForWindow.parentNode.childNodes.find(
              (c) => c === focusNodeWindow || c.contains(focusNodeWindow)
            );
            if (!parentNodeForFocus) return resizedParents;
            firstRect = parentNodeForFocus.rect;
            secondRect = resizePairForWindow.rect;
            if (!firstRect || !secondRect) {
              return resizedParents;
            }

            parentRect = parentNodeForFocus.parentNode.rect;
            let [firstSize, secondSize] = this._resizePairSizes(
              parentNodeForFocus,
              firstRect.height,
              resizePairForWindow,
              secondRect.height,
              firstRect.height +
                currentRect.height -
                (focusNodeWindow.rect ?? firstWindowRect).height,
              orientation,
              this._pathMinSize(parentNodeForFocus, focusNodeWindow, orientation)
            );
            const pairParent = resizePairForWindow.parentNode;
            const sizes = [firstSize, secondSize, parentRect.height];
            if (
              this._setPairShares(pairParent, parentNodeForFocus, resizePairForWindow, ...sizes)
            ) {
              const firstShown = firstRect.height;
              this._resizeSharesAlongPath(
                parentNodeForFocus,
                focusNodeWindow,
                firstSize - firstShown,
                orientation
              );
              resizedParents.add(pairParent);
            }
          }
        }
      }
    }
    return resizedParents;
  }

  /**
   * New sizes for two adjacent nodes after a resize that asks for `first` to become
   * `newFirstSize`. The pair keeps its combined size, and neither node goes below its
   * minimum size (for `first`, at least `minFirst`). Without this, a resize keeps moving percents after a neighbour has stopped
   * shrinking, pushing it off-screen or over other windows, with percents over 100%.
   */
  _resizePairSizes(first, firstSize, second, secondSize, newFirstSize, orientation, minFirst = 0) {
    const total = firstSize + secondSize;
    minFirst = Math.max(minFirst, this.tree.minSizeOf(first, orientation));
    const minSecond = this.tree.minSizeOf(second, orientation);
    if (minFirst + minSecond > total) {
      // Both minimums can't fit: allow only a change that leaves neither node further below its
      // minimum than it already is
      const size = Math.min(
        Math.max(newFirstSize, Math.min(firstSize, minFirst)),
        total - Math.min(secondSize, minSecond)
      );
      return [size, total - size];
    }
    const size = Math.min(Math.max(newFirstSize, minFirst), total - minSecond);
    return [size, total - size];
  }

  /**
   * Give a resized pair its new sizes (px) as shares of `parent`. Nothing happens if the size
   * doesn't change; otherwise the shares are first synced to what is shown, so that the other
   * children stay exactly where they are. Returns whether anything changed.
   */
  _setPairShares(parent, first, second, firstSize, secondSize, parentSize) {
    const shown = parent.isHSplit() ? first.rect?.width : first.rect?.height;
    if (shown !== undefined && Math.abs(firstSize - shown) < 0.5) return false;
    if (!this.tree.syncShares(parent)) return false;
    first.percent = firstSize / parentSize;
    second.percent = secondSize / parentSize;
    return true;
  }

  /**
   * The children on the way from `node` down to `nodeWindow`, starting with `node`'s.
   */
  _pathTo(node, nodeWindow) {
    const path = [];
    while (node && node !== nodeWindow) {
      node = node.childNodes.find((c) => c === nodeWindow || c.contains(nodeWindow));
      if (node) path.push(node);
    }
    return path;
  }
  /**
   * After a resize changed `first` (a container holding `nodeWindow`) by `delta` px, keep that
   * change on the way down to `nodeWindow`: in every container on the way
   * that is split in the resize direction, only the child holding the window changes size and its
   * siblings keep theirs. Otherwise the change is spread over all the children by their shares,
   * and borders the user did not touch move too. Works from the shares (synced to what is shown),
   * so it also holds when key repeats come faster than renders.
   */
  _resizeSharesAlongPath(first, nodeWindow, delta, orientation) {
    const horizontal = orientation === ORIENTATION_TYPES.HORIZONTAL;
    let node = first;
    for (const child of this._pathTo(first, nodeWindow)) {
      if (horizontal ? node.isHSplit() : node.isVSplit()) {
        if (!this.tree.syncShares(node)) return; // not laid out yet: leave the shares alone
        // The split's own shown size: inside a tabbed or stacked group it is smaller than the
        // group's by the headers
        const total = horizontal ? node.rect.width : node.rect.height;
        const children = this.tree.getTiledChildren(node.childNodes);
        const childNew = child.percent * total + delta;
        children.forEach((c) => {
          c.percent = (c === child ? childNew : c.percent * total) / (total + delta);
        });
      }
      node = child;
    }
  }
  /**
   * The smallest size `first` can shrink to when, as in _resizeSharesAlongPath(), only the child on
   * the way to `nodeWindow` changes size in containers split in the resize direction.
   */
  _pathMinSize(first, nodeWindow, orientation) {
    const horizontal = orientation === ORIENTATION_TYPES.HORIZONTAL;
    const size = (rect) => (horizontal ? rect.width : rect.height);
    if (!first.rect) return 0;
    let slack = Infinity;
    let node = first;
    for (const child of this._pathTo(first, nodeWindow)) {
      const along = horizontal ? node.isHSplit() : node.isVSplit();
      if (along && child.rect) {
        slack = Math.min(slack, size(child.rect) - this.tree.minSizeOf(child, orientation));
      }
      node = child;
    }
    return slack === Infinity ? 0 : size(first.rect) - Math.max(slack, 0);
  }
  /**
   * During a mouse-drag resize, immediately re-layout all tiled windows
   * EXCEPT the one currently being dragged (GNOME owns its position).
   * Bypasses this.move() which is blocked by metaWindow.grabbed on Wayland.
   */
  _liveResizeNeighbors(draggingNodeWindow, resizedParents) {
    const draggingMetaWin = draggingNodeWindow.nodeValue;

    // Only reprocess the affected container subtrees, not the entire tree.
    // When the resize pair lives above the dragged window's own container
    // (e.g. resizing a window inside a con against a sibling of that con),
    // the percents were changed on that ancestor, so it must be reprocessed:
    // otherwise its children's rects stay stale for the whole grab, every tick
    // computes percents from the stale rects plus only that tick's delta, and
    // the layout snaps back when the grab ends.
    if (!resizedParents.size) return;
    const nested = (node) => [...resizedParents].some((p) => p !== node && p.contains(node));
    resizedParents.forEach((node) => {
      if (!nested(node)) this.tree.processNode(node);
    });

    // mattchristenson, upstream PR #558: only send changed frames in affected subtrees.
    // https://github.com/forge-ext/forge/pull/558
    const sent = (this._liveResizeSent ??= new Map());
    const sameRect = (a, b) =>
      a && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
    resizedParents.forEach((node) => {
      if (nested(node)) return;
      node.getNodeByType(NODE_TYPES.WINDOW).forEach((nodeWin) => {
        if (nodeWin.nodeValue === draggingMetaWin || nodeWin.isFloat() || !nodeWin.renderRect)
          return;
        const r = nodeWin.renderRect;
        if (!(r.width > 0 && r.height > 0) || sameRect(sent.get(nodeWin), r)) return;
        this._requestFrame(nodeWin.nodeValue, r);
        sent.set(nodeWin, { x: r.x, y: r.y, width: r.width, height: r.height });
      });
    });
  }

  _handleMoving(focusNodeWindow) {
    if (!focusNodeWindow || focusNodeWindow.mode !== WINDOW_MODES.GRAB_TILE) return;

    const nodeWinAtPointer = this.findNodeWindowAtPointer(focusNodeWindow);
    this.nodeWinAtPointer = nodeWinAtPointer;

    const hidePreview = () => {
      if (focusNodeWindow.previewHint) {
        focusNodeWindow.previewHint.hide();
      }
    };

    if (nodeWinAtPointer) {
      if (!focusNodeWindow.previewHint) {
        let previewHint = new St.Bin();
        global.window_group.add_child(previewHint);
        focusNodeWindow.previewHint = previewHint;
      }

      if (this.allowDragDropTile()) {
        this.moveWindowToPointer(focusNodeWindow, true);
      } else {
        hidePreview();
      }
    } else {
      hidePreview();
    }
  }

  isFloatingExempt(metaWindow) {
    if (!metaWindow) return true;
    let windowTitle = metaWindow.get_title();
    let windowType = metaWindow.get_window_type();

    let floatByType =
      windowType === Meta.WindowType.DIALOG ||
      windowType === Meta.WindowType.MODAL_DIALOG ||
      metaWindow.get_transient_for() !== null ||
      metaWindow.get_wm_class() === null ||
      windowTitle === null ||
      windowTitle === "" ||
      windowTitle.length === 0 ||
      !metaWindow.allows_resize();

    const knownFloats = this.windowProps.overrides.filter((wprop) => wprop.mode === "float");

    let floatOverride =
      knownFloats.filter((kf) => {
        let matchTitle = false;
        let matchClass = false;
        let matchId = false;

        if (kf.wmTitle) {
          if (kf.wmTitle === " ") {
            matchTitle = kf.wmTitle === windowTitle;
          } else {
            let titles = kf.wmTitle.split(",");
            matchTitle =
              titles.filter((t) => {
                if (windowTitle) {
                  if (t.startsWith("!")) {
                    return !windowTitle.includes(t.slice(1));
                  } else {
                    return windowTitle.includes(t);
                  }
                }
                return false;
              }).length > 0;
          }
        }
        if (kf.wmClass) {
          matchClass = kf.wmClass.includes(metaWindow.get_wm_class());
        }
        if (kf.wmId) {
          matchId = kf.wmId === metaWindow.get_id();
        }

        return (!kf.wmId || matchId) && (!kf.wmTitle || matchTitle) && matchClass;
      }).length > 0;

    return floatByType || floatOverride;
  }

  _getDragDropCenterPreviewStyle() {
    const centerLayout = this.ext.settings.get_string("dnd-center-layout");
    return `window-tilepreview-${centerLayout}`;
  }

  get currentMonWsNode() {
    const monWs = this.currentMonWs;
    if (monWs) {
      return this.tree.findNode(monWs);
    }
    return null;
  }

  get currentWsNode() {
    const ws = this.currentWs;
    if (ws) {
      return this.tree.findNode(ws);
    }
    return null;
  }

  get currentMonWs() {
    const monWs = `${this.currentMon}${this.currentWs}`;
    return monWs;
  }

  get currentWs() {
    const display = global.display;
    const wsMgr = display.get_workspace_manager();
    return `ws${wsMgr.get_active_workspace_index()}`;
  }

  get currentMon() {
    const display = global.display;
    return `mo${display.get_current_monitor()}`;
  }

  /**
   * Reload window overrides from the configuration file
   * This is called when the preferences page modifies the overrides
   */
  reloadWindowOverrides() {
    // Get fresh data from the ConfigManager
    const freshProps = this.ext.configMgr.windowProps;
    if (freshProps) {
      this.windowProps = freshProps;
      this.windowProps.overrides = this.windowProps.overrides.filter((override) => !override.wmId);
      Logger.info(`Reloaded ${this.windowProps.overrides.length} window overrides from file`);
    }
  }

  floatAllWindows() {
    this.tree.getNodeByType(NODE_TYPES.WINDOW).forEach((w) => {
      if (w.isFloat()) {
        w.prevFloat = true;
      }
      w.mode = WINDOW_MODES.FLOAT;
    });
  }

  unfloatAllWindows() {
    this.tree.getNodeByType(NODE_TYPES.WINDOW).forEach((w) => {
      if (!w.prevFloat) {
        w.mode = WINDOW_MODES.TILE;
      } else {
        // Reset the float marker
        w.prevFloat = false;
      }
    });
  }
}
