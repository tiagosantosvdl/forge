# Forge

A GNOME Shell tiling and window manager with split containers, tabbed and
stacked groups, and remembered layouts across sessions and display changes.

## Project status

This is [@tiagosantosvdl's fork](https://github.com/tiagosantosvdl/forge) of
[upstream Forge](https://github.com/forge-ext/forge), maintained using OpenAI
Codex. This fork provides its own extension packages.

- Current version: **22.51.19**.
- Extension UUID: `forge@tiagosantosvdl.github.com`.
- Supported GNOME Shell versions: **45–51**, as declared in
  [metadata.json](metadata.json), with X11 and Wayland support. This is not a
  completed compatibility test matrix.
- Settings schema: `org.gnome.shell.extensions.forge`, shared with upstream to
  preserve existing preferences.

The fork adds remembered layouts, window corner clipping, coordination with
Ubuntu Tiling Assistant, and shortcut conflict notifications. It also incorporates
fixes from 34 upstream pull requests covering resizing, minimum sizes, split
members in tabbed groups, focus borders, window cleanup, floating rules, and
configuration recovery. Adapted fixes identify the PR submitters and numbers
in source comments.

Automated checks cover regression behavior, native preferences and configuration,
shader rendering, formatting, and release packaging. Validate desktop behavior
in a running GNOME session separately. Rebuilding and installing do not reload
code already imported by Shell.

## Features

- Horizontal and vertical split containers with adjustable proportions
- Tabbed and stacked groups with split members, without nested groups
- Tab titles and app icons that update when window metadata changes
- Mouse drag and drop with grouping previews
- Keyboard navigation, moving, swapping, and resizing
- Floating windows and persistent window or application rules
- Automatic splitting, smart gaps, and customizable focus hints
- Tiling controls per workspace
- Remembered layouts per set of active displays, including workspace membership
- Customizable shortcuts, colors, gaps, and decorations in preferences

## Installation

Download the packages from this repository's
[GitHub Releases](https://github.com/tiagosantosvdl/forge/releases).
Each release includes an extension ZIP, a Debian package, and `SHA256SUMS`.

Disable upstream Forge before enabling this fork. The fork has a different UUID
from upstream's `forge@jmmaranan.com`, so installation does not replace upstream
automatically. Existing Forge settings and layout files are retained. Choose one
installation method: a per-user copy takes precedence over a system-wide copy
with the same UUID.

### Debian / Ubuntu package

For release `22.51.19`, install the downloaded package:

```sh
sudo apt install ./gnome-shell-extension-forge-tiagosantosvdl_22.51.19_all.deb
```

The package declares dependencies on GNOME Shell 45–51 and `gir1.2-adw-1`.
It installs under
`/usr/share/gnome-shell/extensions/forge@tiagosantosvdl.github.com/`.

Log out and back in after installation or an upgrade to load the installed code.
Enable the extension with:

```sh
gnome-extensions enable forge@tiagosantosvdl.github.com
```

If switching from a per-user installation to the Debian package, uninstall the
per-user copy first with
`gnome-extensions uninstall forge@tiagosantosvdl.github.com`.

### Per-user ZIP

Install the downloaded ZIP:

```sh
gnome-extensions install --force ./forge@tiagosantosvdl.github.com-22.51.19.zip
```

Install libadwaita's introspection bindings (`gir1.2-adw-1` on Debian / Ubuntu)
for preferences. Log out and back in, then enable the extension using the command
above. Extension Manager's browse catalog is separate from these GitHub releases.

### Verify downloads

Place `SHA256SUMS` and both release packages in the same directory, then run:

```sh
sha256sum -c SHA256SUMS
```

## Build from source

On Debian / Ubuntu, install the build tools and clone this repository:

```sh
sudo apt install git gettext libglib2.0-bin make python3 dpkg-dev zip
git clone https://github.com/tiagosantosvdl/forge.git
cd forge
make release
```

Building packages stages the extension under `temp/` without installing or
activating it. The release version comes from `package.json`. For version
`22.51.19`, the output is:

- `dist/forge@tiagosantosvdl.github.com-22.51.19.zip`
- `dist/gnome-shell-extension-forge-tiagosantosvdl_22.51.19_all.deb`
- `dist/SHA256SUMS`

Verify and install the local Debian build:

```sh
(cd dist && sha256sum -c SHA256SUMS)
sudo apt install ./dist/gnome-shell-extension-forge-tiagosantosvdl_22.51.19_all.deb
```

Alternatively, build and install a per-user copy:

```sh
make build
make install
```

`make install` copies the existing build from `temp/` into
`~/.local/share/gnome-shell/extensions/forge@tiagosantosvdl.github.com`; it does
not build it. After either installation method, log out and back in and enable
the extension as described above.

Build targets regenerate translation files and contributor metadata, so inspect
those changes before committing.

## Configuration and logs

Open preferences with:

```sh
gnome-extensions prefs forge@tiagosantosvdl.github.com
```

Preferences cover tiling behavior, workspaces, shortcuts, colors, gaps, and
window decorations. Existing saved preferences take precedence over repository
defaults.

| Data                 | Default path                                      |
| -------------------- | ------------------------------------------------- |
| Window rules         | `~/.config/forge/config/windows.json`             |
| Stylesheet overrides | `~/.config/forge/stylesheet/forge/stylesheet.css` |
| Remembered layouts   | `~/.local/state/forge/layouts.json`               |

Configuration paths honor `XDG_CONFIG_HOME`; remembered layouts honor
`XDG_STATE_HOME`. Invalid window rules fall back to defaults, with a `.bak`
copy of nonempty invalid content. Incomplete stylesheets gain missing defaults
while retaining custom properties, and the previous stylesheet is backed up.

For debug logging, build and install with `make dev`, then reload the session.
This enables logging in the installed build. Follow Forge messages with:

```sh
journalctl --user --follow --output=short-iso --grep '\[Forge\]'
```

Debug logs can contain application names and window titles; review them before
sharing them in an issue.

### Window corners

Appearance → Border radius controls window corners as well as Forge's focus
borders and tiling previews. Forge applies compositor clipping to regular windows
and dialogs, including applications with custom decorations. Fullscreen and
maximized windows keep square corners. A radius of zero disables clipping.

Forge also adds a managed block to the user’s `gtk-3.0/gtk.css` and
`gtk-4.0/gtk.css` under `$XDG_CONFIG_HOME` (normally `~/.config`). These overrides
use the selected radius, with square corners in fullscreen and maximized states.
Existing user CSS is preserved. Some applications need to restart to load it.

For existing qt5ct and qt6ct configurations, Forge registers a stylesheet that
keeps top-level widget backgrounds square, leaving the selected outer radius to
clipping. This preserves fullscreen behavior without changing the selected Qt
style or platform theme. Native Qt Wayland title bars and applications with
their own styling are handled by clipping; the stylesheet does not control those
decorations. Qt Quick applications also use clipping.

Disabling Forge removes its clipping effects and theme overrides, preserving
user configuration edits made while it was enabled. Clipping cannot restore
pixels already removed by an application's own rounded corners.

The mask uses a continuous rounded edge, preserves existing edge coverage rather
than smoothing native corners twice, and adapts smoothing to the render scale.
It samples the existing shadow outside the frame and moves that profile around
the rounded contour. This preserves shadow color without retaining titlebar
pixels in the cut-out tips; arbitrary client shadow shapes may differ slightly.

### Remembered layouts

Forge saves monitor placement, workspace membership, groups, and split directions
in `$XDG_STATE_HOME/forge/layouts.json`, normally
`~/.local/state/forge/layouts.json`.

Split sizes last for the current session. Connecting or disconnecting another
monitor preserves the groups and resize shares on monitors that remain active.
Restoring a returning monitor starts with equal shares, subject to window minimum
sizes; resize ratios in older saved files are ignored.

A new window launched through a Shell app or a menu using Shell's launch context
uses the monitor where it was launched. Its app's saved group is used only on
that monitor and workspace. This also covers new Edge app windows that reuse a
running process. Launches outside these Shell paths retain the location supplied
by the application or GNOME. Existing windows activated without opening a new
window and transient dialogs keep their placement.

A tabbed group with only one window hides its tab bar and gives that space back
to the window, even with automatic exit from tabbed layout disabled. A split
inside a tab with multiple windows still keeps its group tab.

Each physical monitor has its own saved layout, independent of which other
monitors are connected. Displays are identified by hardware identity rather than
their numerical index; rearranging or resizing the same displays reuses their
layout. Displays without a unique serial use their connector, and otherwise
identical identities are disambiguated by connector. Older monitor-set histories
are migrated, preferring the last active configuration for each monitor and
retaining the histories of disconnected monitors.

When a monitor disappears, its windows first use saved slots on the remaining
monitors. If several slots match, Forge prefers their original monitor when it
returns, then a monitor with matching group members, then the least busy monitor.
Windows without a saved slot go to the monitor with the fewest tiled windows;
equal counts prefer the larger display. Temporary placement without a saved slot
does not overwrite remembered app positions. Reconnecting a monitor returns its
displaced windows to it, unless they were deliberately moved elsewhere. This
also lets undocking use the built-in display's history and docking restore the
external displays' histories. Groups restored on a returning display that cannot
fit side by side become tabs.

When dropping onto a tabbed or stacked group, left/right places the dragged
window beside the whole group, and top/bottom places it above/below the group.
The group's existing members and internal splits stay intact. Center drops join
the existing group. Previews cover the corresponding half or the full group,
including when hovering a split member or the group title bar.

Workspace additions and removals are handled, including renumbering saved
workspace assignments after removal. When reconnecting displays, if a saved
workspace is unavailable, its groups use the last available workspace; Forge does not create workspaces to
match saved assignments. GNOME manages switching workspaces and moving windows
between them.

Windows are matched by window class, falling back to application ID, without
using their titles. Edge app windows can be distinguished when their window
class exposes the app and browser profile. Windows with the same identity,
including ordinary Edge windows, share the last saved slot within their current
monitor and workspace as tabs. Floating
windows are excluded. Slots for apps that have not reopened are retained so they
can join their previous groups later. Partially reopened sessions retain the
saved split direction and group order, including temporarily empty groups.

Groups can contain splits, but cannot contain other tabbed or stacked groups,
even through a split. Older saved layouts are migrated by lifting a nested
group's members into its immediate parent, preserving split directions and app
order, including apps that have not reopened yet.

This feature remembers placement and grouping; it does not launch apps or
restore browser tabs. To reset it, disable Forge, remove `layouts.json`, and
enable Forge again.

### Tab titles and icons

Forge identifies apps from their desktop entries and window identity, including
Edge apps, and refreshes tabs when GNOME updates that identity. Titles update as
apps change them, including unread counts in window titles. App icon changes and
changes to local icon files also refresh the tabs. These updates apply to split
member tabs and do not rearrange windows or save a new layout.

On current GNOME, browser favicons and notification badges drawn by an app may
not be exposed to Forge; tabs use the app icon available through GNOME.

### Ubuntu Tiling Assistant

Ubuntu Tiling Assistant can remain enabled alongside Forge. While Forge's global
tiling mode is on, Forge temporarily pauses its edge dragging, group resizing,
shortcuts, tiling popups, focus hints, layout indicator, and other assistance.
Turning Forge tiling off or disabling Forge restores the previous settings and
handlers. Layouts, gaps, and appearance preferences are preserved. Changes to
assistance preferences made while paused take effect when Forge releases control.

Saved preferences survive a Shell restart. Integration also handles enabling
Tiling Assistant after Forge and recreating its handlers after unlocking. A
switch made during a drag or resize waits until the grab ends. This applies to
Ubuntu's `tiling-assistant@ubuntu.com`; pausing drag and resize assistance uses
its internal handlers and may need adjustment if Ubuntu changes those APIs.

## Keyboard shortcuts

The table lists recommended repository defaults. Saved user shortcuts take
precedence. Open **Forge Preferences → Keyboard** to edit them. Type shortcuts
separated by commas, then press Enter or the apply button to save; typing alone
does not change a binding. The clear button disables an action.

Preferences shows conflicts with GNOME's window manager, Shell, media keys,
custom shortcuts, and other Forge actions. Conflicting or invalid edits cannot
be saved. GNOME shortcut changes update these warnings while preferences is
open. Shortcuts grabbed dynamically by other apps or extensions may not appear
in this check; registration failures produce a desktop notification.

Use **Apply recommended shortcuts** to replace all saved Forge keyboard
shortcuts after confirmation. This preserves the mouse drag modifier. The
recommended set is checked against your current GNOME shortcuts before it is
applied. Existing saved shortcuts are never rewritten just by opening
preferences or upgrading Forge.

At runtime, an action with a conflicting binding is disabled and reported in a
notification. The warning stays in the notification list until dismissed or
resolved; clicking it or **Open Preferences** opens Forge Preferences.
Resolve it in preferences; Forge refreshes its registrations when
shortcut settings change. GNOME's shortcuts are preserved.

Navigation uses Super+Alt+H/J/K/L; add Ctrl for swapping or Shift for moving.
Stacked layout uses Ctrl+Alt+Super+S, and vertical splitting uses
Ctrl+Alt+Super+V. Snapping uses Ctrl+Alt+Super, avoiding common screenshot,
lock-screen, minimize, terminal, and workspace-navigation bindings.

| Action                                                         | Shortcut                                          |
| -------------------------------------------------------------- | ------------------------------------------------- |
| Increase active window size left                               | `<Ctrl> + <Super> + y`                            |
| Decrease active window size left                               | `<Ctrl> + <Shift> + <Super> + o`                  |
| Increase active window size bottom                             | `<Ctrl> + <Super> + u`                            |
| Decrease active window size bottom                             | `<Ctrl> + <Shift> + <Super> + i`                  |
| Increase active window size top                                | `<Ctrl> + <Super> + i`                            |
| Decrease active window size top                                | `<Ctrl> + <Shift> + <Super> + u`                  |
| Increase active window size right                              | `<Ctrl> + <Super> + o`                            |
| Decrease active window size right                              | `<Ctrl> + <Shift> + <Super> + y`                  |
| Open preferences                                               | `<Super> + period`                                |
| Toggle tiling mode                                             | `<Super> + w`                                     |
| Focus left                                                     | `<Alt> + <Super> + h`                             |
| Focus right                                                    | `<Alt> + <Super> + l`                             |
| Focus up                                                       | `<Alt> + <Super> + k`                             |
| Focus down                                                     | `<Alt> + <Super> + j`                             |
| Swap current window with last active                           | `<Super> + Return`                                |
| Swap active window left                                        | `<Alt> + <Ctrl> + <Super> + h`                    |
| Swap active window right                                       | `<Alt> + <Ctrl> + <Super> + l`                    |
| Swap active window up                                          | `<Alt> + <Ctrl> + <Super> + k`                    |
| Swap active window down                                        | `<Alt> + <Ctrl> + <Super> + j`                    |
| Move active window left                                        | `<Alt> + <Shift> + <Super> + h`                   |
| Move active window right                                       | `<Alt> + <Shift> + <Super> + l`                   |
| Move active window up                                          | `<Alt> + <Shift> + <Super> + k`                   |
| Move active window down                                        | `<Alt> + <Shift> + <Super> + j`                   |
| Split container horizontally                                   | `<Super> + z`                                     |
| Split container vertically                                     | `<Ctrl> + <Alt> + <Super> + v`                    |
| Toggle split container                                         | `<Super> + g`                                     |
| Gap increase                                                   | `<Ctrl> + <Super> + Plus`                         |
| Gap decrease                                                   | `<Ctrl> + <Super> + Minus`                        |
| Toggle focus hint                                              | `<Super> + x`                                     |
| Toggle active workspace tiling                                 | `<Shift> + <Super> + w`                           |
| Toggle stacked layout                                          | `<Ctrl> + <Alt> + <Super> + s`                    |
| Toggle tabbed layout                                           | `<Shift> + <Super> + t`                           |
| Show/hide tab decoration                                       | `<Ctrl> + <Alt> + y`                              |
| Activate tile drag-drop                                        | `Start dragging - Mod key configuration in prefs` |
| Snap active window to center                                   | `<Ctrl> + <Alt> + <Super> + c`                    |
| Snap active window left two thirds                             | `<Ctrl> + <Alt> + <Super> + e`                    |
| Snap active window right two thirds                            | `<Ctrl> + <Alt> + <Super> + t`                    |
| Snap active window left third                                  | `<Ctrl> + <Alt> + <Super> + d`                    |
| Snap active window right third                                 | `<Ctrl> + <Alt> + <Super> + g`                    |
| Persist toggle floating for active window                      | `<Super> + c`                                     |
| Persist toggle floating for active window and its window class | `<Super><Shift> + c`                              |

## Development and verification

Source files live in `lib/extension/`, shared helpers in `lib/shared/`,
preferences in `lib/prefs/`, and tests in `tests/`. Packaging is handled by the
[Makefile](Makefile) and [scripts/package-release.py](scripts/package-release.py).
Agent guidance is in [AGENTS.md](AGENTS.md).

Node.js 18+ and npm are needed for development checks, but not to run the
extension. Install development dependencies and run the relevant checks:

```sh
npm ci
npm test                          # Prettier formatting check
npm run test:unit                 # JavaScript regression tests
python3 -m unittest discover -s tests -p '*test.py'
glib-compile-schemas --strict --dry-run schemas
git diff --check
```

Use `npm run format` to apply formatting. JavaScript tests can also run without
npm dependencies with `node --test tests/*.test.js`. Use `make dist` to build an
unversioned extension ZIP.

JavaScript tests use the extension's actual classes with controlled desktop APIs.
Native tests use GJS, GTK 4, libadwaita, GNOME settings schemas, and
`gtk4-broadwayd`, with a private display and in-memory settings. Shader pixel
tests use isolated surfaceless EGL/GLES and skip when it is unavailable.
These checks do not prove live desktop behavior or compatibility across all
supported GNOME versions. See [TESTS.md](TESTS.md) for manual checks.

`make dev` builds and installs a debug extension without restarting the session.
`make test-nested` launches a nested Wayland shell where supported; it requires
compatible GNOME binaries and settings schemas and is not an isolated extension
installation. `make test` installs into the user extension directory before
launching that shell. `make test-x` reinstalls and restarts the X11 shell.
The default `make` target and `make prod` also restart the session, which logs
out a Wayland session. Use explicit build and install commands to control when
the new code loads.

## Releases

Update the version in `package.json`, both root version fields in
`package-lock.json`, and `version-name` in `metadata.json`. Update the version
examples in this README and [RELEASE_NOTES.md](RELEASE_NOTES.md). Release tags
must match `package.json`, such as `v22.51.19`.

The [release workflow](.github/workflows/release.yml) validates the source,
builds packages, and publishes them when a matching version tag is pushed or a
GitHub Release is published. The manual **Run workflow** option builds
downloadable artifacts without publishing a release.

Prerelease tags such as `v22.51.19-rc.1` use package version `22.51.19-rc.1`,
GNOME `version-name` `22.51.19 rc.1`, and Debian version `22.51.19~rc.1`.
The workflow marks those releases as prereleases.

### Recent changes

Version 22.51.19 prevents pending auto-split branches from merging separate
saved groups during restoration. Cross-monitor drags refresh fitting targets,
and edge drops split beside the whole group horizontally or vertically while
center drops join it. Existing corrupted saved group boundaries are not rebuilt.

Version 22.51.18 remembers layouts per physical monitor, preserves groups and
resize shares on surviving displays, and places displaced windows using saved
slots or the least busy display. Shell-launched windows use their launch monitor,
including Edge apps that reuse a running process. Older monitor-set histories
are migrated to per-monitor histories.

Version 22.51.17 keeps GTK 3 content corners square below the titlebar, fixing
extra rounding at the menu bar in Inkscape while preserving outer window corners.

Version 22.51.16 restores client-resized tiles when the focused window has an
unknown grab mode, while preserving real move and resize grabs.

Version 22.51.15 refreshes corner geometry on every paint and invalidates cached
effect output after updates. Client resize notifications use the resizing
window rather than the focused window when restoring tile placement. Live
VirtualBox verification remains pending.

Version 22.51.14 fixes duplicate shortcut registration after unlocking by reusing
the extension-owned shortcut manager during window drag checks.

Version 22.51.13 improves continuous corner clipping, native edge smoothing,
shadow alignment, and alpha blending. Cut-out tips no longer retain window
color, and existing native rounded edges are not smoothed twice.

Version 22.51.12 hides focus borders when global tiling is disabled. Shortcut
conflict warnings remain in the notification list and open Forge Preferences when
clicked, and disappear when conflicts are resolved.

Version 22.51.11 adds window clipping and GTK/Qt theme overrides to the border
radius setting, preserving square fullscreen and maximized corners. Focus borders
follow the actual stroke width to avoid gaps at the corners. Ubuntu Tiling Assistant
can stay enabled: Forge pauses its assistance while global tiling is active and
restores the previous preferences when tiling or Forge is disabled.

Version 22.51.9 keeps newly opened windows on their opening monitor and workspace,
uses placement history only within that location, and hides tab bars when a group
has only one window left. It also prevents nested tabbed and stacked groups while
retaining splits inside tabs. Existing saved layouts are migrated without changing
monitor or workspace assignments; reconnecting displays can still restore existing
windows to their saved locations.
Version 22.51.6 keeps tab icons matched to their windows and refreshes titles and
available app icons as they change, including while dragging or reshuffling groups.
Version 22.51.5 preserves saved split directions and group order while apps
reopen gradually, preventing a temporarily empty column from collapsing the
layout into one tabbed group. Session sizing and incremental window restoration
from 22.51.4 remain supported.

## Issues and contributions

Report bugs and request features in this repository's
[issue tracker](https://github.com/tiagosantosvdl/forge/issues). Include your
distribution, GNOME Shell and Forge versions, X11 or Wayland session type,
relevant extensions, monitor arrangement, workspace and group layout,
reproduction steps, and relevant Shell logs.

Submit changes through [pull requests](https://github.com/tiagosantosvdl/forge/pulls),
with a description of the behavior changed and verification performed.

## Credits and licensing

This fork builds on [Forge](https://github.com/forge-ext/forge) by Jose Maranan
and its contributors and translators, including Benny Powers. Adapted upstream
fixes retain attribution to their authors in source comments. Build-generated
contributor information is also available in Forge's About preferences.

The extension is licensed under GPL-3.0-or-later; see [LICENSE](LICENSE).
