import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import { cornerPaintGeometry } from "../shared/window-corners.js";

const DECLARATIONS = `
uniform vec2 forge_size;
uniform vec2 forge_origin;
uniform vec4 forge_bounds;
uniform float forge_radius;
`;

const FRAGMENT_HOOK = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

const CODE = `
vec2 forge_point = cogl_tex_coord_in[0].xy * forge_size + forge_origin;
// The buffer includes client-side shadows. Mask the window frame, preserving
// pixels outside it so that enabling rounding does not remove those shadows.
if (forge_point.x >= forge_bounds.x && forge_point.y >= forge_bounds.y &&
    forge_point.x <= forge_bounds.z && forge_point.y <= forge_bounds.w) {
    vec2 forge_half = (forge_bounds.zw - forge_bounds.xy) * 0.5;
    vec2 forge_center = (forge_bounds.zw + forge_bounds.xy) * 0.5;
    vec2 forge_delta = abs(forge_point - forge_center) - forge_half + vec2(forge_radius);
    float forge_distance = length(max(forge_delta, vec2(0.0))) +
        min(max(forge_delta.x, forge_delta.y), 0.0) - forge_radius;
    float forge_alpha = 1.0 - smoothstep(-0.5, 0.5, forge_distance);
    cogl_color_out *= forge_alpha;
}
`;

function paintUniforms(effect) {
  const actor = effect.get_actor();
  const [valid, width, height] = effect.get_target_size();
  if (!valid || !effect.geometry || !actor) return null;
  const volume = actor.get_paint_volume();
  let paint;
  if (volume) {
    const origin = volume.get_origin();
    paint = { x: origin.x, y: origin.y, width: volume.get_width(), height: volume.get_height() };
  } else {
    const box = actor.get_allocation_box();
    paint = {
      x: box.x1,
      y: box.y1,
      width: box.x2 - box.x1,
      height: box.y2 - box.y1,
      allocation: true,
    };
  }
  const geometry = cornerPaintGeometry(
    effect.geometry,
    paint,
    width,
    height,
    actor.get_resource_scale()
  );
  return {
    forge_size: geometry.size,
    forge_origin: geometry.origin,
    forge_bounds: geometry.bounds,
    forge_radius: [geometry.radius],
  };
}

// GNOME 51 moved the snippet API from Shell.GLSLEffect to Clutter.ShaderEffect.
// Register only the class supported by this shell; older ShaderEffect APIs are
// incompatible with the new snippet constructor.
export const WindowCornerEffect = Shell.GLSLEffect
  ? GObject.registerClass(
      class ForgeWindowCornerEffect extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
          this.add_glsl_snippet(FRAGMENT_HOOK, DECLARATIONS, CODE, false);
        }

        update(geometry) {
          this.geometry = geometry;
        }

        vfunc_paint_target(node, paintContext) {
          for (const [name, values] of Object.entries(paintUniforms(this) ?? {})) {
            this.set_uniform_float(this.get_uniform_location(name), values.length, values);
          }
          super.vfunc_paint_target(node, paintContext);
        }
      }
    )
  : GObject.registerClass(
      class ForgeWindowCornerEffect extends Clutter.ShaderEffect {
        vfunc_get_static_snippet() {
          return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, DECLARATIONS, CODE);
        }

        update(geometry) {
          this.geometry = geometry;
        }

        vfunc_paint_target(node, paintContext) {
          for (const [name, values] of Object.entries(paintUniforms(this) ?? {})) {
            this.set_uniform_float(name, values.length, values);
          }
          super.vfunc_paint_target(node, paintContext);
        }
      }
    );
