"""Render the production fragment shader with surfaceless EGL, never live Shell."""

import ctypes as C
import ctypes.util
import os
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class CornerShaderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        egl_name, gl_name = C.util.find_library("EGL"), C.util.find_library("GLESv2")
        if not egl_name or not gl_name:
            raise unittest.SkipTest("EGL/GLES rendering libraries unavailable")
        os.environ.setdefault("LIBGL_ALWAYS_SOFTWARE", "1")
        cls.egl, cls.gl = C.CDLL(egl_name), C.CDLL(gl_name)

        def bind(lib, name, result, *args):
            fn = getattr(lib, name)
            fn.restype, fn.argtypes = result, args
            return fn

        cls.bind = staticmethod(bind)
        p, i, u, f = C.c_void_p, C.c_int, C.c_uint, C.c_float
        cls.display = bind(cls.egl, "eglGetPlatformDisplay", p, u, p, p)(0x31DD, None, None)
        if not bind(cls.egl, "eglInitialize", u, p, p, p)(cls.display, None, None):
            raise unittest.SkipTest("Surfaceless EGL unavailable")
        bind(cls.egl, "eglBindAPI", u, u)(0x30A0)
        attrs = (i * 13)(0x3033, 1, 0x3040, 4, 0x3024, 8, 0x3023, 8, 0x3022, 8, 0x3021, 8, 0x3038)
        config, count = p(), i()
        bind(cls.egl, "eglChooseConfig", u, p, p, p, i, p)(cls.display, attrs, C.byref(config), 1, C.byref(count))
        if not count.value:
            bind(cls.egl, "eglTerminate", u, p)(cls.display)
            raise unittest.SkipTest("No EGL RGBA pbuffer configuration")
        cls.context = bind(cls.egl, "eglCreateContext", p, p, p, p, p)(cls.display, config, None, (i * 3)(0x3098, 2, 0x3038))
        cls.surface = bind(cls.egl, "eglCreatePbufferSurface", p, p, p, p)(cls.display, config, (i * 5)(0x3057, 64, 0x3056, 64, 0x3038))
        if not bind(cls.egl, "eglMakeCurrent", u, p, p, p, p)(cls.display, cls.surface, cls.surface, cls.context):
            raise RuntimeError("Cannot activate isolated EGL context")

        source = (ROOT / "lib/shared/window-corner-shader.js").read_text()
        declarations = re.search(r"CORNER_DECLARATIONS = `([\s\S]*?)`;", source)[1]
        fragment = re.search(r"CORNER_FRAGMENT = `([\s\S]*?)`;", source)[1]
        vertex = "attribute vec2 position; varying vec4 cogl_tex_coord_in[1]; void main(){ gl_Position=vec4(position,0.,1.); cogl_tex_coord_in[0]=vec4((position+1.)*.5,0.,1.); }"
        shader = "precision highp float; uniform sampler2D cogl_sampler0; uniform vec4 cogl_color_in; varying vec4 cogl_tex_coord_in[1];\n" + declarations + "\nvoid main(){vec4 cogl_color_out=texture2D(cogl_sampler0,cogl_tex_coord_in[0].xy)*cogl_color_in;\n" + fragment + "\ngl_FragColor=cogl_color_out;}"

        def compile_shader(kind, text):
            handle = bind(cls.gl, "glCreateShader", u, u)(kind)
            encoded = C.c_char_p(text.encode())
            bind(cls.gl, "glShaderSource", None, u, i, p, p)(handle, 1, C.byref(encoded), None)
            bind(cls.gl, "glCompileShader", None, u)(handle)
            status = i()
            bind(cls.gl, "glGetShaderiv", None, u, u, p)(handle, 0x8B81, C.byref(status))
            if not status.value:
                log = C.create_string_buffer(4096)
                bind(cls.gl, "glGetShaderInfoLog", None, u, i, p, p)(handle, len(log), None, log)
                raise AssertionError(log.value.decode())
            return handle

        cls.program = bind(cls.gl, "glCreateProgram", u)()
        for kind, text in ((0x8B31, vertex), (0x8B30, shader)):
            handle = compile_shader(kind, text)
            bind(cls.gl, "glAttachShader", None, u, u)(cls.program, handle)
            bind(cls.gl, "glDeleteShader", None, u)(handle)
        bind(cls.gl, "glBindAttribLocation", None, u, u, C.c_char_p)(cls.program, 0, b"position")
        bind(cls.gl, "glLinkProgram", None, u)(cls.program)
        linked = i()
        bind(cls.gl, "glGetProgramiv", None, u, u, p)(cls.program, 0x8B82, C.byref(linked))
        if not linked.value:
            raise AssertionError("Production shader failed to link")
        bind(cls.gl, "glUseProgram", None, u)(cls.program)
        bind(cls.gl, "glViewport", None, i, i, i, i)(0, 0, 64, 64)
        vertices = (f * 12)(-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1)
        buffer = u()
        bind(cls.gl, "glGenBuffers", None, i, p)(1, C.byref(buffer))
        bind(cls.gl, "glBindBuffer", None, u, u)(0x8892, buffer)
        bind(cls.gl, "glBufferData", None, u, C.c_ssize_t, p, u)(0x8892, C.sizeof(vertices), vertices, 0x88E4)
        bind(cls.gl, "glVertexAttribPointer", None, u, i, u, u, i, p)(0, 2, 0x1406, 0, 0, None)
        bind(cls.gl, "glEnableVertexAttribArray", None, u)(0)
        texture = u()
        bind(cls.gl, "glGenTextures", None, i, p)(1, C.byref(texture))
        bind(cls.gl, "glBindTexture", None, u, u)(0x0DE1, texture)
        for key, value in ((0x2801, 0x2601), (0x2800, 0x2601), (0x2802, 0x812F), (0x2803, 0x812F)):
            bind(cls.gl, "glTexParameteri", None, u, u, i)(0x0DE1, key, value)

    @classmethod
    def tearDownClass(cls):
        p, u = C.c_void_p, C.c_uint
        cls.bind(cls.egl, "eglMakeCurrent", u, p, p, p, p)(cls.display, None, None, None)
        cls.bind(cls.egl, "eglDestroySurface", u, p, p)(cls.display, cls.surface)
        cls.bind(cls.egl, "eglDestroyContext", u, p, p)(cls.display, cls.context)
        cls.bind(cls.egl, "eglTerminate", u, p)(cls.display)

    def render(self, pixel, bounds=(16.5, 16.5, 48.5, 48.5), origin=(0, 0), scale=1, straight=False, opacity=1):
        p, i, u, f = C.c_void_p, C.c_int, C.c_uint, C.c_float
        pixels = bytes(channel for y in range(64) for x in range(64) for channel in pixel(x+.5, y+.5))
        data = (C.c_ubyte * len(pixels)).from_buffer_copy(pixels)
        self.bind(self.gl, "glTexImage2D", None, u, i, i, i, i, i, u, u, p)(0x0DE1, 0, 0x1908, 64, 64, 0, 0x1908, 0x1401, data)
        values = {"forge_size": (64, 64), "forge_origin": origin, "forge_bounds": bounds, "forge_radius": (12,), "forge_pixel_step": (1/scale,), "forge_straight_alpha": (int(straight),), "cogl_color_in": (opacity,)*4}
        for name, value in values.items():
            location = self.bind(self.gl, "glGetUniformLocation", i, u, C.c_char_p)(self.program, name.encode())
            self.assertGreaterEqual(location, 0, name)
            self.bind(self.gl, f"glUniform{len(value)}f", None, i, *([f]*len(value)))(location, *value)
        self.bind(self.gl, "glClearColor", None, f, f, f, f)(0, 0, 0, 0)
        self.bind(self.gl, "glClear", None, u)(0x4000)
        self.bind(self.gl, "glEnable" if straight else "glDisable", None, u)(0x0BE2)
        if straight:
            self.bind(self.gl, "glBlendFuncSeparate", None, u, u, u, u)(0x0302, 0x0303, 1, 0x0303)
        self.bind(self.gl, "glDrawArrays", None, u, i, i)(4, 0, 6)
        output = (C.c_ubyte * (64*64*4))()
        self.bind(self.gl, "glReadPixels", None, i, i, i, i, u, u, p)(0, 0, 64, 64, 0x1908, 0x1401, output)
        self.assertEqual(self.bind(self.gl, "glGetError", u)(), 0)
        return lambda x, y: tuple(output[(y*64+x)*4:(y*64+x)*4+4])

    def test_cut_out_tips_have_zero_rgba_without_a_shadow(self):
        # Include faint colored leftovers, not just opaque content, at the tip.
        def input_pixel(x, y):
            if (16.5<=x<20 and 16.5<=y<20) or (x==15.5 and y==17.5):
                return (8, 5, 3, 16)
            return (160, 80, 40, 255) if 16.5<=x<=48.5 and 16.5<=y<=48.5 else (0, 0, 0, 0)
        result = self.render(input_pixel)
        self.assertEqual(result(16, 16), (0, 0, 0, 0))
        self.assertEqual(result(15, 17), (0, 0, 0, 0))
        for point in ((48, 16), (16, 48), (48, 48)):
            self.assertEqual(result(*point), (0, 0, 0, 0))
        self.assertEqual(result(32, 32), (160, 80, 40, 255))

    def test_native_half_covered_edge_is_not_smoothed_twice(self):
        def input_pixel(x, y):
            if x==16.5 and 28<y<38: return (64, 32, 16, 128)
            return (128, 64, 32, 255) if 16.5<x<=48.5 and 16.5<=y<=48.5 else (0, 0, 0, 0)
        self.assertEqual(self.render(input_pixel)(16, 32), (64, 32, 16, 128))

    def test_translucent_windows_keep_their_opacity_and_edge_coverage(self):
        def translucent(x, y):
            return (64, 32, 16, 128) if 16.5<=x<=48.5 and 16.5<=y<=48.5 else (0, 0, 0, 0)
        result = self.render(translucent)
        self.assertEqual(result(32, 32), (64, 32, 16, 128))
        self.assertEqual(result(16, 32), (32, 16, 8, 64))

        def already_smoothed(x, y):
            return (32, 16, 8, 64) if x==16.5 and 28<y<38 else translucent(x, y)
        self.assertEqual(self.render(already_smoothed)(16, 32), (32, 16, 8, 64))

    def test_shadow_is_relocated_without_titlebar_color_or_frame_seam(self):
        def input_pixel(x, y):
            return (220, 40, 20, 255) if 16.5<=x<=48.5 and 16.5<=y<=48.5 else (2, 3, 4, 32)
        left = self.render(input_pixel, origin=(-.1, 0))(16, 17)
        right = self.render(input_pixel, origin=(.1, 0))(16, 17)
        self.assertEqual(left, (2, 3, 4, 32))
        self.assertEqual(right, left)
        self.assertEqual(self.render(input_pixel)(10, 32), (2, 3, 4, 32))

    def test_no_texture_edge_clamping_leaks_opaque_pixels(self):
        result = self.render(lambda x, y: (160, 80, 40, 255), bounds=(0, 0, 64, 64))
        self.assertEqual(result(0, 0), (0, 0, 0, 0))

    def test_legacy_straight_alpha_blending_preserves_edge_and_shadow_colors(self):
        def pixel(x, y):
            return (160, 80, 40, 255) if 16.5<=x<=48.5 and 16.5<=y<=48.5 else (2, 3, 4, 32)
        premultiplied = self.render(pixel)
        legacy = self.render(pixel, straight=True)
        for x, y in ((16, 16), (16, 32), (32, 32), (10, 32)):
            for a, b in zip(premultiplied(x, y), legacy(x, y)):
                self.assertLessEqual(abs(a-b), 1)

    def test_shadows_follow_actor_fades_without_lingering_corner_pixels(self):
        def pixel(x, y):
            return (160, 80, 40, 255) if 16.5<=x<=48.5 and 16.5<=y<=48.5 else (2, 3, 4, 32)
        transparent = self.render(pixel, opacity=0)
        faded = self.render(pixel, opacity=.5)
        self.assertEqual(faded(16, 16)[3], 16)
        self.assertEqual(faded(32, 32)[3], 128)
        for x, y in ((16, 16), (16, 32), (32, 32), (10, 32)):
            self.assertEqual(transparent(x, y), (0, 0, 0, 0))

    def test_smoothing_uses_one_physical_pixel_at_resource_scale_two(self):
        pixel = lambda x, y: (160, 80, 40, 255) if 16<=x<=49 and 16<=y<=49 else (0, 0, 0, 0)
        # At 0.25 logical units inside the edge, scale 2 should be fully covered.
        self.assertEqual(self.render(pixel, bounds=(16.25, 16.5, 48.5, 48.5), scale=2)(16, 32)[3], 255)
        self.assertLess(self.render(pixel, bounds=(16.25, 16.5, 48.5, 48.5), scale=1)(16, 32)[3], 255)
