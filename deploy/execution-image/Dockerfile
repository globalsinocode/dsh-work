# Execution image for per-Attempt execution containers (docs/design/execution-isolation-plan.md 4.6, 2b-1).
# Every input is pinned: the base image by digest, Debian packages by a snapshot.debian.org timestamp,
# Python wheels by hash, ripgrep by the npm integrity recorded in DSH's lockfile. The container runs
# with a read-only root, no network and an arbitrary non-root uid:gid, so nothing here may rely on
# writing outside $HOME or /tmp at run time. Build and publish: .github/workflows/execution-image.yml.
FROM python:3.12-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

# The snapshot the base image itself was built from (see its /etc/apt/sources.list.d/debian.sources).
ARG DEBIAN_SNAPSHOT=20261020T213255Z

RUN set -eux; \
    printf '%s\n' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie trixie-updates' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      '' \
      'Types: deb' \
      "URIs: https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}" \
      'Suites: trixie-security' \
      'Components: main' \
      'Signed-By: /usr/share/keyrings/debian-archive-keyring.pgp' \
      > /etc/apt/sources.list.d/debian.sources; \
    printf '%s\n' \
      'Acquire::Check-Valid-Until "false";' \
      'Acquire::Retries "10";' \
      'APT::Install-Recommends "false";' \
      > /etc/apt/apt.conf.d/99dsh-work-snapshot; \
    packages='fontconfig fonts-liberation2 fonts-noto-cjk libreoffice-calc-nogui libreoffice-impress-nogui libreoffice-writer-nogui pandoc poppler-utils'; \
    # snapshot.debian.org resets connections under load and apt's own retries are immediate, so
    # each fetch is retried with backoff. Separate loops: the base image's docker-clean hook empties
    # the package cache on every `apt-get update`, while a repeated download-only run keeps what it
    # already has. apt still verifies every package against the signed snapshot index.
    for attempt in 1 2 3 4 5; do \
      if apt-get update; then break; fi; \
      [ "${attempt}" -lt 5 ] || exit 1; \
      sleep $((attempt * 20)); \
    done; \
    for attempt in 1 2 3 4 5; do \
      if apt-get install -y --download-only ${packages}; then break; fi; \
      [ "${attempt}" -lt 5 ] || exit 1; \
      sleep $((attempt * 20)); \
    done; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${packages}; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb; \
    # Build the font cache now: at run time the root is read-only and HOME is a small tmpfs.
    fc-cache -f

# Han characters without a declared East Asian language render with the Simplified Chinese variant.
COPY fontconfig-cjk-sc.conf /etc/fonts/conf.d/64-dsh-work-cjk-sc.conf

# ripgrep 15.0.0, the same build DSH uses for glob/grep (@vscode/ripgrep 1.18.0).
COPY install-ripgrep.py /tmp/install-ripgrep.py
ARG TARGETARCH
RUN python -I /tmp/install-ripgrep.py "${TARGETARCH}" /usr/local/bin/rg && rm /tmp/install-ripgrep.py

COPY requirements.lock /tmp/requirements.lock
RUN PIP_DISABLE_PIP_VERSION_CHECK=1 pip install --no-cache-dir --no-deps --only-binary=:all: \
      --require-hashes -r /tmp/requirements.lock \
    && rm /tmp/requirements.lock

# LibreOffice cannot create its default profile for a uid without a passwd entry (plan 3.5);
# the wrapper keeps the profile under the per-container HOME. /usr/local/bin precedes /usr/bin.
COPY --chmod=0755 soffice /usr/local/bin/soffice
RUN ln -s soffice /usr/local/bin/libreoffice

LABEL org.opencontainers.image.title="dsh-work execution" \
      org.opencontainers.image.description="Toolchain for dsh-work per-Attempt execution containers" \
      ai.dsh-work.execution.toolchain="bash rg soffice pdftoppm pdftotext pandoc python3 pandas openpyxl python-docx python-pptx"

# The platform always sets the user, workdir and entrypoint; these defaults only serve manual checks.
ENV HOME=/home/exec LANG=C.UTF-8
USER 65534:65534
WORKDIR /tmp
