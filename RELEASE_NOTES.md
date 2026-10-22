# Forge 22.51.19

Remember layouts per physical monitor rather than per monitor combination.
Surviving displays keep their groups and resize shares. Displaced windows use
saved slots on active displays, otherwise the least busy display, and return to
their original display when it reconnects unless deliberately moved elsewhere.
New windows launched through Shell app methods or Shell-created launch contexts
use the launch monitor, including Edge apps reusing existing processes. Existing
monitor-set histories migrate to per-monitor histories.

Prevent batched window restoration from merging distinct saved groups. Rebuild
only matching members of a provisional split branch, preserving unrelated
windows, groups, actors and resize shares. This prevents mixed split/full-area
group members from being introduced by that restoration path. Existing merged
saved arrangements still require regrouping.

Refresh drag targets during movement across monitors without requiring the
pointer and dragged window to report the same monitor. Use visible group members
and include the group title bar in hit testing.

Treat grouped windows as one edge-drop target: left/right places the dragged
window beside the group, top/bottom above/below it, and center joins the group.
Previews use the corresponding half or full group rectangle. Preserve internal
splits and unrelated sibling shares, including legacy monitor-level groups.

Validation: all 273 JavaScript tests passed, including regressions for batched
restoration, persistence, cross-monitor previews, and grouped edge drops. Changed
JavaScript passed Prettier 2.7.1 and whitespace checks. The user reports the
installed changes pass testing; this is not a complete GNOME compatibility matrix.

This release also includes the GTK 3 content-corner fix from 22.51.17, keeping
background corners square below titlebars while retaining rounded decorations.

Log out and back in after installation to load the updated extension.
