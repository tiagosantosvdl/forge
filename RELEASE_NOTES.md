# Forge 22.51.11

The border radius setting now rounds window decorations and contents, and Ubuntu
Tiling Assistant can stay enabled while Forge manages tiling.

- Apply compositor clipping to GTK, Qt, and custom-decorated windows and dialogs.
  Add managed GTK theme overrides and a stylesheet for existing qt5ct/qt6ct
  configurations. Preserve square corners in fullscreen and maximized states.
- Align focus borders with the window using the configured stroke width and
  radius. Refresh borders immediately when appearance settings change, and
  account for client-side shadows and compositor texture padding when clipping.
- Pause Ubuntu Tiling Assistant's dragging, group resizing, shortcuts, popups,
  focus hints, and other assistance while Forge's global tiling is enabled.
  Restore its settings and handlers when Forge tiling or Forge is disabled,
  without disabling the Ubuntu extension. Preserve preference edits and save
  restoration data across Shell restarts.

Applications such as Edge and its installed web apps may need to restart to load
the updated theme radius. Tiling Assistant integration targets Ubuntu's extension
and uses its internal drag and resize handlers.

Validation: all JavaScript regression suites, native GJS/GTK and GSettings tests,
formatting checks, and Debian/ZIP packaging checks pass. The current desktop
session still needs to reload Forge after installation to use this release.
