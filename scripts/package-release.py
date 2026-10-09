#!/usr/bin/env python3
"""Package a make build output as a GNOME extension ZIP and a Debian package."""

import argparse
import gzip
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def package(build_dir, output_dir, version):
    if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)*)?", version):
        raise ValueError("Version must be MAJOR.MINOR.PATCH, optionally with -rc.1 or similar")
    version_name = version.replace("-", " ")
    if len(version_name) > 16:
        raise ValueError("GNOME version-name must be at most 16 characters")
    for name in ("metadata.json", "extension.js", "prefs.js", "schemas/gschemas.compiled", "LICENSE"):
        if not (build_dir / name).is_file():
            raise ValueError(f"Missing {name}; run make build first")
    metadata = json.loads((build_dir / "metadata.json").read_text())
    uuid = metadata["uuid"]
    if not re.fullmatch(r"[a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+", uuid):
        raise ValueError("Invalid extension UUID")
    metadata["version-name"] = version_name
    shells = sorted(int(value) for value in metadata["shell-version"])
    if shells != list(range(shells[0], shells[-1] + 1)):
        raise ValueError("Debian dependency range requires contiguous GNOME Shell versions")
    output_dir.mkdir(parents=True, exist_ok=True)
    deb_version = version.replace("-", "~", 1)
    zip_path = output_dir / f"{uuid}-{version}.zip"
    release_name = f"gnome-shell-extension-{uuid.split('@', 1)[0]}-tiagosantosvdl"
    deb_path = output_dir / f"{release_name}_{deb_version}_all.deb"
    with tempfile.TemporaryDirectory(prefix="forge-package-") as temporary:
        root = Path(temporary)
        extension = root / "usr/share/gnome-shell/extensions" / uuid
        shutil.copytree(build_dir, extension)
        (extension / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
        # Source checkout permissions must not determine installed file permissions.
        for path in [root, *root.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        with ZipFile(zip_path, "w", ZIP_DEFLATED) as archive:
            for path in sorted(extension.rglob("*")):
                if path.is_file():
                    archive.write(path, path.relative_to(extension))
        docs = root / "usr/share/doc/gnome-shell-extension-forge"
        docs.mkdir(parents=True)
        shutil.copyfile(extension / "LICENSE", docs / "copyright")
        (docs / "changelog.gz").write_bytes(gzip.compress(
            f"Forge {version}\n\nRelease notes: https://github.com/tiagosantosvdl/forge/releases/tag/v{version}\n".encode(),
            mtime=0,
        ))
        installed_size = sum((path.stat().st_size + 1023) // 1024 for path in root.rglob("*") if path.is_file())
        control = root / "DEBIAN"
        control.mkdir()
        (control / "control").write_text(
            "Package: gnome-shell-extension-forge\n"
            f"Version: {deb_version}\n"
            "Section: gnome\nPriority: optional\nArchitecture: all\n"
            "Maintainer: Tiago Santos <tiagosantosvdl@users.noreply.github.com>\n"
            f"Installed-Size: {installed_size}\n"
            f"Depends: gnome-shell (>= {shells[0]}~), gnome-shell (<< {shells[-1] + 1}~), gir1.2-adw-1\n"
            "Homepage: https://github.com/tiagosantosvdl/forge\n"
            "Description: Forge tiling window manager for GNOME Shell\n"
            " Remember layouts across sessions and display changes, with keyboard\n"
            " navigation, floating windows, and tabbed and stacked groups.\n"
        )
        for path in [root, *root.rglob("*")]:
            path.chmod(0o755 if path.is_dir() else 0o644)
        subprocess.run(["dpkg-deb", "--root-owner-group", "--build", str(root), str(deb_path)], check=True)
    checksum_path = output_dir / "SHA256SUMS"
    checksum_path.write_text("".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n"
        for path in (zip_path, deb_path)
    ))
    for path in (zip_path, deb_path, checksum_path):
        print(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--build-dir", type=Path, default=Path("temp"))
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    parser.add_argument("--version", default=json.loads(Path("package.json").read_text())["version"])
    args = parser.parse_args()
    try:
        package(args.build_dir, args.output_dir, args.version)
    except ValueError as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
