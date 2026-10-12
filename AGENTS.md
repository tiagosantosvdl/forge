# Forge agent handoff

Updated 2026-10-12. This file provides repository instructions and a handoff
for future coding agents. Read any additional applicable `AGENTS.md` files.

## Maintaining this file

Keep this file up to date with your completed work and useful discoveries.
Update the current state, implementation notes, validation results, known
limitations, and remaining work when they change. Correct stale information
instead of appending a chronological activity log. Distinguish verified facts
from assumptions, and record enough context for another agent to continue.

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

Investigate and explain questions/bug reports; implement when explicitly asked
or told to proceed. Discussion does not authorize deployment or live desktop
configuration changes. When release and installation are requested, complete
them without repeatedly asking permission already granted. OS authentication
may still be necessary. Preserve unrelated edits. Never log out the user or
restart their live Shell automatically. This session did not authorize subagents.

## Current state

- Repository: https://github.com/tiagosantosvdl/forge; `origin` uses SSH; branch `main`.
- Extension UUID: `forge@tiagosantosvdl.github.com`.
- Current version: **22.51.13**, release tag `v22.51.13`.
- Release URL: https://github.com/tiagosantosvdl/forge/releases/tag/v22.51.13
- Version 22.51.13 was checksum-verified and installed locally. All installed
  extension files match its corresponding ZIP.
- System path: `/usr/share/gnome-shell/extensions/forge@tiagosantosvdl.github.com`.
- Local 22.51.13 assets/checksums are in ignored `dist/`; older published assets
  are cached under `dist/published-<version>/`.
- The user confirmed the corner appearance improved and requested committing,
  pushing, and tagging 22.51.13. Consult Git and GitHub for the resulting commit
  and publication status; recheck rather than assuming desktop or remote state.

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

The user asked whether Forge has a first-run thank-you/welcome notification.
It does **not**. They did not request implementing one.

### Related desktop investigation

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

The last release passed eight Node test files, seven Python tests including
native GTK/GJS/GSettings checks, formatting, whitespace, package contents, and
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

The user requested a version bump, Debian package, and local installation.
22.51.13 was built from the current working tree, including the new shader module,
and installed successfully. Installed files match the verified package. The user
was told to log out/in to load it; do not assume the session has reloaded.
The user subsequently confirmed improved appearance and requested committing,
pushing, and tagging 22.51.13, including this handoff. No feature work remains
outstanding. Verify release publication through GitHub when taking over.
Full manual visual testing remains a limitation, not authorization to alter the
user's session.
