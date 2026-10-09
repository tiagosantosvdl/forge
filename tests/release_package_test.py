"""Exercise real ZIP and Debian builds without installing into the running session."""

import hashlib
import importlib.util
import io
import json
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("package_release", ROOT / "scripts/package-release.py")
PACKAGER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PACKAGER)


class ReleasePackageTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.build = self.root / "build"
        self.output = self.root / "dist"
        self.build.mkdir()
        self.metadata = json.loads((ROOT / "metadata.json").read_text())
        (self.build / "metadata.json").write_text(json.dumps(self.metadata))
        for name in ("extension.js", "prefs.js", "LICENSE", "schemas/gschemas.compiled", "locale/nl/LC_MESSAGES/forge.mo"):
            path = self.build / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture\n")
            path.chmod(0o600)

    def test_installable_payload_and_checksums(self):
        PACKAGER.package(self.build, self.output, "22.51.1")
        deb = self.output / "gnome-shell-extension-forge-tiagosantosvdl_22.51.1_all.deb"
        fields = subprocess.check_output(["dpkg-deb", "--field", str(deb)], text=True)
        self.assertIn("Architecture: all\n", fields)
        self.assertIn("gnome-shell (>= 45~), gnome-shell (<< 52~)", fields)
        self.assertIn("Version: 22.51.1\n", fields)
        unpacked = self.root / "unpacked"
        subprocess.run(["dpkg-deb", "--extract", str(deb), str(unpacked)], check=True)
        installed = unpacked / "usr/share/gnome-shell/extensions" / self.metadata["uuid"]
        zip_path = self.output / f"{self.metadata['uuid']}-22.51.1.zip"
        self.assertEqual(
            {path.name for path in self.output.iterdir()},
            {zip_path.name, deb.name, "SHA256SUMS"},
        )
        with ZipFile(zip_path) as archive:
            self.assertIn("extension.js", archive.namelist())
            self.assertIn("schemas/gschemas.compiled", archive.namelist())
            metadata = json.loads(archive.read("metadata.json"))
            self.assertEqual(metadata["uuid"], "forge@tiagosantosvdl.github.com")
            self.assertEqual(metadata["version-name"], "22.51.1")
            for name in archive.namelist():
                self.assertEqual(archive.read(name), (installed / name).read_bytes())
        payload = subprocess.check_output(["dpkg-deb", "--fsys-tarfile", str(deb)])
        with tarfile.open(fileobj=io.BytesIO(payload)) as archive:
            for member in archive:
                self.assertEqual((member.uid, member.gid), (0, 0))
                self.assertEqual(member.mode, 0o755 if member.isdir() else 0o644)
        for line in (self.output / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ")
            self.assertEqual(digest, hashlib.sha256((self.output / name).read_bytes()).hexdigest())
        self.assertEqual(json.loads((self.build / "metadata.json").read_text()), self.metadata)

    def test_prerelease_sorts_before_stable(self):
        PACKAGER.package(self.build, self.output, "22.51.1-rc.1")
        deb = self.output / "gnome-shell-extension-forge-tiagosantosvdl_22.51.1~rc.1_all.deb"
        self.assertTrue(deb.is_file())
        self.assertTrue((self.output / f"{self.metadata['uuid']}-22.51.1-rc.1.zip").is_file())
        subprocess.run(["dpkg", "--compare-versions", "22.51.1~rc.1", "lt", "22.51.1"], check=True)

    def test_invalid_version_does_not_create_artifacts(self):
        for version in ("../escape", "v22.51.1", "22.51", "22.51.1+build", "22.51.1-verylongprerelease"):
            with self.subTest(version=version), self.assertRaises(ValueError):
                PACKAGER.package(self.build, self.output, version)
        self.assertFalse(self.output.exists())

    def test_missing_compiled_schema_fails(self):
        (self.build / "schemas/gschemas.compiled").unlink()
        with self.assertRaisesRegex(ValueError, "Missing schemas/gschemas.compiled"):
            PACKAGER.package(self.build, self.output, "22.51.1")


if __name__ == "__main__":
    unittest.main()
