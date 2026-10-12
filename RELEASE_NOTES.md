# Forge 22.51.13

Fixes for abrupt corner masks and faint window-colored tips.

- Clip continuously across the rounded frame boundary and clear RGB together
  with alpha in cut-out corners.
- Preserve native edge coverage without smoothing it twice, including on
  translucent windows, and adapt smoothing to the physical render scale.
- Relocate the existing outer shadow profile around the rounded contour.
  Guard texture sampling so opaque titlebar pixels cannot leak through texture
  edge clamping. Preserve shadow color and follow actor opacity during fades.
- Correct premultiplied-alpha blending on the legacy shader path, with a
  straight-alpha fallback for older Shell APIs.
- Add eight isolated EGL/GLES rendering checks using the production shader.

Validation: eight JavaScript suites and fifteen native/package tests passed,
including actual shader pixel checks. Shadow relocation approximates custom
client blur shapes. Local visual feedback confirms improved corner appearance;
a full GNOME/application compatibility matrix remains unverified.

Log out and back in after installation to load the updated extension.
