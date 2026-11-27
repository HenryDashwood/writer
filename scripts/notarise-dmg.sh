#!/bin/bash
set -euo pipefail

dmg=${1:?Pass the path to the signed DMG}
if [[ -n "${WRITER_NOTARY_PROFILE:-}" ]]; then
  credentials=(--keychain-profile "$WRITER_NOTARY_PROFILE")
else
  credentials=(--apple-id "${APPLE_ID:?}" --team-id "${APPLE_TEAM_ID:?}" --password "${APPLE_PASSWORD:?}")
fi

codesign --verify --strict -R='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists' "$dmg"
echo 'Submitting the signed DMG to Apple for notarisation.'
submit_exit=0
result=$(xcrun notarytool submit "$dmg" "${credentials[@]}" --wait --output-format json) || submit_exit=$?
if [[ -z "$result" && "$submit_exit" != 0 ]]; then
  exit "$submit_exit"
fi
printf '%s\n' "$result"
status=$(jq -er '.status' <<< "$result")
if [[ "$status" != Accepted ]]; then
  submission=$(jq -er '.id' <<< "$result")
  xcrun notarytool log "$submission" "${credentials[@]}"
  exit 1
fi
if [[ "$submit_exit" != 0 ]]; then
  exit "$submit_exit"
fi

xcrun stapler staple "$dmg"
xcrun stapler validate "$dmg"
codesign --verify --strict "$dmg"
