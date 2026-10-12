import Clutter from "gi://Clutter";
import Cogl from "gi://Cogl";
import GObject from "gi://GObject";
import Shell from "gi://Shell";
import { cornerPaintGeometry } from "../shared/window-corners.js";
import { CORNER_DECLARATIONS, CORNER_FRAGMENT } from "../shared/window-corner-shader.js";

const FRAGMENT_HOOK = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

function paintUniforms(effect) {
  const actor = effect.get_actor();
  const [valid, width, height] = effect.get_target_size();
  if (!valid || !effect.geometry || !actor) return null;
  const pipeline = effect.get_pipeline?.();
  // Shell.GLSLEffect uses straight-alpha blending by default, while an
  // offscreen window texture already contains premultiplied colors.
  if (Shell.GLSLEffect && pipeline)
    pipeline.set_blend("RGBA = ADD (SRC_COLOR, DST_COLOR * (1-SRC_COLOR[A]))");
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
    forge_pixel_step: [1 / actor.get_resource_scale()],
    forge_straight_alpha: [Shell.GLSLEffect && !pipeline ? 1 : 0],
  };
}

// GNOME 51 moved the snippet API from Shell.GLSLEffect to Clutter.ShaderEffect.
// Register only the class supported by this shell; older ShaderEffect APIs are
// incompatible with the new snippet constructor.
export const WindowCornerEffect = Shell.GLSLEffect
  ? GObject.registerClass(
      class ForgeWindowCornerEffect extends Shell.GLSLEffect {
        vfunc_build_pipeline() {
          this.add_glsl_snippet(FRAGMENT_HOOK, CORNER_DECLARATIONS, CORNER_FRAGMENT, false);
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
          return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, CORNER_DECLARATIONS, CORNER_FRAGMENT);
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
