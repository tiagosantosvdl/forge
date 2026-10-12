# Forge 22.51.14

Fix shortcut registration failures after unlocking the screen.

- Reuse the extension-owned shortcut manager for window drag checks. Previously,
  a drag check could create a second manager, leaving the original shortcuts
  registered outside the lock/unlock cleanup path.
- Keep shortcut registration, settings watchers, and cleanup under one manager
  so unlocking can register shortcuts without duplicate-registration failures.
- Add regression coverage for dragging, repeated lock/unlock cycles, settings
  refresh, and cleanup. Genuine shortcut problems still produce notifications.

Validation: all 194 JavaScript tests passed, including a regression that failed
before the fix. All fifteen Python tests passed, including native preferences
and packaging checks. Source passed Prettier 2.7.1 and whitespace checks.
Live desktop verification remains pending.

Log out and back in after installation to load the updated extension.
