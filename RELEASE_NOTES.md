# Forge 22.51.16

Restore tiled windows after client-initiated resizes when another focused window
retains an unknown grab mode. This fixes the captured VirtualBox guest-resize
failure that previously required switching focus to restore the tile.

- Recognize only move and resize grab modes in the geometry handler.
- Preserve actual move/resize grabs and fullscreen/maximized window geometry.
- Add regressions for unknown grab modes on the focused or resizing window,
  tile restoration without focus changes, and real move-grab handling.
- Ship a production build without temporary resize diagnostic logging.

Validation: all 198 JavaScript tests and fifteen Python tests passed, including
the isolated native GTK test rerun outside the sandbox. Source formatting and
package checks passed. The UNKNOWN regression fails against the previous handler.
Live verification of this fix remains pending.

Log out and back in after installation to load the updated extension.
