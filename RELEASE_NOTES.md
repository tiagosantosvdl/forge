# Forge 22.51.15

Address stale corner geometry and focus-dependent tile restoration during client resizes.

- Calculate corner geometry from the current window frame, buffer, actor allocation,
  and render target on every paint instead of caching an intermediate resize state.
- Invalidate cached effect output when the corner configuration is updated.
- Handle geometry notifications using the window that resized, including when
  another window is maximized or untracked, or focus is absent. Preserve active
  grabs and fullscreen/maximized window geometry.
- Add regression coverage for resize and scale changes without manager updates,
  tile restoration without focus changes, and grab/fullscreen handling.

Validation: all 196 JavaScript tests and fifteen Python tests passed. The two
new resize-handler regressions fail against the previous source. Source passed
Prettier 2.7.1 and whitespace checks. Live VirtualBox verification remains pending;
these changes address suspected causes of the reported rendering and tiling issues.

Log out and back in after installation to load the updated extension.
