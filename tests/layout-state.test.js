const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({});
vm.runInContext(
  fs
    .readFileSync(path.join(__dirname, "../lib/shared/layout-state.js"), "utf8")
    .replace(/^export /gm, ""),
  context
);
const plain = (value) => JSON.parse(JSON.stringify(value));
const leaf = (key, percent) => ({ key, ...(percent === undefined ? {} : { percent }) });
const group = (...children) => ({ layout: "HSPLIT", children });
const monitor = (id, tree, index = 0) => ({ id, workspaces: [{ index, tree }] });
const displays = [{ id: "external-A", primary: true }, { id: "external-B" }];
const external = {
  monitors: [
    monitor("external-A", group(leaf("whatsapp"), leaf("code"))),
    monitor(
      "external-B",
      group(
        { layout: "TABBED", children: [leaf("teams"), leaf("calendar")] },
        leaf("microsoft-edge")
      )
    ),
  ],
};

test("configuration identity ignores monitor order, geometry and workspace count", () => {
  assert.equal(
    context.configurationKey(displays),
    context.configurationKey([...displays].reverse())
  );
  assert.equal(
    context.configurationKey(displays),
    context.configurationKey(displays.map((m) => ({ ...m, x: 100, width: 800 })))
  );
  assert.notEqual(
    context.configurationKey(displays),
    context.configurationKey([{ id: "built-in" }])
  );
});

test("hardware serials survive connector changes and missing serials use the connector", () => {
  assert.equal(
    context.monitorIdentity(["DP-1", "IVM", "screen", "123"]),
    context.monitorIdentity(["DP-3", "IVM", "screen", "123"])
  );
  assert.notEqual(
    context.monitorIdentity(["DP-1", "IVM", "screen", "0x00000000"]),
    context.monitorIdentity(["DP-2", "IVM", "screen", "0x00000000"])
  );
});

test("Edge app identities include the profile and do not depend on titles", () => {
  assert.equal(
    context.windowIdentity({ get_wm_class: () => "msedge-teams-Default" }),
    "msedge-teams-Default"
  );
  assert.notEqual(
    context.windowIdentity({ get_wm_class: () => "msedge-teams-Profile1" }),
    "msedge-teams-Default"
  );
});

test("disconnecting arbitrary displays preserves groups and the original profile", () => {
  const before = JSON.stringify(external);
  const result = context.migrateProfile(external, [{ id: "built-in", primary: true }]);
  assert.equal(result.monitors[0].id, "built-in");
  assert.deepEqual(Array.from(context.layoutKeys(result.monitors[0].workspaces[0].tree)).sort(), [
    "calendar",
    "code",
    "microsoft-edge",
    "teams",
    "whatsapp",
  ]);
  assert.equal(JSON.stringify(external), before);
  assert.equal(result.monitors[0].workspaces[0].tree.children.length, 2);
});

test("partial disconnection preserves surviving displays and puts missing groups on primary", () => {
  const result = context.migrateProfile(external, [
    displays[1],
    { id: "new-display", primary: true },
  ]);
  assert.deepEqual(Array.from(context.layoutKeys(result.monitors[0].workspaces[0].tree)).sort(), [
    "calendar",
    "microsoft-edge",
    "teams",
  ]);
  assert.deepEqual(Array.from(context.layoutKeys(result.monitors[1].workspaces[0].tree)).sort(), [
    "code",
    "whatsapp",
  ]);
});

test("workspace memberships survive migration to a different display configuration", () => {
  const result = context.migrateProfile(
    { monitors: [monitor("external-A", group(leaf("teams")), 3)] },
    [{ id: "built-in", primary: true }]
  );
  assert.equal(result.monitors[0].workspaces[0].index, 3);
});

test("saving a partially reopened session keeps missing apps in their saved group", () => {
  const previous = {
    monitors: [monitor("A", { layout: "TABBED", children: [leaf("teams"), leaf("calendar")] })],
  };
  const current = { monitors: [monitor("A", group(leaf("teams")))] };
  const merged = context.mergeProfile(previous, current);
  assert.deepEqual(Array.from(context.layoutKeys(merged.monitors[0].workspaces[0].tree)).sort(), [
    "calendar",
    "teams",
  ]);
  const empty = context.mergeProfile(merged, { monitors: [monitor("A", group())] });
  assert.deepEqual(Array.from(context.layoutKeys(empty.monitors[0].workspaces[0].tree)).sort(), [
    "calendar",
    "teams",
  ]);
});

test("moving a live app removes its former slot on another monitor and workspace", () => {
  const previous = { monitors: [monitor("A", group(leaf("teams")), 2), monitor("B", group())] };
  const current = { monitors: [monitor("A", group()), monitor("B", group(leaf("teams")), 1)] };
  const merged = context.mergeProfile(previous, current);
  assert.equal(
    merged.monitors[0].workspaces.flatMap((ws) => context.layoutKeys(ws.tree)).length,
    0
  );
  assert.deepEqual(Array.from(context.layoutKeys(merged.monitors[1].workspaces[0].tree)), [
    "teams",
  ]);
});

test("a single regular Edge slot matches all its windows and is consumed only once", () => {
  const windows = new Map([["microsoft-edge", ["window-1", "window-2"]]]);
  const projected = context.projectLayout(
    group(leaf("microsoft-edge"), leaf("microsoft-edge")),
    windows
  );
  assert.equal(projected.children.length, 1);
  assert.deepEqual(projected.children[0].windows, ["window-1", "window-2"]);
  assert.equal(windows.size, 0);
});

test("small displays use tabs when saved columns would violate window minimum sizes", () => {
  const saved = group(leaf("teams"), leaf("calendar"), leaf("code"));
  const fitted = context.fitLayout(saved, 800, 600, () => ({ width: 400, height: 200 }));
  assert.equal(fitted.layout, "TABBED");
  assert.equal(saved.layout, "HSPLIT");
  assert.deepEqual(Array.from(context.layoutKeys(fitted)), ["teams", "calendar", "code"]);
});

test("legacy proportions are ignored when fitting restored splits", () => {
  const fitted = context.fitLayout(
    group(leaf("teams", 0.7), leaf("code", 0.3)),
    2000,
    1000,
    () => ({ width: 300, height: 200 })
  );
  assert.equal(fitted.layout, "HSPLIT");
  assert.deepEqual(plain(fitted), group(leaf("teams"), leaf("code")));
  // This split fits equally, even though its old small left share would not.
  const equalFit = context.fitLayout(
    group(leaf("teams", 0.1), leaf("code", 0.9)),
    1000,
    1000,
    () => ({ width: 300, height: 200 })
  );
  assert.equal(equalFit.layout, "HSPLIT");
});

test("loading legacy files removes sizing without losing placement or split direction", () => {
  const profile = {
    monitors: [
      monitor(
        "A",
        {
          layout: "HSPLIT",
          percent: 1,
          children: [
            { layout: "TABBED", splitLayout: "VSPLIT", percent: 0.7, children: [leaf("teams", 1)] },
            leaf("code", 0.3),
          ],
        },
        2
      ),
    ],
  };
  const before = JSON.stringify(profile);
  const loaded = context.readState({ version: 1, configurations: { '["A"]': profile } });
  const tree = loaded.configurations['["A"]'].monitors[0].workspaces[0].tree;
  assert.equal(JSON.stringify(tree).includes('"percent"'), false);
  assert.equal(tree.children[0].splitLayout, "VSPLIT");
  assert.equal(loaded.configurations['["A"]'].monitors[0].workspaces[0].index, 2);
  assert.equal(JSON.stringify(profile), before);
  const merged = context.mergeProfile(profile, {
    monitors: [monitor("A", group(leaf("teams", 0.5)), 2)],
  });
  assert.equal(JSON.stringify(merged).includes('"percent"'), false);
  assert.deepEqual(Array.from(context.layoutKeys(merged.monitors[0].workspaces[0].tree)).sort(), [
    "code",
    "teams",
  ]);
});

test("configuration round trips keep independent layouts for any active display sets", () => {
  const externalKey = context.configurationKey(displays);
  const mobileKey = context.configurationKey([{ id: "built-in" }]);
  const mobile = context.migrateProfile(external, [{ id: "built-in", primary: true }]);
  mobile.monitors[0].workspaces[0].tree = {
    layout: "TABBED",
    children: [leaf("teams"), leaf("code")],
  };
  const state = context.readState(
    JSON.parse(
      JSON.stringify({
        version: 1,
        configurations: { [externalKey]: external, [mobileKey]: mobile },
      })
    )
  );
  assert.deepEqual(plain(state.configurations[externalKey]), external);
  assert.deepEqual(plain(state.configurations[mobileKey]), plain(mobile));
});

test("invalid and excessively deep saved layouts are ignored", () => {
  const invalid = { monitors: [monitor("A", { layout: "INVALID", children: [] })] };
  assert.equal(
    Object.keys(
      context.readState({ version: 1, configurations: { '["A"]': invalid } }).configurations
    ).length,
    0
  );
  let deep = leaf("teams");
  for (let i = 0; i < 30; i++) deep = group(deep);
  assert.equal(context.validateLayout(deep), false);
  assert.deepEqual(plain(context.readState({ version: 99 })), { version: 1, configurations: {} });
});
