"""Exercise GTK CSS and real Gio configuration writes in a temporary directory."""

import os
from pathlib import Path
import shutil
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[1]
SHELL_LIB = Path("/usr/lib/gnome-shell")
MUTTER_LIBS = sorted(Path("/usr/lib").glob("*/mutter-*"))


@unittest.skipUnless(shutil.which("gjs") and MUTTER_LIBS and list(SHELL_LIB.glob("Shell-*.typelib")),
                     "GNOME Shell introspection libraries not installed")
class WindowCornersTest(unittest.TestCase):
    def test_native_configuration(self):
        libraries = [str(SHELL_LIB), str(MUTTER_LIBS[-1])]
        env = dict(os.environ)
        for key in ("GI_TYPELIB_PATH", "LD_LIBRARY_PATH"):
            env[key] = ":".join(libraries + ([env[key]] if key in env else []))
        result = subprocess.run(
            ["gjs", "-m", str(ROOT / "tests/window-corners.mjs")],
            env=env, text=True, capture_output=True, timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("JS ERROR", result.stderr)
        self.assertIn("Native window corner configuration checks passed", result.stdout)


if __name__ == "__main__":
    unittest.main()
