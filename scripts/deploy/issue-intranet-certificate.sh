#!/usr/bin/env bash
# Issue a project-specific certificate containing every enabled IP and DNS SAN.
# Run only on the operator workstation that holds the offline root CA.

set -eo pipefail

ca_dir=''
output_dir=''
cert_days=365
force=0
server_ips=()
dns_names=()

usage() {
  printf '%s\n' \
    'Issue an intranet server certificate with one or more IP/DNS SANs.' \
    '' \
    'Usage: bash scripts/deploy/issue-intranet-certificate.sh --ca-dir ABSOLUTE_PATH (--ip PRIVATE_IPV4 | --dns LOWERCASE_NAME)... --output-dir ABSOLUTE_PATH [--days DAYS] [--force]'
}

fail() { printf 'issue-intranet-certificate: %s\n' "$1" >&2; exit 1; }

is_private_ipv4() {
  [[ "$1" != *$'\n'* && "$1" != *$'\r'* ]] || return 1
  awk -F. '
    NF != 4 { exit 1 }
    {
      for (i = 1; i <= 4; i++) {
        if ($i !~ /^[0-9]+$/ || $i < 0 || $i > 255) exit 1
      }
      if ($1 == 10) exit 0
      if ($1 == 172 && $2 >= 16 && $2 <= 31) exit 0
      if ($1 == 192 && $2 == 168) exit 0
      exit 1
    }
  ' <<<"$1"
}

is_valid_dns_name() {
  local name=$1 label old_ifs
  [[ ${#name} -le 253 && "${name}" != *[[:upper:]]* && "${name}" != .* && "${name}" != *. ]] \
    || return 1
  [[ "${name}" =~ ^[a-z0-9.-]+$ && "${name}" == *.* ]] || return 1
  old_ifs=${IFS}
  IFS='.' read -r -a labels <<<"${name}"
  IFS=${old_ifs}
  for label in "${labels[@]}"; do
    [[ ${#label} -ge 1 && ${#label} -le 63 ]] || return 1
    [[ "${label}" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || return 1
  done
}

contains_value() {
  local candidate=$1 value
  shift
  for value in "$@"; do
    [[ "${value}" != "${candidate}" ]] || return 0
  done
  return 1
}

while (($# > 0)); do
  case "$1" in
    --ca-dir) ca_dir=${2:?}; shift 2 ;;
    --ip) server_ips+=("${2:?}"); shift 2 ;;
    --dns) dns_names+=("${2:?}"); shift 2 ;;
    --output-dir) output_dir=${2:?}; shift 2 ;;
    --days) cert_days=${2:?}; shift 2 ;;
    --force) force=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; fail "unknown argument: $1" ;;
  esac
done

[[ -n "${ca_dir}" && -n "${output_dir}" ]] || fail '--ca-dir and --output-dir are required'
[[ "${ca_dir}" == /* && "${output_dir}" == /* && "${ca_dir}" != / && "${output_dir}" != / ]] \
  || fail '--ca-dir and --output-dir must be absolute non-root paths'
((${#server_ips[@]} + ${#dns_names[@]} > 0)) || fail 'at least one --ip or --dns SAN is required'
[[ "${cert_days}" =~ ^[1-9][0-9]*$ ]] || fail '--days must be a positive integer'
((cert_days >= 1 && cert_days <= 825)) || fail '--days must be between 1 and 825'
command -v openssl >/dev/null 2>&1 || fail 'openssl is required'

validated=()
for server_ip in "${server_ips[@]}"; do
  is_private_ipv4 "${server_ip}" || fail "--ip must be an RFC1918 private IPv4 address: ${server_ip}"
  contains_value "IP:${server_ip}" "${validated[@]}" && fail "duplicate SAN: IP:${server_ip}"
  validated+=("IP:${server_ip}")
done
for dns_name in "${dns_names[@]}"; do
  is_valid_dns_name "${dns_name}" || fail "--dns must be a lowercase, non-wildcard DNS name: ${dns_name}"
  contains_value "DNS:${dns_name}" "${validated[@]}" && fail "duplicate SAN: DNS:${dns_name}"
  validated+=("DNS:${dns_name}")
done

root_key="${ca_dir}/root-ca.key"
root_cert="${ca_dir}/root-ca.crt"
[[ -f "${root_key}" && -f "${root_cert}" ]] || fail "root-ca.key/root-ca.crt not found in ${ca_dir}"
mkdir -p "${output_dir}"
chmod 700 "${output_dir}"
for target in server.key server.crt root-ca.crt; do
  if [[ -e "${output_dir}/${target}" && "${force}" -ne 1 ]]; then
    fail "${output_dir}/${target} already exists (use --force to replace server material)"
  fi
done

umask 077
stage_dir=$(mktemp -d "${output_dir}/.issue.XXXXXX")
cleanup() { rm -rf "${stage_dir}"; }
trap cleanup EXIT
extensions_file="${stage_dir}/server-extensions.cnf"
{
  printf '%s\n' \
    '[server_certificate]' \
    'basicConstraints = critical, CA:false' \
    'keyUsage = critical, digitalSignature, keyEncipherment' \
    'extendedKeyUsage = serverAuth' \
    'subjectKeyIdentifier = hash' \
    'authorityKeyIdentifier = keyid,issuer' \
    'subjectAltName = @subject_alt_names' \
    '' \
    '[subject_alt_names]'
  san_index=1
  for server_ip in "${server_ips[@]}"; do
    printf 'IP.%d = %s\n' "${san_index}" "${server_ip}"
    san_index=$((san_index + 1))
  done
  san_index=1
  for dns_name in "${dns_names[@]}"; do
    printf 'DNS.%d = %s\n' "${san_index}" "${dns_name}"
    san_index=$((san_index + 1))
  done
} >"${extensions_file}"

if ((${#dns_names[@]} > 0)); then
  common_name=${dns_names[0]}
else
  common_name=${server_ips[0]}
fi
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "${stage_dir}/server.key"
openssl req -new -sha256 -key "${stage_dir}/server.key" \
  -subj "/O=Company Intranet/CN=${common_name}" -out "${stage_dir}/server.csr"
openssl x509 -req -sha256 -days "${cert_days}" \
  -in "${stage_dir}/server.csr" \
  -CA "${root_cert}" \
  -CAkey "${root_key}" \
  -CAcreateserial \
  -extfile "${extensions_file}" \
  -extensions server_certificate \
  -out "${stage_dir}/server.crt"

openssl verify -CAfile "${root_cert}" "${stage_dir}/server.crt" >/dev/null
# Read SANs as complete comma-separated entries. This also works with the
# LibreSSL shipped by macOS, without substring matches (e.g. .20 vs .200).
certificate_sans=$(openssl x509 -in "${stage_dir}/server.crt" -noout -text | awk '
  /X509v3 Subject Alternative Name:/ { in_sans = 1; next }
  in_sans && /X509v3|Signature Algorithm:/ { exit }
  in_sans { print }
' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
for server_ip in "${server_ips[@]}"; do
  grep -Fx -- "IP Address:${server_ip}" <<<"${certificate_sans}" >/dev/null \
    || fail "issued certificate does not contain IP SAN ${server_ip}"
done
for dns_name in "${dns_names[@]}"; do
  grep -Fx -- "DNS:${dns_name}" <<<"${certificate_sans}" >/dev/null \
    || fail "issued certificate does not contain DNS SAN ${dns_name}"
done

install -m 0600 "${stage_dir}/server.key" "${output_dir}/server.key"
install -m 0644 "${stage_dir}/server.crt" "${output_dir}/server.crt"
install -m 0644 "${root_cert}" "${output_dir}/root-ca.crt"
printf 'Issued intranet certificate for %s. Copy only server.key, server.crt, and root-ca.crt to the Mac mini.\n' "${validated[*]}"
printf 'Keep %s offline.\n' "${root_key}"
