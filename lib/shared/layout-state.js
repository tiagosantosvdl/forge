// Serializable layout operations; this module has no dependency on GNOME.
const layouts = new Set(["HSPLIT", "VSPLIT", "TABBED", "STACKED"]);
const clone = (value) => JSON.parse(JSON.stringify(value));

// Older files include resize weights. Keep the layout, but discard session sizing.
function withoutSizing(tree) {
  const { percent, ...node } = tree;
  if (node.children) node.children = node.children.map(withoutSizing);
  return node;
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
          workspaces: monitor.workspaces.map((ws) => ({ ...ws, tree: withoutSizing(ws.tree) })),
        })),
      };
  }
  return { version: 1, configurations, lastConfiguration: value.lastConfiguration };
}

// Keep slots for apps which have not reopened yet, without retaining their old
// placement when a live window has deliberately been moved elsewhere.
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
  for (const oldChild of previous.children) {
    const oldKeys = new Set(layoutKeys(oldChild));
    const index = children.findIndex((child) => layoutKeys(child).some((key) => oldKeys.has(key)));
    if (index >= 0) children[index] = mergeMissing(oldChild, children[index], liveKeys);
    else {
      const missing = mergeMissing(oldChild, null, liveKeys);
      if (missing) children.push(missing);
    }
  }
  return { ...current, children };
}

export function mergeProfile(previous, current) {
  const liveKeys = new Set(
    current.monitors.flatMap((monitor) => monitor.workspaces.flatMap((ws) => layoutKeys(ws.tree)))
  );
  const monitors = current.monitors.map((monitor) => {
    const old = previous?.monitors.find((item) => item.id === monitor.id);
    const workspaces = monitor.workspaces.map((ws) => ({
      ...ws,
      tree: withoutSizing(
        mergeMissing(
          old?.workspaces.find((item) => item.index === ws.index)?.tree,
          ws.tree,
          liveKeys
        )
      ),
    }));
    for (const ws of old?.workspaces || []) {
      if (workspaces.some((item) => item.index === ws.index)) continue;
      const tree = mergeMissing(ws.tree, null, liveKeys);
      if (tree) workspaces.push({ ...ws, tree: withoutSizing(tree) });
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
      destination.tree.children.push(withoutSizing(ws.tree));
    }
  }
  return result;
}

export function projectLayout(tree, windowsByKey) {
  if (tree.key) {
    const windows = windowsByKey.get(tree.key);
    if (!windows?.length) return null;
    windowsByKey.delete(tree.key);
    return { ...tree, windows };
  }
  const children = tree.children.map((child) => projectLayout(child, windowsByKey)).filter(Boolean);
  return children.length ? { ...tree, children } : null;
}

export function fitLayout(tree, width, height, minimumSize) {
  if (!tree) return null;
  if (tree.key) return withoutSizing(tree);
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
          : Math.max(0, ...sizes.map((s) => s.height)) + (node.layout === "TABBED" ? 40 : 0),
    };
  };
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
      children: children.flatMap(leaves).map(withoutSizing),
    };
  }
  children = children.map((child) =>
    fitLayout(
      child,
      horizontal ? width * share : width,
      vertical ? height * share : height,
      minimumSize
    )
  );
  return { ...withoutSizing(tree), children };
}
