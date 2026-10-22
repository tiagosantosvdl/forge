# Forge agent handoff

Updated 2026-10-14. This file provides repository instructions and a handoff
for future coding agents. Read any additional applicable `AGENTS.md` files.

## Maintaining this file

Maintain `AGENTS.md` autonomously as a practical reference. Explain current
behavior, useful tools, discoveries, confirmed fixes, unresolved issues and
validation limits in the relevant section. Replace outdated information and
consolidate duplicates. Do not keep a chronological log, dated incident reports,
conversation history or a list of past authorizations. Preserve standing user
instructions and distinguish verified facts from hypotheses. Updating this
guide does not authorize implementation changes or changes to the running
machine.

This file will be committed to a **public repository**. Include only information
safe to publish. Never add credentials, tokens, passwords, private account or
contact details, personal data, private application/document contents, or
sensitive logs. Use repository-relative paths and generic placeholders instead
of personal filesystem paths or machine identifiers. Review additions for
private data before saving or committing; remove or generalize any private
information you encounter without reproducing it elsewhere in this file.

## User preferences

The user supplied this instruction:

> Always discuss the issues only, never makes unless I explicitely require.

Discuss issues and proposed changes first. Make implementation changes only
when explicitly requested. A request to implement or fix something authorizes
its corresponding edits and validation. Do not commit, push or publish unless
requested. Keep repository changes, test-environment changes and changes to the
running machine separate: permission for one does not automatically authorize
another. Historical requests recorded in this guide are context, not new tasks
or standing authorization.

When release and installation are requested, complete them without repeatedly
asking permission already granted. OS authentication may still be necessary.
Preserve unrelated edits. Never log out the user or restart their live Shell
automatically. Do not use subagents unless explicitly authorized.

## Current state

- Repository: https://github.com/tiagosantosvdl/forge; `origin` uses SSH; branch `main`.
- Extension UUID: `forge@tiagosantosvdl.github.com`.
- Current source and installed metadata version: **22.51.19**. The local
  installed package includes the group-restoration partition fix, cross-monitor
  preview refresh and whole-group edge drops described below. It was built with
  `production = false`; the source default remains true.
  ZIP and Debian checksums passed; their 72-file extension payloads match, and
  all 72 installed files match the verified debug ZIP.
  Artifacts and build log are under ignored `dist/debug-22.51.19/`.
- Latest published release remains **22.51.16**:
  https://github.com/tiagosantosvdl/forge/releases/tag/v22.51.16.
  Release commit `e08028b` and annotated tag `v22.51.16` were pushed with `main`;
  GitHub testing and release workflows completed successfully.
- System path: `/usr/share/gnome-shell/extensions/forge@tiagosantosvdl.github.com`.
- Installed `production` is false. Logging is enabled on the existing desktop
  session bus; level 6 (TRACE) was preserved. The user reports all installed
  changes pass testing. This does not establish a complete visual compatibility
  matrix. Previous packages remain in ignored `dist/`.
- Previous debug artifacts remain under ignored `dist/debug-22.51.15/` and
  `dist/debug-geometry-22.51.15/`; these are not the installed release.
- Release assets/checksums are in ignored `dist/`; published assets are cached
  under `dist/published-<version>/`.
- Passive live monitoring reproduced the VirtualBox guest-resize tiling failure
  with 22.51.15 enabled. See the desktop investigation below. Rendering checks
  and lock/unlock verification remain pending.

Declared Shell support is 45–51; the inspected local Shell was 50.1. Automated
checks are not a complete visual compatibility matrix. Installation does not
reload an already imported extension; the user was told to log out/in. Do not
assume they did so or assume Forge is currently enabled.

README follows the structure used by the sibling Dash to Panel and ArcMenu
forks: project identity, package installation and checksum verification, source
builds, configuration, development checks, releases, issues, and credits.
Forge's detailed layout, corner, integration, and shortcut documentation and
historical version descriptions are retained. Installation dependencies and
release instructions were checked against metadata, packaging, and workflows;
the documentation-only update passed Prettier 2.7.1, local-link checks, and
`git diff --check`.

## Implemented behavior and code

### Window corners

22.51.11 committed corner work initially installed locally as 22.51.10 without
a published tag. `lib/extension/window-corners.js` manages effects and toolkit
configuration; `window-corner-effect.js` implements clipping;
`lib/shared/window-corners.js` provides geometry/configuration helpers.
`extension.js` owns their lifecycle.

- Appearance's radius affects normal/dialog windows, including custom
  decorations, and focus outlines/previews. Zero disables clipping. Fullscreen
  and maximized corners stay square.
- Shader uniforms account for actual paint target, paint volume, client-side
  shadows, texture padding, and resource scale. Preserve this coordinate handling.
- Managed blocks in `$XDG_CONFIG_HOME/gtk-3.0/gtk.css` and `gtk-4.0/gtk.css`
  override GTK corners while preserving existing user CSS and edits.
- Existing qt5ct/qt6ct configurations register
  `$XDG_CONFIG_HOME/forge/window-corners.qss`. Qt top-level backgrounds stay
  square and clipping supplies outer rounding. QSS does not style native Qt
  Wayland decorations or Qt Quick; clipping handles their outer corners.
- `$XDG_CONFIG_HOME/forge/window-corners.json` records ownership/restoration.
  Disabling Forge removes its effects and managed overrides. Writes use etags
  and preserve symlinks; do not overwrite other user configuration.
- `WindowManager.showWindowBorders()` uses actual stroke width for the outset
  and radius plus outset for outer rounding, fixing GTK corner gaps. Theme
  reloads refresh clipping and border geometry immediately.
- **22.51.12:** focus/split highlights show only when global
  `tiling-mode-enabled` is true. The user initially requested the opposite and
  immediately corrected it. Preserve the focus-border preference. Window
  clipping remains independent of highlight visibility.

**22.51.17:** GTK 3 window backgrounds keep square top corners while decoration
and headerbar corners retain the configured radius. GTK 3 paints the main window
background below its titlebar, so rounding both `window.csd` and `decoration`
created another pair of corners at Inkscape's menu/content seam. An isolated GTK 3
Broadway render reproduced the cut-outs with the previous CSS; production CSS
from the corrected helper passed pixel checks at both menu corners with focused
and inactive styling. Inactive colors can conceal the cut-outs. The compositor
shader and focus-border geometry were not changed. The user reports that the
Inkscape issue has not recurred after installation. This is positive live
feedback, rather than a full visual compatibility matrix. `TESTS.md` includes
the manual check.

Edge/Edge web apps cache theme radius. The user confirmed reopening Edge and
Teams fixes their corners and explicitly accepted that behavior. Do not add
Edge refresh changes without a request. Clipping cannot restore pixels already
removed by an application's own rounding.

### Ubuntu Tiling Assistant

`lib/extension/tiling-assistant.js` coordinates with Ubuntu's
`tiling-assistant@ubuntu.com`, schema
`org.gnome.shell.extensions.tiling-assistant`. Its inspected source was under
`/usr/share/gnome-shell/extensions/tiling-assistant@ubuntu.com`.

UTA stays enabled. While Forge's global tiling is on, Forge suppresses UTA
assistance settings/shortcuts and pauses move, resize, tile/untile, and workspace
entry points. Settings alone cannot pause it: “Ignore TA” still permits edge
tiling. Private UTA APIs may need adjustment after future Ubuntu updates.

Turning Forge tiling off or disabling Forge restores settings and method
descriptors. Preserve edits made while paused, layouts, gaps, and appearance;
restore original defaults with `reset`, not explicit default values. Forge's
`tiling-assistant-overrides` schema key journals restoration data before UTA
settings change, surviving Shell restarts. Never modify UTA's own
`overridden-settings` journal. Integration tracks extension/handler recreation
and waits for an active window grab to finish before switching ownership.

### Per-monitor history and launch placement

Per-monitor histories and launch-monitor placement were introduced in 22.51.18
and are included in the installed local 22.51.19 debug package. The latest fixes
below passed 273 JavaScript tests, formatting, checksums and ZIP/Debian/installed
payload checks. The build used an isolated copy of tracked and non-ignored
working-tree files. The user reports all installed changes pass testing;
independent validation across the full supported Shell range remains incomplete.

- `lib/shared/layout-state.js` adds `readMonitorState()`. State version 2 stores
  histories under `monitors`, keyed by physical display identity. Legacy version
  1 snapshots are read without mutation; the last active configuration wins for
  monitors it contains, while other monitor histories remain available. Without
  timestamps for inactive snapshots, later entries win among those snapshots.
  Migration does not reconstruct groups already absent from the selected history.
- `lib/extension/layouts.js` retains live monitor/group nodes and resize shares
  on surviving displays, remapping numerical indices by identity. Returning
  displays restore their own histories. Displaced windows use saved slots,
  preferring a returning original monitor, then matching group members, then
  tiled-window count and display area. Unmatched windows use the least busy
  display. Session fallback origins allow returning windows to go home;
  unmatched temporary slots are excluded from host history. Deliberate moves
  release fallback ownership, including moves applied to the tree before Meta's
  monitor signal. Workspace removal updates active and disconnected histories.
- `lib/extension/launch-placement.js` uses `InjectionManager` to observe Shell.App
  activation/new-window/launch/action methods and Shell-created launch contexts.
  Requests match desktop application IDs through Shell.WindowTracker, expire
  after 15 seconds, and resolve monitors by identity. Only newly created normal,
  non-transient windows can claim them. Delayed identity receives retries from
  layout restoration. Claimed launch targets survive initial application geometry
  until the final group-restoration pass. Disabling restores hooks and disconnects
  launch-context signals. Launches outside these observed Shell paths retain
  GNOME/application placement. Captured requests do not infer monitor intent from
  later focus changes. Arbitrary third-party launchers need live verification.
- Installed Shell typelibs verified the App methods can be overridden and that
  Gio.AppLaunchContext exposes `launch-started`; this is not live UI validation.
  Nine JavaScript suites pass (223 tests). All fifteen Python tests passed, with
  the private Broadway GTK socket test rerun outside the sandbox. Changed JS
  passes pinned Prettier 2.7.1; `TESTS.md` includes pending live docking/menu checks.

Read-only debug investigation confirmed the reported browser windows restored
into splits and the affected web app was already on the other monitor before
its delayed group-restoration pass. It did not establish who selected the initial
monitor. The active two-monitor history had no tabbed/stacked groups; a saved
three-monitor history retained groups and used the same identities for its two
surviving displays. This establishes distinct configuration histories, rather
than an identity mismatch for those displays, but not why the active history
lost its groups. Do not copy private layout contents or window titles here.

#### Group-restoration partition fix (22.51.19)

An isolated reproduction using production `Layouts.restoreWindows()`,
`placeWindow()`, `Tree.split()` and persistence helpers confirms that pending
windows in mixed auto-split branches can merge distinct saved groups. Starting
with a correct split containing two separate tabbed groups, restoring five apps
in a batch merges them into one group; restoring the same apps one at a time
preserves both groups. No app identity collision is required.

In `placeWindow()`, `branchFor()` accepts any subtree containing at least one
saved app key. It does not check whether that subtree also contains apps assigned
to another saved group. The wrapper/reuse path consequently adopts the whole
mixed branch. Later app placement reuses that contaminated group. Split branches
not processed in the same pending batch can remain as group members, producing
split-screen members alongside full-area window members. `rendered()` captures
and persists the incorrect result. Existing partial-reopen tests insert windows
directly under monitor nodes and restore them one at a time; they miss pending
batches attached to nested auto-split branches. This defect is present in the
22.51.18 code; its exact initiating live event sequence was not logged.

The source now partitions incompatible branches using a projection of the saved
subtree. Only matching non-floating windows are detached and reconstructed;
foreign windows remain in their existing subtree. A live container is reused only
when its layout matches and all its members belong to the requested saved branch.
New projected groups use saved sibling order, including when a communications
app opens before either browser. Unrelated groups, actors, tabs and resize shares
are preserved. Empty source containers are cleaned after detaching their tabs.

Twenty-six new regressions cover horizontal/vertical splits, tabbed/stacked
groups, three opening orders, full/partial pending batches, persistence reloads,
foreign windows, floating windows, and unrelated groups/shares. The first eight
regressions failed before the source fix. All nine JavaScript suites pass
(249 tests); changed JS passed Prettier 2.7.1 and whitespace checks. The earlier
isolated reproductions now preserve both groups and keep unmatched splits out
of them. The fix is included in the installed local 22.51.19 debug package.
Existing merged live/saved arrangements were not modified, and cannot be
reconstructed from lost group boundaries by this fix alone. The user reports
that the installed changes pass testing; the full compatibility matrix is pending.

#### Cross-monitor previews and group edge drops (22.51.19)

An isolated reproduction confirmed target-cache loss when the pointer and dragged
window report different monitors during a refresh. The installed 22.51.18 code
filters all targets by pointer/window monitor equality and does not refresh on
ordinary movement, so an empty cache can suppress previews after crossing. This
is a reproduced failure path, rather than a logged live event sequence.

The source now refreshes targets during `_handleMoving()` without requiring
monitor equality. `trackCurrentMonWs()` uses the grabbed window, active-workspace
monitor nodes and `Tree.shownWindows()` to select currently visible tiled members,
checks native workspace visibility and actor validity, and retains native stacking
order. Minimized, floating and hidden tab members do not mask valid targets;
stacks without title lists retain their visible cascade. Empty destinations hide
previews. Pointer lookup includes the group rectangle and title bar.

`moveWindowToPointer()` treats a tabbed/stacked group, including its split members,
as one drop target. Left/right and top/bottom show the matching half of the whole
group, then `_dropBesideGroup()` wraps the intact group with a horizontal or
vertical split and inserts the dragged window outside it. The wrapper retains the
group's outer share; its internal layout, member tabs and internal shares remain
unchanged, as do unrelated siblings. Legacy monitor-level groups are moved into
a group container while retaining the monitor node. Center drops join the existing
group, including when the ungrouped center action is swap. The keyboard Split
command's existing guard for directly grouped windows has not been changed.

Twenty-four regressions cover all four edges, tabbed/stacked groups, nested split
members, preview/drop agreement, member and unrelated shares, legacy monitor
groups, center joins, cross-monitor target refresh, minimized/hidden members,
group title bars, and empty destinations. Eighteen initial regressions failed
before these changes. Nine JavaScript suites now pass (273 tests); changed JS
passes pinned Prettier 2.7.1 and whitespace checks. These fixes are included in
the installed local 22.51.19 debug package. The user reports the changes pass
testing; no complete live compatibility matrix has been established.

### Shortcut notifications

22.51.12 replaced transient `Main.notify()` warnings in
`lib/extension/keybindings.js` with a Forge-owned MessageTray source and
non-transient notifications. Clicking the warning or **Open Preferences** calls
`extension.openPreferences()`; the user selects Keyboard. Direct navigation to
Keyboard is not implemented.

Warnings remain listed until dismissed, resolved, replaced, or keybindings are
disabled. Changed signatures replace old warnings; unchanged signatures do not
repeat. Disable cleans the source and resets the signature so unresolved
warnings can return after re-enable. Both legacy GNOME 45 and GNOME 46+ APIs
have regression coverage.

The user reports lengthy "registration failed" warnings after unlocking.
A read-only check using the installed shortcut comparison modules found no
conflicts among the 40 Forge shortcut settings and the system/custom shortcuts
covered by that checker. This does not rule out bindings held by other extensions.
The GNOME Shell journal confirms repeated "Trying to re-add keybinding" warnings
for many Forge actions. Forge's own error messages were absent during that
investigation: the production build disables its logger. The local debug build
described above allows logging once the session loads it.

The duplicate-manager lifecycle bug was reproduced in an automated regression
and fixed in source at the user's request. `extension.js` constructs
`WindowManager` before assigning `this.keybindings`. Previously, the window
manager cached an undefined `_kbd`, and its `kbd` getter created a second
`Keybindings` instance during drag/drop permission checks, replacing
`ext.keybindings`. The original bindings and settings watchers escaped subsequent
lock/unlock cleanup. `lib/extension/window.js` now reads `ext.keybindings`
directly and no longer imports, caches, or creates a shortcut manager.
`tests/shortcut-conflicts.test.js` exercises the production window-manager getter,
drag permission check, keybindings, and session-mode callback with mocked Shell
APIs. It failed before the fix and passes afterward, checking manager identity,
three lock/unlock cycles, settings refresh, no spurious warnings, and cleanup of
bindings/watchers/pending work. All eight JavaScript files passed when run
individually (194 tests); changed JavaScript passed Prettier 2.7.1 and whitespace
checks. The local `node --test` runner hid child-test output; direct `node` runs
provided full results. `TESTS.md` records the manual drag/lock/unlock check.
The user requested a version bump, Debian package, and local installation for
this fix. Version 22.51.14 was built in an isolated temporary copy of the tracked
working-tree files, preserving the source checkout from build-generated changes.
Four packaging tests passed, package checksums verified, and ZIP/DEB extension
payloads matched. Installation via `pkexec /usr/bin/dpkg -i` succeeded; the package
query reports 22.51.14 and all 71 installed extension files match its ZIP.
Live desktop verification remains pending; log out/in is needed to load the fix
and clear stale in-memory registrations. Do not assume the session has reloaded.
Lock also resets `_lastProblems`, so unchanged warnings can recur on unlock;
preserving warning history alone would not resolve duplicate registration.

The user asked whether Forge has a first-run thank-you/welcome notification.
It does **not**. They did not request implementing one.

### Related desktop investigation

The user reports that VirtualBox's broad curved distortion/clipping appears
resolved after restarting the VM. Guest-driven resizes still disturb tile
placement after logging out/in with the debug build; switching focus restores
the tile. The tiling failure's exact live cause remains unconfirmed.

The new session emits geometry-triggered tree-render messages, including
`size-changed`, but those messages do not identify the emitting window or record
guards that skip rendering. They originate in `Tree.render()`, rather than at
entry to the geometry callback. Their presence therefore establishes some
completed scheduling, but does not establish that the failing guest resize
reached the callback. A subsequent passive capture confirmed the broken state:
the VM client shrank from 1908x1212 to 1024x810, with matching requested size
in `WM_NORMAL_HINTS`, no maximized/fullscreen state, and another window active.
No Forge tree-render messages appeared around that resize. While focus remained
elsewhere, another snapshot showed 1280x842; activating the VM restored
1908x1212 alongside a `render tree from focus` message. This confirms that
the failure persists with active debug logging, but absence of a tree-render
message does not distinguish a missed callback from a guard skipping rendering.
Targeted callback/guard diagnostics remain necessary to distinguish those paths.

Temporary `[geometry-diag]` logging in the diagnostic debug installation
confirmed callback and render-guard behavior. These diagnostics have been removed
from the 22.51.16 source and release packages at the user's request.

Live diagnostics captured the persistent failure: the VM's `size-changed`
callback ran with a 1024x847 frame (1024x810 client) and a 1908x1249 target
(1908x1212 client). Global tiling was enabled, the VM was tracked/tiled and
not maximized/fullscreen; freeze, drag and layout-transition/restoration guards
were false, with no pending render or move. The focused other window retained
`grabMode: "UNKNOWN"`. `updateMetaPositionSize()` treats any truthy grab mode
as an active grab, then returns for a notification from another window, logging
`geometry-skipped; other-window-grab`. This establishes the immediate cause of
this failure: the callback is delivered, but UNKNOWN blocks restoration before
render scheduling. Why that grab mode remains set is not yet established.
`Utils.grabMode()` returns UNKNOWN for operations outside its move/resize cases;
`_grabCleanup()` normally clears the node's grab mode. The proposed fix is to
recognize actual move/resize grabs explicitly and examine grab ownership/cleanup
so inactive state cannot suppress unrelated client resizes. Startup and another guest resize
with no focused grab mode were corrected automatically in the same session.

The source now restricts the geometry handler's grab path to MOVING or RESIZING
explicitly. UNKNOWN falls through to ordinary tile restoration whether the
resizing window or another window is focused. The regression reproducing
UNKNOWN on another focused window failed before this change and passes after
it; it also covers UNKNOWN on the emitting window, requested tile dimensions,
and no focus changes. A move-grab regression and the existing resize-grab checks
verify real grabs retain their handling. All eight JavaScript suites pass
(198 tests); changed files passed Prettier 2.7.1 and whitespace checks. This
source fix is published and installed as 22.51.16. Live verification of the fix
is pending a session reload and guest-resize reproduction.
The origin of lingering UNKNOWN remains unconfirmed, so grab lifecycle code
has not been changed on that hypothesis.

Passive X11 monitoring of the running VM confirmed a real host-window resize,
not just a rendering artifact. VirtualBox updated `WM_NORMAL_HINTS` and sent a
single `ConfigureWindow` request for its guest-sized client area. Both client
and decoration frame shrank; the client remained at that size for approximately
16 seconds until a focus change restored its previous tile dimensions. No
repeated VM resize requests were observed during that interval. Global Forge
tiling was enabled, the extension API reported 22.51.15 active, installed
`window.js` matched the repository, and the Shell process started after that
file's installation timestamp. These observations make stale installed code
unlikely but do not directly inspect imported module state.

The failure is narrowed to the automatic geometry-restoration path: focus still
reapplies the existing tile. The exact internal cause is unresolved. Passive X11
events cannot determine whether the Meta geometry callback is missed or whether
Forge skips or loses its corrective render. `renderTree()` has freeze, grab,
layout-transition and pending-idle guards; its focus callback requests a forced
render and queues an unfreeze. These are investigation targets, not confirmed
causes. Shell's D-Bus `Eval` returned false and production logging was disabled,
so neither callback execution nor live guard values were established. Temporary
observers did not alter extension code, settings, VM resolution, or window
placement. Existing synthetic resize tests directly invoke the geometry handler
and replace `renderTree()`, so they do not cover live signal delivery or its
actual idle scheduling and guards.

The source now calculates frame/buffer geometry on every effect paint alongside
the current render target, allocation and resource scale. It retains only the
configured radius and uses `Clutter.Effect.queue_repaint()` on updates to
invalidate cached effect output. Previously frame bounds were cached during
resize/allocation signals, potentially retaining an intermediate resize state.
Both Shell shader API tests exercise resizing and scale changes without another
manager update. The repaint API was verified against the installed typelib.

`WindowManager.updateMetaPositionSize()` now checks the window emitting a
geometry notification rather than the focused window. Tile restoration no longer
depends on another window being unmaximized or tracked, or on focus existing.
Notifications from other windows do not enter the focused window's grab handler;
fullscreen and maximized windows retain their own geometry. Two new regression
tests fail against the previous source and pass with the fix. All eight
JavaScript suites pass (196 tests); all fifteen Python tests pass with the
isolated native GTK socket test rerun outside the sandbox. `TESTS.md` includes
the pending VirtualBox manual checks. Synthetic tests do not exercise live
compositor texture reuse or VirtualBox. These changes are packaged, published and
installed as 22.51.15; live monitoring shows the guest-resize tiling symptom
persists. The rendering behavior remains unverified.

Okular is a Flatpak. Its Qt decoration plugin controls titlebar glyphs; normal
icon overrides did not change them. The user confirmed this launch gives the
expected decorations:

```sh
flatpak run --nosocket=wayland --socket=x11 --env=QT_QPA_PLATFORM=xcb org.kde.okular
```

Leaving Wayland access enabled with only `--socket=x11` did not expose a usable
display. The user applied Flatpak overrides themselves. This is not Forge code;
do not reapply/generalize the workaround without checking settings and scope.

Previous extension inspection found Auto Move Windows enabled with empty rules;
Native Window Placement only affects overview layout. Do not treat old extension
inventories as current state.

## Validation

The 22.51.17 source checks passed eight Node test files (198 tests) and fifteen
Python tests including native GTK/GJS/GSettings checks, formatting, whitespace, package contents, and
checksums. `TESTS.md` documents manual checks.

```sh
node --test tests/*.test.js
python3 -m unittest discover -s tests -p '*test.py'
git diff --check
```

Relevant tests: `window-corners.test.js` and `window_corners_test.py`;
`tiling-assistant.test.js` and `tiling_assistant_test.py` (real memory-backed
Gio.Settings); `shortcut-conflicts.test.js` (notification APIs);
`upstream-fixes.test.js` (borders); `release_package_test.py` (packaging).
Native tests use accompanying `.mjs` files.

CI uses `npm ci`, `npm test`, and `npm run test:unit`. Previously npm/gh were
unavailable locally. Temporary formatter installs disappeared between sessions.
Use the project-pinned Prettier 2.7.1; when npm is unavailable, download its
lockfile URL, verify the lockfile integrity hash, and extract it outside the repo. Whole-tree local
formatting checks can use `--ignore-path .gitignore` to exclude generated `lib/prefs/metadata.js`.

Native GTK tests use a private Broadway display and memory settings. Sandbox
restrictions can block its socket; approved unsandboxed reruns passed. Never
fall back to writes against live dconf. A previous diagnostic activated a host
dconf service with the wrong environment and changed extension settings; this
was disclosed and restored. Avoid repeating that approach. Previous isolated
headless Shell attempts failed due to schema compatibility and did not validate
visual rendering.

## Release/install workflow

Only release/install when requested. `.github/workflows/release.yml` publishes
automatically on version tags, so local `gh` is unnecessary.

1. Check status, branch, remote head, and tag availability. Preserve unrelated
   edits; do not replace published tags or force push.
2. Bump `package.json`, both root version fields in `package-lock.json`, and
   `metadata.json`'s `version-name`. Update README examples, preserving historical
   descriptions. Rewrite `RELEASE_NOTES.md`; the publish job uses it as its body.
3. Check and commit with a concrete behavior description and validation.
4. Build with `make release`. `make build` regenerates metadata/translations;
   previous releases avoided dirtying the checkout by extracting `git archive
   HEAD` to `/tmp`, setting `GIT_DIR` to the repo's `.git` and `GIT_WORK_TREE` to
   the temporary directory for contributor metadata, running `make build` there,
   then `scripts/package-release.py --output-dir <repo>/dist`.
5. Verify metadata, changed files, relevant schemas, and checksums from the
   directory containing `SHA256SUMS`.
6. Annotate `vMAJOR.MINOR.PATCH` and push atomically with the branch. Monitor both
   testing and release workflows until successful; a tag push alone is not a
   completed release. The public GitHub REST API exposes run/release status.
7. Download published assets into `dist/published-<version>/`, verify checksums,
   and install the published `.deb`. Local build bytes may differ due to timestamps.
8. Passwordless sudo was unavailable. `pkexec /usr/bin/dpkg -i <absolute-deb-path>`
   installed successfully via Ubuntu's graphical authentication prompt. Give the
   user time to authenticate; never ask for their password in chat. System writes
   require appropriate tool escalation.
9. Verify `dpkg-query`, installed metadata/files against the published ZIP, and
   Git status. Tell the user to log out/in to load the update; do not trigger logout.

Assets: `<uuid>-<version>.zip`,
`gnome-shell-extension-forge-tiagosantosvdl_<version>_all.deb`, and `SHA256SUMS`.
Package name: `gnome-shell-extension-forge`. Debian prereleases use `~rc.1` where
tags and ZIP filenames use `-rc.1`.

## Remaining work

The user reported poor masks on Firefox and an Outlook Edge app at 100% scale,
including faint window-colored tips, and then explicitly requested fixes.
Investigation found a hard frame-boundary discontinuity, possible doubled native
antialiasing, and straight-alpha blending on the legacy Shell effect path.

The source fix lives in `lib/shared/window-corner-shader.js` and
`lib/extension/window-corner-effect.js`. It clips continuously, caps native edge
coverage using nearby interior opacity, smooths over one physical render texel,
and clears RGB along with alpha in cut-outs. It relocates the existing shadow
profile from outside the rectangular frame around the rounded contour; guarded
sampling avoids opaque texture-edge clamping. Sampled colors respect actor fades.
Legacy pipelines use premultiplied blending where accessible, with a straight-RGB
shader fallback when older APIs cannot expose the pipeline.

Shadow relocation approximates the original profile rather than recreating an
arbitrary client's exact blur geometry. Live compositor alignment and the actual
Firefox/Edge appearance received positive local feedback after installation;
a complete compatibility matrix remains unverified.
The shader cannot recover pixels removed by a client's tighter native radius.

`tests/window_corner_shader_test.py` compiles and renders the production shader
using isolated surfaceless EGL/GLES. Eight pixel tests cover zero-RGBA tips,
native edge coverage, translucent windows, frame-boundary continuity, shadows,
texture clamping, render scale, legacy blending, and actor fading. Tests skip if
EGL/GLES or a surfaceless configuration is unavailable. They render synthetic
textures, not live applications. Existing JavaScript tests also check both Shell
shader APIs and the new uniforms. Current validation is eight JavaScript suites
and fifteen Python tests, including those eight pixel checks, plus formatting.

The remaining checks are live VirtualBox rendering and tile placement during
client resizes, shortcut behavior across lock/unlock, and the broader manual
visual compatibility matrix. Automated checks do not establish that the desktop
session has loaded the current source or that these live symptoms are resolved.
