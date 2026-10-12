// Shared with offscreen rendering tests so they compile the production shader.
export const CORNER_DECLARATIONS = `
uniform vec2 forge_size;
uniform vec2 forge_origin;
uniform vec4 forge_bounds;
uniform float forge_radius;
uniform float forge_pixel_step;
uniform float forge_straight_alpha;
`;

export const CORNER_FRAGMENT = `
vec2 forge_point = cogl_tex_coord_in[0].xy * forge_size + forge_origin;
vec2 forge_half = (forge_bounds.zw - forge_bounds.xy) * 0.5;
vec2 forge_center = (forge_bounds.zw + forge_bounds.xy) * 0.5;
vec2 forge_delta = abs(forge_point - forge_center) - forge_half + vec2(forge_radius);
float forge_distance = length(max(forge_delta, vec2(0.0))) +
    min(max(forge_delta.x, forge_delta.y), 0.0) - forge_radius;
float forge_aa = 0.5 * forge_pixel_step;
float forge_coverage = 1.0 - smoothstep(-forge_aa, forge_aa, forge_distance);

// Cap coverage instead of multiplying alpha twice at native rounded edges.
// Keep premultiplied RGB proportional to the remaining alpha, including zero.
float forge_input_alpha = cogl_color_out.a;
float forge_opacity = 1.0;
if (forge_coverage > 0.0 && forge_coverage < 1.0) {
    vec2 forge_gradient = max(forge_delta, vec2(0.0));
    vec2 forge_inward = sign(forge_point - forge_center) * forge_gradient /
        max(length(forge_gradient), 0.00001);
    vec2 forge_inner_point = forge_point - forge_inward *
        (max(forge_distance, 0.0) + forge_aa + 1.5 * forge_pixel_step);
    forge_opacity = texture2D(cogl_sampler0,
        (forge_inner_point - forge_origin) / forge_size).a * cogl_color_in.a;
}
float forge_alpha = min(forge_input_alpha, forge_coverage * forge_opacity);
cogl_color_out *= forge_input_alpha > 0.0 ? forge_alpha / forge_input_alpha : 0.0;

// Move the existing shadow profile from the rectangular edge onto the rounded
// edge. Never sample frame contents, nor let texture edge clamping copy opaque
// titlebar pixels into a transparent corner on a window without a shadow buffer.
if (forge_coverage < 1.0) {
    vec2 forge_arc = clamp(forge_point, forge_bounds.xy + vec2(forge_radius),
        forge_bounds.zw - vec2(forge_radius));
    vec2 forge_vector = forge_point - forge_arc;
    float forge_length = length(forge_vector);
    if (forge_length > 0.0) {
        vec2 forge_normal = forge_vector / forge_length;
        vec2 forge_side = mix(forge_bounds.xy, forge_bounds.zw,
            step(vec2(0.0), forge_normal));
        vec2 forge_reach = abs(forge_side - forge_arc) /
            max(abs(forge_normal), vec2(0.00001));
        float forge_edge = min(forge_reach.x, forge_reach.y);
        float forge_outset = max(forge_distance, 1.5 * forge_pixel_step) /
            max(abs(forge_normal.x), abs(forge_normal.y));
        vec2 forge_shadow_point = forge_arc + forge_normal * (forge_edge + forge_outset);
        vec2 forge_shadow_uv = (forge_shadow_point - forge_origin) / forge_size;
        vec2 forge_texel_margin = vec2(0.5 * forge_pixel_step) / forge_size;
        if (all(greaterThanEqual(forge_shadow_uv, forge_texel_margin)) &&
            all(lessThanEqual(forge_shadow_uv, vec2(1.0) - forge_texel_margin))) {
            vec4 forge_shadow = texture2D(cogl_sampler0, forge_shadow_uv) * cogl_color_in;
            cogl_color_out += forge_shadow * (1.0 - forge_coverage) *
                (1.0 - cogl_color_out.a);
        }
    }
}
// Old Shell.GLSLEffect pipelines expect straight RGB. Newer offscreen
// pipelines use premultiplied blending; convert only for the legacy fallback.
if (forge_straight_alpha > 0.5 && cogl_color_out.a > 0.0)
    cogl_color_out.rgb /= cogl_color_out.a;
`;
