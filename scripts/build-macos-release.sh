#!/usr/bin/env bash
# Builds the signed + notarized macOS dmgs for fwai_app (both architectures).
#
#   ./scripts/build-macos-release.sh                 # arm64 + x64
#   ./scripts/build-macos-release.sh aarch64         # one target only
#
# Signing/notarization is what keeps Gatekeeper quiet: an ad-hoc signed dmg
# ("signingIdentity": "-") makes every user hit "cannot verify the developer".
# Tauri runs the whole chain itself — codesign with the Developer ID, upload to
# Apple's notary service, then staple the ticket into the .app — as soon as the
# right env vars are present, which is all this script sets up.
#
# It runs in two modes, so CI and a laptop share one code path:
#
#   local  — the Developer ID cert lives in the login keychain and the
#            app-specific password in a keychain item (default `fwai-notary`).
#            Both are looked up here. One-time setup in docs/release.md.
#   CI     — APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD and
#            APPLE_PASSWORD come from repository secrets, and Tauri imports the
#            cert into a throwaway keychain itself. Nothing to preinstall.
#
# APPLE_ID and APPLE_TEAM_ID are required either way and are never hardcoded —
# the Apple ID is a personal mailbox and this repo is public.
set -euo pipefail

: "${APPLE_ID:?set APPLE_ID to the Apple account used for notarization (see docs/release.md)}"
: "${APPLE_TEAM_ID:?set APPLE_TEAM_ID to your Developer Program team id (see docs/release.md)}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-fwai-notary}"
# Shipped binaries point at prod; override to retarget a test build.
export VITE_GATEWAY_URL="${VITE_GATEWAY_URL:-https://api.fwai.space}"

cd "$(dirname "$0")/.."

if [[ -n "${APPLE_CERTIFICATE:-}" ]]; then
  # CI: the bundler imports the .p12 into a temporary keychain and reads the
  # identity back off the certificate, so APPLE_SIGNING_IDENTITY must stay
  # unset — setting it to something that doesn't match aborts the build.
  : "${APPLE_CERTIFICATE_PASSWORD:?APPLE_CERTIFICATE is set but APPLE_CERTIFICATE_PASSWORD is not}"
  echo "signing with the certificate from APPLE_CERTIFICATE"
else
  identity="$(security find-identity -v -p codesigning |
    sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)"
  if [[ -z "$identity" ]]; then
    echo "no Developer ID Application identity in the keychain — see docs/release.md" >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY="$identity"
  echo "signing as: ${identity}"
fi

if [[ -z "${APPLE_PASSWORD:-}" ]]; then
  # -w with no value would silently store an EMPTY password, which fails
  # notarization with a confusing 401; check the length rather than presence.
  APPLE_PASSWORD="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$APPLE_ID" -w 2>/dev/null || true)"
  if [[ ${#APPLE_PASSWORD} -lt 10 ]]; then
    echo "no usable app-specific password in keychain item '$KEYCHAIN_SERVICE' — see docs/release.md" >&2
    exit 1
  fi
fi

export APPLE_ID APPLE_TEAM_ID APPLE_PASSWORD

targets=("aarch64-apple-darwin" "x86_64-apple-darwin")
if [[ $# -gt 0 ]]; then
  targets=()
  for arg in "$@"; do
    case "$arg" in
      aarch64|arm64|aarch64-apple-darwin) targets+=("aarch64-apple-darwin") ;;
      x64|x86_64|x86_64-apple-darwin) targets+=("x86_64-apple-darwin") ;;
      *) echo "unknown target: $arg (use aarch64 or x64)" >&2; exit 1 ;;
    esac
  done
fi

version="$(node -p "require('./package.json').version")"
echo "building fwai_app v${version}"

for target in "${targets[@]}"; do
  echo "── ${target} (notarization adds a few minutes) ─────────────────────"
  pnpm tauri build --target "$target"
done

# Tauri notarizes and staples the .app, then builds the dmg around it and signs
# it — but never notarizes the dmg itself. Users download the DMG, so Gatekeeper
# checks that container on mount; leaving it unnotarized still shows a warning
# even though the app inside is clean. Submit each dmg separately and staple it.
for target in "${targets[@]}"; do
  for f in src-tauri/target/${target}/release/bundle/dmg/fwai_app_${version}*.dmg; do
    [[ -e "$f" ]] || continue
    if xcrun stapler validate "$f" >/dev/null 2>&1; then continue; fi
    echo "── notarizing $(basename "$f")"
    xcrun notarytool submit "$f" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" --wait --timeout 30m
    xcrun stapler staple "$f"
  done
done

# Verify what we are about to ship: Gatekeeper must report the dmg as notarized,
# and the ticket must be stapled so first launch works offline.
status=0
for target in "${targets[@]}"; do
  dmg="src-tauri/target/${target}/release/bundle/dmg/fwai_app_${version}"*.dmg
  for f in $dmg; do
    echo "── verifying $(basename "$f")"
    if spctl -a -t open -vv --context context:primary-signature "$f" 2>&1 | grep -q "source=Notarized Developer ID"; then
      echo "   gatekeeper: notarized ✓"
    else
      echo "   gatekeeper: NOT notarized ✗" >&2
      status=1
    fi
    if xcrun stapler validate "$f" >/dev/null 2>&1; then
      echo "   staple: ok ✓"
    else
      echo "   staple: missing ✗" >&2
      status=1
    fi
    echo "   $f"
  done
done
exit "$status"
