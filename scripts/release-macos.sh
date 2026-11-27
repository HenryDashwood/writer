#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

identities=$(security find-identity -v -p codesigning)
if [[ -z "${APPLE_SIGNING_IDENTITY:-}" ]]; then
  matches=$(sed -n 's/^.*"\(Developer ID Application: .*\)"$/\1/p' <<< "$identities")
  if [[ -z "$matches" || "$matches" == *$'\n'* ]]; then
    echo 'Install a Developer ID Application certificate, or set APPLE_SIGNING_IDENTITY if you have several.' >&2
    exit 1
  fi
  export APPLE_SIGNING_IDENTITY="$matches"
fi

profile=${WRITER_NOTARY_PROFILE:-Writer-notary}
xcrun notarytool history --keychain-profile "$profile" --output-format json >/dev/null

# Keep the normal development bundle and any verified releases separate.
version=$(bun -p 'require("./src-tauri/tauri.conf.json").version')
target_dir="$PWD/src-tauri/target/distribution"
dmg_name="Writer_${version}_aarch64.dmg"
CI=true CARGO_TARGET_DIR="$target_dir" bun run tauri:dmg --target aarch64-apple-darwin -- --locked
dmg="$target_dir/aarch64-apple-darwin/release/bundle/dmg/$dmg_name"
WRITER_NOTARY_PROFILE="$profile" bash scripts/notarise-dmg.sh "$dmg"

release_dir="$target_dir/verified"
mkdir -p "$release_dir"
mv "$dmg" "$release_dir/$dmg_name"
printf 'Verified installer: %s\n' "$release_dir/$dmg_name"
