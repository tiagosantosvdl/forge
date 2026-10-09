const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// Load the extension's actual classes with a controllable GLib idle queue.
// GNOME actors and the desktop session are not needed for these state transitions.
function createHarness() {
  const idle = new Map();
  const removedSources = [];
  let nextId = 1;
  const context = vm.createContext({
    GObject: { Object: class {}, registerClass() {} },
    Utils: { createEnum: (names) => Object.fromEntries(names.map((name) => [name, name])) },
    Window: {},
    Logger: { debug() {} },
    global: { display: { get_focus_window: () => null } },
    Meta: { GrabOp: { WINDOW_BASE: 1, COMPOSITOR: 2, MOVING_UNCONSTRAINED: 3 } },
    GLib: {
      PRIORITY_DEFAULT: 0,
      idle_add(_priority, callback) {
        const id = nextId++;
        idle.set(id, callback);
        return id;
      },
      Source: {
        remove(id) {
          removedSources.push(id);
          idle.delete(id);
        },
      },
    },
  });
  function load(file, exports) {
    const source = fs
      .readFileSync(path.join(__dirname, "..", "lib", "extension", file), "utf8")
      .replace(/^import[\s\S]*?;\n/gm, "")
      .replace(/^export /gm, "");
    vm.runInContext(`${source}\nObject.assign(globalThis, {${exports}});`, context);
  }
  load("tree.js", "Node, Tree, NODE_TYPES");
  load("window.js", "WindowManager, WINDOW_MODES");
  context.Window.WINDOW_MODES = context.WINDOW_MODES;

  const settings = { get_boolean: () => true };
  const tree = Object.create(context.Tree.prototype);
  Object.assign(tree, { _type: context.NODE_TYPES.ROOT, _nodes: [], settings });
  const wm = Object.create(context.WindowManager.prototype);
  Object.assign(wm, {
    _tree: tree,
    ext: { settings },
    isFloatingExempt: () => false,
    isActiveWindowWorkspaceTiled: () => true,
    updateDecorationLayout() {},
    updateBorderLayout() {},
  });
  tree._extWm = wm;
  let renders = 0;
  tree.render = () => renders++;

  function addWindow(mode = context.WINDOW_MODES.TILE) {
    const node = Object.create(context.Node.prototype);
    Object.assign(node, {
      _type: context.NODE_TYPES.WINDOW,
      _nodes: [],
      _data: { minimized: false, is_above: () => false, is_maximized: () => false },
      _actor: {},
      settings,
      mode,
    });
    tree.appendChild(node);
    return node;
  }
  function flush() {
    for (const [id, callback] of [...idle]) {
      idle.delete(id);
      callback();
    }
  }
  return {
    wm,
    tree,
    context,
    addWindow,
    flush,
    idle,
    removedSources,
    modes: context.WINDOW_MODES,
    renders: () => renders,
  };
}

test("a render queued before dragging cannot retile the dragged window", () => {
  const h = createHarness();
  const dragged = h.addWindow();
  h.addWindow();
  h.addWindow();
  h.wm.renderTree("focus", true);
  h.wm.freezeRender();
  dragged.mode = h.modes.GRAB_TILE;
  h.flush();

  assert.equal(h.renders(), 0);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
  assert.equal(h.wm._freezeRender, true);
  assert.equal(h.wm._renderTreeSrcId, 0);
  assert.equal(h.tree.getTiledChildren(h.tree.childNodes).length, 2);

  // Releasing the grab must still allow the pending layout to be applied.
  h.wm._grabCleanup(dragged);
  h.wm.unfreezeRender();
  h.wm.renderTree("grab-op-end");
  h.flush();
  assert.equal(h.renders(), 1);
  assert.equal(dragged.mode, h.modes.TILE);

  // Dragging again after dropping back must preserve the same preview state.
  h.wm.freezeRender();
  dragged.mode = h.modes.GRAB_TILE;
  h.wm.renderTree("window-entered-monitor");
  h.flush();
  assert.equal(h.renders(), 1);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
});

function createDestructionHarness() {
  const h = createHarness();
  const monitor = Object.create(h.context.Node.prototype);
  Object.assign(monitor, { _type: h.context.NODE_TYPES.MONITOR, _nodes: [], _data: "mo0ws0" });
  h.tree.appendChild(monitor);
  const queued = [];
  h.wm.queueEvent = (event) => queued.push(event);
  h.wm.removeFloatOverride = () => {};
  const addWindow = h.addWindow;
  h.addWindow = (mode) => {
    const node = addWindow(mode);
    monitor.appendChild(node);
    return node;
  };
  h.runDestructionQueue = () => queued.splice(0).forEach((event) => event.callback());
  return h;
}

function addPreview(node, attached = true) {
  const state = { hidden: 0, removed: 0, destroyed: 0 };
  node.previewHint = {
    hide: () => state.hidden++,
    get_parent: () => (attached ? { remove_child: () => state.removed++ } : null),
    destroy: () => state.destroyed++,
  };
  return state;
}

test("destroying the dragged window clears its preview and resumes tiling without grab-end", () => {
  for (const attached of [true, false]) {
    const h = createDestructionHarness();
    const dragged = h.addWindow(h.modes.GRAB_TILE);
    const survivor = h.addWindow();
    const preview = addPreview(dragged, attached);
    h.wm._grabNodeWindow = dragged;
    h.wm.nodeWinAtPointer = survivor;
    h.wm.sortedWindows = [dragged.nodeValue, survivor.nodeValue];
    h.wm.cancelGrab = true;
    h.wm.grabOp = 1;
    dragged.grabMode = "MOVING";
    h.wm.freezeRender();

    h.wm.windowDestroy(dragged.actor);
    h.flush();
    h.runDestructionQueue();
    h.flush();

    assert.equal(preview.destroyed, 1);
    assert.equal(preview.removed, attached ? 1 : 0);
    assert.equal(dragged.previewHint, null);
    assert.equal(dragged.grabMode, null);
    assert.equal(h.wm._grabNodeWindow, null);
    assert.equal(h.wm.nodeWinAtPointer, null);
    assert.equal(h.wm.grabOp, null);
    assert.equal(h.wm.cancelGrab, false);
    assert.equal(h.wm._freezeRender, false);
    assert.equal(h.wm.isDraggingWindow, false);
    assert.equal(h.tree.findNode(dragged.nodeValue), null);
    assert.deepEqual(h.wm.sortedWindows, [survivor.nodeValue]);
    assert.ok(h.renders() > 0);

    // A late grab-end must tolerate no focused window and no live node.
    h.wm._handleGrabOpEnd(null, dragged.nodeValue, 1);
    assert.equal(preview.destroyed, 1);
  }
});

test("destroying a window during resizing stops the polling loop", () => {
  const h = createDestructionHarness();
  const resizing = h.addWindow();
  resizing.grabMode = "RESIZING";
  h.wm._grabNodeWindow = resizing;
  h.wm._liveResizeSrcId = 42;
  h.wm.windowDestroy(resizing.actor);
  assert.deepEqual(h.removedSources, [42]);
  assert.equal(h.wm._liveResizeSrcId, 0);
  assert.equal(h.wm._grabNodeWindow, null);
});

test("destroying the dragged window cancels queued work that would restore a stale freeze", () => {
  const h = createDestructionHarness();
  const dragged = h.addWindow();
  h.wm.freezeRender();
  h.wm.renderTree("focus", true);
  const oldRender = h.wm._renderTreeSrcId;
  dragged.mode = h.modes.GRAB_TILE;
  h.wm._grabNodeWindow = dragged;
  h.wm.freezeRender();
  h.wm.windowDestroy(dragged.actor);
  h.flush();
  assert.ok(h.removedSources.includes(oldRender));
  assert.equal(h.wm._freezeRender, false);
  assert.equal(h.renders(), 1);
});

test("destroying a drop target hides its preview without cancelling the dragged window", () => {
  const h = createDestructionHarness();
  const dragged = h.addWindow(h.modes.GRAB_TILE);
  const target = h.addWindow();
  const preview = addPreview(dragged);
  h.wm._grabNodeWindow = dragged;
  h.wm.nodeWinAtPointer = target;
  h.wm.sortedWindows = [target.nodeValue];
  h.wm.freezeRender();
  h.wm.windowDestroy(target.actor);
  h.runDestructionQueue();
  h.flush();
  assert.equal(h.wm.nodeWinAtPointer, null);
  assert.equal(preview.hidden, 1);
  assert.equal(preview.destroyed, 0);
  assert.equal(h.wm._grabNodeWindow, dragged);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
  assert.equal(h.wm._freezeRender, true);
  assert.equal(h.renders(), 0);
  assert.equal(h.wm.sortedWindows.length, 0);
});

test("an unrelated window closing leaves an active drag and its preview intact", () => {
  const h = createDestructionHarness();
  const dragged = h.addWindow(h.modes.GRAB_TILE);
  const target = h.addWindow();
  const unrelated = h.addWindow();
  const preview = addPreview(dragged);
  h.wm._grabNodeWindow = dragged;
  h.wm.nodeWinAtPointer = target;
  h.wm.freezeRender();
  h.wm.windowDestroy(unrelated.actor);
  assert.equal(h.wm._grabNodeWindow, dragged);
  assert.equal(h.wm.nodeWinAtPointer, target);
  assert.equal(h.wm._freezeRender, true);
  assert.equal(preview.hidden, 0);
  assert.equal(preview.destroyed, 0);
});

test("grab-end cleans up the grabbed window even when focus has changed", () => {
  const h = createHarness();
  const dragged = h.addWindow(h.modes.GRAB_TILE);
  const other = h.addWindow();
  const preview = addPreview(dragged);
  h.context.global.display.get_focus_window = () => other.nodeValue;
  h.wm._grabNodeWindow = dragged;
  h.wm.allowDragDropTile = () => false;
  h.wm.freezeRender();
  h.wm._handleGrabOpEnd(null, dragged.nodeValue, 1);
  h.flush();
  assert.equal(preview.destroyed, 1);
  assert.equal(dragged.mode, h.modes.TILE);
  assert.equal(h.wm._grabNodeWindow, null);
  assert.equal(h.wm._freezeRender, false);
  assert.equal(h.renders(), 1);
});

test("grab-begin tracks the signal's window rather than a different focused window", () => {
  const h = createHarness();
  const dragged = h.addWindow();
  const other = h.addWindow();
  dragged.nodeValue.get_frame_rect = () => ({ x: 0, y: 0, width: 400, height: 300 });
  h.context.global.display.get_focus_window = () => other.nodeValue;
  h.context.Utils.grabMode = () => "MOVING";
  h.context.Utils.removeGapOnRect = (rect) => rect;
  h.wm.trackCurrentMonWs = () => {};
  h.wm.calculateGaps = () => 0;
  h.wm._handleGrabOpBegin(null, dragged.nodeValue, 1);
  assert.equal(h.wm._grabNodeWindow, dragged);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
  assert.equal(other.mode, h.modes.TILE);
});

test("late grab-end for a dead window cannot interrupt a new drag", () => {
  const h = createDestructionHarness();
  const dead = h.addWindow(h.modes.GRAB_TILE);
  h.wm._grabNodeWindow = dead;
  h.wm.freezeRender();
  h.wm.windowDestroy(dead.actor);
  h.flush();
  const dragged = h.addWindow(h.modes.GRAB_TILE);
  const preview = addPreview(dragged);
  h.wm._grabNodeWindow = dragged;
  h.wm.freezeRender();
  h.wm._handleGrabOpEnd(null, dead.nodeValue, 1);
  assert.equal(h.wm._grabNodeWindow, dragged);
  assert.equal(h.wm._freezeRender, true);
  assert.equal(preview.destroyed, 0);
});

test("forced focus renders cannot unfreeze an active drag", () => {
  const h = createHarness();
  h.addWindow(h.modes.GRAB_TILE);
  h.wm.freezeRender();
  h.wm.renderTree("focus", true);
  assert.equal(h.wm._freezeRender, true);
  assert.equal(h.idle.size, 0);
});

test("a delayed focus callback cannot unfreeze a drag that started after focus", () => {
  const h = createHarness();
  const callbacks = new Map();
  const queued = [];
  const actor = { actorSignals: [], border: {} };
  const meta = {
    get_title: () => "test window",
    get_window_type: () => 0,
    get_compositor_private: () => actor,
    connect(name, callback) {
      callbacks.set(name, callback);
      return callbacks.size;
    },
  };
  h.context.global = {
    display: {
      get_focus_window: () => meta,
      get_current_monitor: () => 0,
      get_workspace_manager: () => ({ get_active_workspace_index: () => 0 }),
    },
  };
  h.wm.ext.settings.get_boolean = (name) => name !== "auto-split-enabled";
  h.wm._validWindow = () => true;
  h.wm.postProcessWindow = () => {};
  h.wm.queueEvent = (event) => queued.push(event);
  let dragged;
  h.tree.findNode = (value) => (value === meta ? dragged : h.tree);
  h.tree.createNode = () => {
    dragged = h.addWindow();
    return dragged;
  };
  h.wm.trackWindow(null, meta);
  callbacks.get("focus")();

  h.wm.freezeRender();
  dragged.mode = h.modes.GRAB_TILE;
  queued.find((event) => event.name === "focus-update").callback();
  h.flush();
  assert.equal(h.wm._freezeRender, true);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
  assert.equal(h.renders(), 0);
});

test("drag state blocks rendering even if another callback cleared the freeze", () => {
  const h = createHarness();
  const dragged = h.addWindow();
  h.wm.renderTree("focus");
  dragged.mode = h.modes.GRAB_TILE;
  h.wm.unfreezeRender();
  h.flush();
  assert.equal(h.renders(), 0);
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
});

test("float processing preserves drag state while updating ordinary windows", () => {
  const h = createHarness();
  const dragged = h.addWindow(h.modes.GRAB_TILE);
  const ordinary = h.addWindow(h.modes.FLOAT);
  h.wm.processFloats();
  assert.equal(dragged.mode, h.modes.GRAB_TILE);
  assert.equal(ordinary.mode, h.modes.TILE);
});

test("queued renders respect a later freeze or disabled tiling", () => {
  for (const change of ["freeze", "disable"]) {
    const h = createHarness();
    h.addWindow();
    h.wm.renderTree("focus");
    if (change === "freeze") h.wm.freezeRender();
    else h.wm.ext.settings.get_boolean = () => false;
    h.flush();
    assert.equal(h.renders(), 0);
    assert.equal(h.wm._renderTreeSrcId, 0);
  }
});

test("ordinary forced renders and render coalescing still work", () => {
  const h = createHarness();
  h.addWindow();
  h.wm.freezeRender();
  h.wm.renderTree("focus", true);
  h.wm.renderTree("size-changed");
  assert.equal(h.idle.size, 1);
  h.flush();
  assert.equal(h.renders(), 1);
  assert.equal(h.wm._freezeRender, true);
});

function createRestoreHarness(autoSplit = true) {
  const h = createHarness();
  const focused = h.addWindow();
  focused.nodeValue.get_frame_rect = () => ({ x: 0, y: 0, width: 1600, height: 900 });
  h.tree.layout = "HSPLIT";
  h.context.global.display = {
    get_focus_window: () => focused.nodeValue,
    get_current_monitor: () => 0,
    get_workspace_manager: () => ({ get_active_workspace_index: () => 0 }),
  };
  const findNode = h.tree.findNode.bind(h.tree);
  h.tree.findNode = (value) => (value === "mo0ws0" ? h.tree : findNode(value));
  const splits = [];
  const actor = { actorSignals: [], border: {} };
  const restored = {
    get_title: () => "Restored Edge window",
    get_window_type: () => 0,
    get_compositor_private: () => actor,
    windowSignals: [],
  };
  h.wm.ext.settings.get_boolean = (name) => (name === "auto-split-enabled" ? autoSplit : true);
  h.wm._validWindow = () => true;
  h.wm.command = (action) => splits.push(action);
  h.wm.postProcessWindow = () => {};
  h.wm.queueEvent = () => {};
  h.tree.createNode = (_parent, _type, metaWindow) => {
    const node = h.addWindow();
    node._data = metaWindow;
    return node;
  };
  return { ...h, restored, splits };
}

test("restoring a new window auto-splits once and repeated notifications leave the layout alone", () => {
  const h = createRestoreHarness();
  h.wm.trackWindow(null, h.restored);
  assert.equal(h.splits.length, 1);
  assert.equal(h.splits[0].orientation, "horizontal");
  const node = h.tree.findNode(h.restored);
  assert.ok(node);
  for (let i = 0; i < 5; i++) h.wm.trackWindow(null, h.restored);
  assert.equal(h.splits.length, 1);
  assert.equal(h.tree.findNode(h.restored), node);
  assert.equal(h.tree.childNodes.length, 2);
});

test("notifications for an already tracked window never auto-split", () => {
  const h = createRestoreHarness();
  const existing = h.addWindow();
  existing._data = h.restored;
  h.wm.trackWindow(null, h.restored);
  assert.equal(h.splits.length, 0);
  assert.equal(h.tree.findNode(h.restored), existing);
});

test("invalid windows cannot trigger automatic splitting", () => {
  const h = createRestoreHarness();
  h.wm._validWindow = () => false;
  h.wm.trackWindow(null, h.restored);
  assert.equal(h.splits.length, 0);
  assert.equal(h.tree.findNode(h.restored), null);
});

test("new windows are tracked normally when automatic splitting is disabled", () => {
  const h = createRestoreHarness(false);
  h.wm.trackWindow(null, h.restored);
  assert.equal(h.splits.length, 0);
  assert.ok(h.tree.findNode(h.restored));
});
