"""Exercise actual GTK preferences with a private display and in-memory settings."""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("gjs") and shutil.which("gtk4-broadwayd"), "Native GTK test tools not installed")
class ShortcutPreferencesTest(unittest.TestCase):
    def test_native_preferences(self):
        with tempfile.TemporaryDirectory(prefix="forge-shortcuts-") as temporary:
            root = Path(temporary)
            for name in (
                "lib/prefs/keyboard.js", "lib/prefs/widgets.js",
                "lib/shared/shortcut-conflicts.js", "lib/shared/shortcut-settings.js",
                "lib/shared/logger.js", "lib/shared/settings.js",
                "schemas/org.gnome.shell.extensions.forge.gschema.xml",
                "tests/shortcut-preferences.mjs",
            ):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                # GNOME's gettext wrapper requires a registered extension. Replace
                # only translation lookup; the preferences and GTK code are unchanged.
                target.write_text((ROOT / name).read_text().replace(
                    'import { gettext as _ } from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";',
                    'const _ = (text) => text;',
                ))
            subprocess.run(["glib-compile-schemas", "--strict", str(root / "schemas")], check=True)
            runtime = root / "runtime"
            runtime.mkdir(mode=0o700)
            env = dict(os.environ, GSETTINGS_BACKEND="memory", GDK_BACKEND="broadway",
                       BROADWAY_DISPLAY=":0", XDG_RUNTIME_DIR=str(runtime))
            server = subprocess.Popen(
                ["gtk4-broadwayd", f"--unixsocket={root / 'http.socket'}", ":0"],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            try:
                deadline = time.monotonic() + 5
                while not (runtime / "broadway1.socket").exists():
                    if server.poll() is not None:
                        self.fail(f"GTK display failed: {server.stdout.read()}")
                    if time.monotonic() > deadline:
                        self.fail("GTK display did not start")
                    time.sleep(0.05)
                result = subprocess.run(
                    ["gjs", "-m", str(root / "tests/shortcut-preferences.mjs")],
                    env=env, text=True, capture_output=True, timeout=30,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertNotIn("JS ERROR", result.stderr)
                self.assertIn("Native GTK/GSettings checks passed", result.stdout)
            finally:
                server.terminate()
                server.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
