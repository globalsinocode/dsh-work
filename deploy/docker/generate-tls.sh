#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
tls_dir="${root}/deploy/docker/tls"
mkdir -p "${tls_dir}"
openssl req -x509 -nodes -days 825 -newkey rsa:2048 \
  -keyout "${tls_dir}/server.key" \
  -out "${tls_dir}/server.crt" \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1"
chmod 600 "${tls_dir}/server.key"
echo "Wrote ${tls_dir}/server.crt and server.key"
