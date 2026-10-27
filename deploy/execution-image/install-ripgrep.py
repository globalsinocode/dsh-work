"""Installs the ripgrep binary DSH itself uses, verified against DSH's pnpm lockfile integrity.

DSH's glob/grep pass `@vscode/ripgrep`'s `rgPath`, which the platform maps to `rg` inside the
execution container (plan 4.1), so the container must run the same ripgrep release.

Usage: python -I install-ripgrep.py <docker TARGETARCH> <destination>
"""

import base64
import hashlib
import io
import os
import sys
import tarfile
import urllib.request

VERSION = "1.18.0"  # @vscode/ripgrep in DSH 0.1.2-rc.1, ships ripgrep 15.0.0
PACKAGES = {
    # Integrity values copied from DSH's pnpm-lock.yaml (`resolution.integrity`).
    "arm64": ("linux-arm64", "sha512-lQ/5zTG++U0E3IhVgS4EPTTn/U4okncaRMM5GOFfOYZywS4nuD31GhkHbNYlDk5CuDC68+hYJ0/eQeyCKJDA+g=="),
    "amd64": ("linux-x64", "sha512-mQ3bVrUpnD2vs7QT0vX90Lt0cnUq467uFtEktIdsJJmW296RoSULRGqWgzG1AKxyBpNDD6l4ZO4qKf6SgyC23Q=="),
}
MAX_TARBALL_BYTES = 32 * 1024 * 1024


def main(arch: str, destination: str) -> None:
    if arch not in PACKAGES:
        sys.exit(f"unsupported architecture: {arch!r}")
    suffix, integrity = PACKAGES[arch]
    url = f"https://registry.npmjs.org/@vscode/ripgrep-{suffix}/-/ripgrep-{suffix}-{VERSION}.tgz"
    with urllib.request.urlopen(url, timeout=120) as response:
        tarball = response.read(MAX_TARBALL_BYTES + 1)
    if len(tarball) > MAX_TARBALL_BYTES:
        sys.exit("ripgrep tarball exceeds the size limit")
    algorithm, expected = integrity.split("-", 1)
    actual = base64.b64encode(hashlib.new(algorithm, tarball).digest()).decode()
    if actual != expected:
        sys.exit(f"ripgrep tarball integrity mismatch: {actual}")
    with tarfile.open(fileobj=io.BytesIO(tarball), mode="r:gz") as archive:
        member = archive.getmember("package/bin/rg")
        if not member.isfile():
            sys.exit("package/bin/rg is not a regular file")
        binary = archive.extractfile(member).read()
    with open(destination, "wb") as file:
        file.write(binary)
    os.chmod(destination, 0o755)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
