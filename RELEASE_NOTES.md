# Forge 22.51.17

Remove extra rounded corners below the titlebar in GTK 3 applications such as
Inkscape. Keep the window background's top corners square while preserving
rounded decorations, headerbars, and outer compositor clipping.

The issue was reproduced with Forge's GTK CSS on a private GTK 3 display,
including the stronger visual contrast when the window is focused. The corrected
CSS removes the menu-area cut-outs in that isolated reproduction.

Validation: all 198 JavaScript tests and fifteen Python tests passed, with the
native GTK preferences test rerun outside the sandbox. Focused and unfocused
GTK 3 pixel checks passed using the corrected production CSS. Formatting,
checksums, and ZIP/Debian payload comparisons passed. The user reports that the
Inkscape issue has not recurred after installation.

Log out and back in after installation to load the updated extension. Restart
Inkscape afterward if it retains the old GTK styling.
