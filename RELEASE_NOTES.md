# Forge 22.51.12

Focus borders now follow Forge's global tiling toggle, and shortcut warnings
remain accessible after their banners close.

- Show focus and split borders only while global tiling is enabled. Turning
  tiling off hides both; turning it back on restores enabled borders.
- Keep shortcut conflict and registration warnings in the notification list
  under Forge. Clicking the warning or **Open Preferences** opens Forge
  Preferences, where the Keyboard page shows the affected shortcuts.
- Replace outdated warnings when conflicts change, remove them when all
  conflicts are resolved, and clean them up when Forge is disabled.
- Support both GNOME 45 and the newer notification API, with regression coverage
  for notification persistence, activation, replacement, and cleanup.

Validation: all JavaScript regression suites, native GJS/GTK and GSettings tests,
formatting checks, and Debian/ZIP packaging checks pass. Log out and back in after
installation to load the updated extension.
