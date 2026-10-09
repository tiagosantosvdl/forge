// Serializable layout operations; this module has no dependency on GNOME.
const layouts = new Set(["HSPLIT", "VSPLIT", "TABBED", "STACKED"]);
const clone = (value) => JSON.parse(JSON.stringify(value));

// Splits may be members of a group, but groups cannot be nested, even through
// intervening splits. Lift a nested group's members into its immediate parent
// without losing split directions, app slots, or window order. Resize weights
// in older files are session-only now.
export function normalizeLayout(tree) {
  const isGroup = (node) => node.layout === "TABBED" || node.layout === "STACKED";
  const visit = (source, grouped = false) => {
    const { percent, ...node } = source;
    if (node.children) {
      const withinGroup = grouped || isGroup(node);
      node.children = node.children.flatMap((child) => {
        const normalized = visit(child, withinGroup);
        return withinGroup && isGroup(normalized) ? normalized.children : [normalized];
      });
    }
    return node;
  };
  return visit(tree);
}

export function configurationKey(monitors) {
  return JSON.stringify(monitors.map((monitor) => monitor.id).sort());
}

export function monitorIdentity(spec) {
  const [connector, vendor, product, serial] = spec;
  const uniqueSerial = serial && !/^(0x)?0+$/.test(serial);
  return JSON.stringify([vendor, product, uniqueSerial ? serial : connector]);
}

export function windowIdentity(window) {
  return window.get_wm_class?.() || window.get_gtk_application_id?.() || null;
}

export function layoutKeys(node) {
  if (!node) return [];
  return node.key ? [node.key] : (node.children || []).flatMap(layoutKeys);
}

export function validateLayout(node, depth = 0, budget = { remaining: 2048 }) {
  if (!node || depth > 24 || --budget.remaining < 0) return false;
  if (node.key) return typeof node.key === "string" && node.key.length <= 512;
  return (
    layouts.has(node.layout) &&
    Array.isArray(node.children) &&
    node.children.length <= 256 &&
    node.children.every((child) => validateLayout(child, depth + 1, budget))
  );
}

export function readState(value) {
  if (value?.version !== 1 || !value.configurations || typeof value.configurations !== "object")
    return { version: 1, configurations: {} };
  const configurations = {};
  for (const [key, profile] of Object.entries(value.configurations).slice(-64)) {
    if (
      !Array.isArray(profile?.monitors) ||
      profile.monitors.length > 32 ||
      !profile.monitors.every(
        (monitor) =>
          typeof monitor.id === "string" &&
          Array.isArray(monitor.workspaces) &&
          monitor.workspaces.length <= 64 &&
          monitor.workspaces.every(
            (workspace) =>
              Number.isInteger(workspace.index) &&
              workspace.index >= 0 &&
              validateLayout(workspace.tree)
          )
      )
    )
      continue;
    if (key === configurationKey(profile.monitors))
      configurations[key] = {
        monitors: profile.monitors.map((monitor) => ({
          ...monitor,
          workspaces: monitor.workspaces.map((ws) => ({ ...ws, tree: normalizeLayout(ws.tree) })),
        })),
      };
  }
  return { version: 1, configurations, lastConfiguration: value.lastConfiguration };
}

// Keep slots for unopened apps. A move replaces the old slot within this
// monitor/workspace; histories in other locations remain independent.
function mergeMissing(previous, current, liveKeys) {
  if (!previous) return current;
  if (previous.key) {
    if (!liveKeys.has(previous.key)) return current || clone(previous);
    return current;
  }
  if (!current) {
    const children = previous.children
      .map((child) => mergeMissing(child, null, liveKeys))
      .filter(Boolean);
    return children.length ? { ...previous, children } : null;
  }
  if (current.key) current = { layout: previous.layout, children: [current] };
  const children = [...current.children];
  for (const [oldIndex, oldChild] of previous.children.entries()) {
    const oldKeys = new Set(layoutKeys(oldChild));
    const index = children.findIndex((child) => layoutKeys(child).some((key) => oldKeys.has(key)));
    if (index >= 0) children[index] = mergeMissing(oldChild, children[index], liveKeys);
    else {
      const missing = mergeMissing(oldChild, null, liveKeys);
      if (missing) {
        // Keep an unopened branch before its next surviving saved sibling.
        // Appending it would reverse the columns when the right group opens first.
        const followingKeys = new Set(previous.children.slice(oldIndex + 1).flatMap(layoutKeys));
        const following = children.findIndex((child) =>
          layoutKeys(child).some((key) => followingKeys.has(key))
        );
        children.splice(following < 0 ? children.length : following, 0, missing);
      }
    }
  }
  return { ...current, children };
}

export function mergeProfile(previous, current) {
  const monitors = current.monitors.map((monitor) => {
    const old = previous?.monitors.find((item) => item.id === monitor.id);
    const workspaces = monitor.workspaces.map((ws) => ({
      ...ws,
      tree: normalizeLayout(
        mergeMissing(
          old?.workspaces.find((item) => item.index === ws.index)?.tree,
          ws.tree,
          new Set(layoutKeys(ws.tree))
        )
      ),
    }));
    for (const ws of old?.workspaces || []) {
      if (workspaces.some((item) => item.index === ws.index)) continue;
      const tree = mergeMissing(ws.tree, null, new Set());
      if (tree) workspaces.push({ ...ws, tree: normalizeLayout(tree) });
    }
    return { ...monitor, workspaces };
  });
  return { monitors };
}

// A configuration never seen before inherits surviving monitor layouts. Groups
// from missing displays move to the primary display, without changing the source.
export function migrateProfile(previous, monitors) {
  const result = { monitors: monitors.map(({ id }) => ({ id, workspaces: [] })) };
  const primary = monitors.find((monitor) => monitor.primary) || monitors[0];
  if (!primary) return result;
  for (const old of previous?.monitors || []) {
    const target =
      result.monitors.find((monitor) => monitor.id === old.id) ||
      result.monitors.find((monitor) => monitor.id === primary.id);
    for (const ws of old.workspaces) {
      let destination = target.workspaces.find((item) => item.index === ws.index);
      if (!destination) {
        destination = { index: ws.index, tree: { layout: "HSPLIT", children: [] } };
        target.workspaces.push(destination);
      }
      destination.tree.children.push(normalizeLayout(ws.tree));
    }
  }
  return result;
}

export function projectLayout(tree, windowsByKey) {
  tree = normalizeLayout(tree);
  if (tree.key) {
    const windows = windowsByKey.get(tree.key);
    if (!windows?.length) return null;
    windowsByKey.delete(tree.key);
    return { ...tree, windows };
  }
  const children = tree.children.map((child) => projectLayout(child, windowsByKey)).filter(Boolean);
  return children.length ? { ...tree, children } : null;
}

export function fitLayout(tree, width, height, minimumSize, insideGroup = false) {
  if (!tree) return null;
  tree = normalizeLayout(tree);
  if (tree.key) return tree;
  let children = tree.children;
  const horizontal = tree.layout === "HSPLIT";
  const vertical = tree.layout === "VSPLIT";
  const minSize = (node) => {
    if (node.key) return minimumSize(node);
    const sizes = node.children.map(minSize);
    return {
      width:
        node.layout === "HSPLIT"
          ? sizes.reduce((sum, s) => sum + s.width, 0)
          : Math.max(0, ...sizes.map((s) => s.width)),
      height:
        node.layout === "VSPLIT"
          ? sizes.reduce((sum, s) => sum + s.height, 0)
          : Math.max(0, ...sizes.map((s) => s.height)) +
            (node.layout === "TABBED" && countWindows(node) > 1 ? 40 : 0),
    };
  };
  const countWindows = (node) =>
    node.key
      ? node.windows?.length || 1
      : node.children.reduce((sum, child) => sum + countWindows(child), 0);
  const share = 1 / children.length;
  const fits = children.every((child) => {
    const size = minSize(child);
    return (
      size.width <= (horizontal ? width * share : width) &&
      size.height <= (vertical ? height * share : height)
    );
  });
  if ((horizontal || vertical) && !fits) {
    const leaves = (node) => (node.key ? [node] : node.children.flatMap(leaves));
    return {
      layout: "TABBED",
      collapsedSplit: true,
      children: children.flatMap(leaves).map(normalizeLayout),
    };
  }
  children = children.map((child) =>
    fitLayout(
      child,
      horizontal ? width * share : width,
      vertical ? height * share : height,
      minimumSize,
      insideGroup || tree.layout === "TABBED" || tree.layout === "STACKED"
    )
  );
  // If an inner split cannot fit, make its windows separate outer tabs rather
  // than restoring a nested tab group or leaving an overfull inner split.
  if (insideGroup && (horizontal || vertical) && children.some((child) => child.collapsedSplit)) {
    const leaves = (node) => (node.key ? [node] : node.children.flatMap(leaves));
    return { layout: "TABBED", collapsedSplit: true, children: children.flatMap(leaves) };
  }
  return normalizeLayout({ ...tree, children });
}
