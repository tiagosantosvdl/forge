"""Exercise pause/restore with real Gio.Settings and an isolated memory backend."""

import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("gjs") and shutil.which("glib-compile-schemas"), "GJS not installed")
class TilingAssistantTest(unittest.TestCase):
    def test_native_settings(self):
        with tempfile.TemporaryDirectory(prefix="forge-tiling-assistant-") as temporary:
            root = Path(temporary)
            schemas = root / "schemas"
            schemas.mkdir()
            shutil.copy(ROOT / "schemas/org.gnome.shell.extensions.forge.gschema.xml", schemas)
            (schemas / "assistant.gschema.xml").write_text('''<schemalist>
              <schema id="org.gnome.shell.extensions.tiling-assistant" path="/org/gnome/shell/extensions/tiling-assistant/">
                <key name="enable-tiling-popup" type="b"><default>true</default></key>
                <key name="focus-hint" type="i"><default>2</default></key>
                <key name="tile-left-half" type="as"><default>['&lt;Super&gt;Left']</default></key>
                <key name="favorite-layouts" type="as"><default>['custom']</default></key>
              </schema>
            </schemalist>''')
            subprocess.run(["glib-compile-schemas", "--strict", str(schemas)], check=True)
            source = (ROOT / "lib/extension/tiling-assistant.js").read_text()
            source = source.replace(
                'import * as Main from "resource:///org/gnome/shell/ui/main.js";',
                "const Main = globalThis.mockMain;",
            ).replace(
                'import { ExtensionState } from "resource:///org/gnome/shell/misc/extensionUtils.js";',
                "const ExtensionState = { ACTIVE: 1 };",
            ).replace(
                'import { Logger } from "../shared/logger.js";',
                "const Logger = { warn() {}, error(message) { throw new Error(message); } };",
            )
            (root / "assistant.mjs").write_text(source)
            shutil.copy(ROOT / "tests/tiling-assistant.mjs", root)
            result = subprocess.run(
                ["gjs", "-m", str(root / "tiling-assistant.mjs")],
                env=dict(os.environ, GSETTINGS_BACKEND="memory", GSETTINGS_SCHEMA_DIR=str(schemas)),
                text=True, capture_output=True, timeout=30,
            )
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertNotIn("JS ERROR", result.stderr)
            self.assertIn("Native Tiling Assistant checks passed", result.stdout)
