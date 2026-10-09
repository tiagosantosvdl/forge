# Forge

A GNOME Shell tiling and window manager, maintained in this
[fork](https://github.com/tiagosantosvdl/forge) of
[forge-ext/forge](https://github.com/forge-ext/forge).

## Project status

This fork is 100% maintained using OpenAI Codex.

This fork adds remembered layouts across sessions and display changes, fixes
window dragging and restoration, and incorporates fixes from 34 upstream pull
requests. Adapted fixes carry comments identifying the PR submitters and numbers.
They cover resizing and minimum sizes, nested and tabbed groups, focus borders,
window lifetime and signal cleanup, floating rules, and configuration recovery.

The extension declares compatibility with GNOME Shell 45–51 and supports X11 and
Wayland. This declaration is not a completed test matrix for every version.
Current validation includes 81 automated tests, native GJS configuration and
stylesheet checks, formatting checks, and an extension package build. Full
GNOME Shell validation of the latest upstream fixes is still pending. Repository
changes take effect in an installed extension only after rebuilding, installing,
and reloading it.

## Features

- Horizontal and vertical split containers with adjustable proportions
- Tabbed and stacked groups, including nested groups
- Mouse drag and drop with grouping previews
- Keyboard navigation, moving, swapping, and resizing
- Floating windows and persistent window or application rules
- Automatic splitting, smart gaps, and customizable focus hints
- Tiling controls per workspace
- Remembered layouts per set of active displays, including workspace membership
- Customizable shortcuts, colors, gaps, and decorations in preferences

## Remembered layouts

Forge saves monitor placement, workspace membership, groups, split directions,
and proportions in `$XDG_STATE_HOME/forge/layouts.json`, normally
`~/.local/state/forge/layouts.json`.

Each set of active displays has its own saved layout. There are no fixed
“docked” or “laptop-only” profiles. Displays are identified by hardware identity
rather than their numerical index; rearranging or resizing the same displays
reuses their layout. Displays without a unique serial use their connector, and
otherwise identical identities are disambiguated by connector.

When Forge encounters a new display configuration, groups on surviving displays
stay there. Groups from missing displays move to the primary display on their
existing workspaces. Groups that cannot fit side by side become tabs. Returning
to a previously used configuration restores its saved layout after monitor
changes settle.

Workspace additions and removals are handled, including renumbering saved
workspace assignments after removal. If a saved workspace is unavailable, its
groups use the last available workspace; Forge does not create workspaces to
match saved assignments. GNOME manages switching workspaces and moving windows
between them.

Windows are matched by window class, falling back to application ID, without
using their titles. Edge app windows can be distinguished when their window
class exposes the app and browser profile. Windows with the same identity,
including ordinary Edge windows, share the last saved slot as tabs. Floating
windows are excluded. Slots for apps that have not reopened are retained so they
can join their previous groups later.

This feature remembers placement and grouping; it does not launch apps or
restore browser tabs. To reset it, disable Forge, remove `layouts.json`, and
enable Forge again.

## Installation

Download the ZIP or Debian package from
[GitHub Releases](https://github.com/tiagosantosvdl/forge/releases).

Install the ZIP for your user:

```bash
gnome-extensions install --force forge@tiagosantosvdl.github.io-22.51.2.zip
```

Log out and back in, then enable Forge in Extension Manager or with
`gnome-extensions enable forge@tiagosantosvdl.github.io`. The ZIP uses GNOME's
standard extension format; Extension Manager's browse catalog is separate from
these GitHub releases.

On Debian or Ubuntu with GNOME Shell 45–51, install the system-wide package:

```bash
sudo apt install ./gnome-shell-extension-forge_22.51.2_all.deb
```

Log out and back in, then enable Forge. A user-local installation with this
fork's UUID takes precedence over the system-wide package; uninstall that local
copy with `gnome-extensions uninstall forge@tiagosantosvdl.github.io` before
switching to the Debian package.

### Build from source

Build dependencies are `make`, Git, `gettext`, and GLib tools including
`glib-compile-schemas`. Install `zip` to build a distributable archive. Node.js
18+ and npm are needed for development checks, but not to run the extension.

From a checkout:

```bash
make build
make install
# After reloading GNOME Shell, enable Forge if needed:
gnome-extensions enable forge@tiagosantosvdl.github.io
```

`make install` copies the existing build from `temp/` into
`~/.local/share/gnome-shell/extensions/forge@tiagosantosvdl.github.io`; it does not build it.
This fork uses `forge@tiagosantosvdl.github.io`, distinct from upstream's
`forge@jmmaranan.com`, so installing it does not replace upstream. Disable the
upstream extension before enabling this fork so only one tiling manager runs.
The existing Forge settings and layout files are retained.

Log out and back in on Wayland to load newly installed code. On X11, restart
GNOME Shell with Alt+F2, then `r`. Save your work before restarting the session.
Open extension preferences with:

```bash
gnome-extensions prefs forge@tiagosantosvdl.github.io
```

## Releases

The release workflow runs checks, builds both packages, and attaches them plus
`SHA256SUMS` to a GitHub Release when a `vMAJOR.MINOR.PATCH` tag is pushed.
The tag must match `package.json`. Prerelease tags such as `v22.51.2-rc.1` are
also supported and produce GitHub prereleases.

For each release, update the version in `package.json`, both root version fields
in `package-lock.json`, and `version-name` in `metadata.json` (use a space in
place of the prerelease hyphen for GNOME). Commit the changes, then tag and push:

```bash
git tag -a v22.51.2 -m "Forge 22.51.2"
git push origin main v22.51.2
```

Publishing a release manually also builds and attaches the packages. Running
the workflow with **Run workflow** builds downloadable workflow artifacts
without publishing a release.

Build the same packages locally with `make release`. This additionally needs
Python 3 and `dpkg-deb` (from `dpkg`). Outputs are under `dist/`:

- `forge@tiagosantosvdl.github.io-22.51.2.zip` for per-user installation
- `gnome-shell-extension-forge_22.51.2_all.deb` for system-wide installation
- `SHA256SUMS` for verification with `cd dist && sha256sum -c SHA256SUMS`

The Debian package is architecture-independent and requires a supported GNOME
Shell version. Its files live under
`/usr/share/gnome-shell/extensions/forge@tiagosantosvdl.github.io/`.

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
notification. Resolve it in preferences; Forge refreshes its registrations when
shortcut settings change. GNOME's shortcuts are preserved.

Navigation uses Super+Alt+H/J/K/L; add Ctrl for swapping or Shift for moving.
Stacked layout uses Ctrl+Alt+Super+S, and vertical splitting uses
Ctrl+Alt+Super+V. Snapping uses Ctrl+Alt+Super, avoiding common screenshot,
lock-screen, minimize, terminal, and workspace-navigation bindings.

| Action | Shortcut |
| --- | --- |
| Increase active window size left | `<Ctrl> + <Super> + y` |
| Decrease active window size left | `<Ctrl> + <Shift> + <Super> + o` |
| Increase active window size bottom | `<Ctrl> + <Super> + u` |
| Decrease active window size bottom | `<Ctrl> + <Shift> + <Super> + i` |
| Increase active window size top | `<Ctrl> + <Super> + i` |
| Decrease active window size top | `<Ctrl> + <Shift> + <Super> + u` |
| Increase active window size right | `<Ctrl> + <Super> + o` |
| Decrease active window size right | `<Ctrl> + <Shift> + <Super> + y` |
| Open preferences | `<Super> + period` |
| Toggle tiling mode |`<Super> + w` |
| Focus left | `<Alt> + <Super> + h` |
| Focus right | `<Alt> + <Super> + l` |
| Focus up | `<Alt> + <Super> + k` |
| Focus down | `<Alt> + <Super> + j` |
| Swap current window with last active | `<Super> + Return` |
| Swap active window left | `<Alt> + <Ctrl> + <Super> + h` |
| Swap active window right | `<Alt> + <Ctrl> + <Super> + l` |
| Swap active window up | `<Alt> + <Ctrl> + <Super> + k` |
| Swap active window down | `<Alt> + <Ctrl> + <Super> + j` |
| Move active window left | `<Alt> + <Shift> + <Super> + h` |
| Move active window right | `<Alt> + <Shift> + <Super> + l` |
| Move active window up | `<Alt> + <Shift> + <Super> + k` |
| Move active window down | `<Alt> + <Shift> + <Super> + j` |
| Split container horizontally | `<Super> + z` |
| Split container vertically | `<Ctrl> + <Alt> + <Super> + v` |
| Toggle split container | `<Super> + g` |
| Gap increase | `<Ctrl> + <Super> + Plus` |
| Gap decrease | `<Ctrl> + <Super> + Minus` |
| Toggle focus hint | `<Super> + x` |
| Toggle active workspace tiling | `<Shift> + <Super> + w` |
| Toggle stacked layout | `<Ctrl> + <Alt> + <Super> + s` |
| Toggle tabbed layout | `<Shift> + <Super> + t` |
| Show/hide tab decoration | `<Ctrl> + <Alt> + y` |
| Activate tile drag-drop | `Start dragging - Mod key configuration in prefs` |
| Snap active window to center | `<Ctrl> + <Alt> + <Super> + c` |
| Snap active window left two thirds | `<Ctrl> + <Alt> + <Super> + e` |
| Snap active window right two thirds | `<Ctrl> + <Alt> + <Super> + t` |
| Snap active window left third | `<Ctrl> + <Alt> + <Super> + d` |
| Snap active window right third | `<Ctrl> + <Alt> + <Super> + g` |
| Persist toggle floating for active window | `<Super> + c` |
| Persist toggle floating for active window and its window class | `<Super><Shift> + c` |

## Configuration and logs

| Data | Default path |
| --- | --- |
| Window rules | `~/.config/forge/config/windows.json` |
| Stylesheet overrides | `~/.config/forge/stylesheet/forge/stylesheet.css` |
| Remembered layouts | `~/.local/state/forge/layouts.json` |

Configuration paths honor `XDG_CONFIG_HOME`; remembered layouts honor
`XDG_STATE_HOME`. Invalid window rules fall back to defaults, with a `.bak`
copy of nonempty invalid content. Incomplete stylesheets gain missing defaults
while retaining custom properties, and the previous stylesheet is backed up.

For debug logging, build and install with `make dev`, then reload the session.
This enables logging in the installed build. Follow Forge messages with:

```bash
journalctl --user --follow --output=short-iso --grep '\[Forge\]'
```

Debug logs can contain application names and window titles. When reporting a
bug, include the GNOME version, X11 or Wayland session type, monitor arrangement,
workspace and group layout, steps to reproduce, and relevant log messages.

## Development

```bash
npm install
npm test                          # Prettier formatting check
npm run test:unit                 # Automated regression tests
python3 -m unittest discover -s tests -p '*test.py'  # Packaging and native preferences tests
npm run format                    # Apply formatting
make dist                         # Build forge@tiagosantosvdl.github.io.zip
```

Native shortcut preferences tests use GJS, GTK 4, libadwaita, GNOME settings
schemas, and `gtk4-broadwayd`. They run with a private display and in-memory
settings; both CI workflows install these dependencies.

The automated tests can also run without npm dependencies:

```bash
node --test tests/*.test.js
```

They cover drag lifecycle, layout persistence, and upstream regressions using
the extension's actual classes with controlled desktop APIs. They do not
require a running GNOME Shell or prove desktop behavior on their own.

`make dev` builds and installs a debug extension without restarting the session.
`make test-nested` launches a nested Wayland shell where supported; it requires
compatible GNOME binaries and settings schemas and is not an isolated extension
installation. `make test` installs into the user extension directory before
launching that shell. `make test-x` reinstalls and restarts the X11 shell.
The default `make` target and `make prod` also restart the session, which logs
out a Wayland session. Use explicit build and install commands when you want to
control when the new code loads.

Build targets regenerate translation files and contributor metadata, so inspect
those changes before committing. Keep desktop testing separate from the
unit-test and packaging results when reporting validation.
