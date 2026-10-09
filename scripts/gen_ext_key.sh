#!/usr/bin/env bash
# Regenerate the extension keypair that pins the extension ID (and therefore the
# OAuth redirect https://<id>.chromiumapp.org/). Paste the printed public key
# into EXTENSION_PUBLIC_KEY in extension/wxt.config.ts. The private half stays
# in extension/dev-key.pem, which is gitignored.
set -euo pipefail

KEY_FILE="$(dirname "$0")/../extension/dev-key.pem"

if [[ -f "$KEY_FILE" ]]; then
  echo "Refusing to overwrite existing $KEY_FILE (rotating the key changes the extension ID)." >&2
  echo "Delete it first if you really want a new identity." >&2
  exit 1
fi

openssl genrsa -out "$KEY_FILE" 2048 2>/dev/null
PUB_B64=$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | base64 | tr -d '\n')

EXT_ID=$(openssl rsa -in "$KEY_FILE" -pubout -outform DER 2>/dev/null | python3 -c "
import hashlib, sys
digest = hashlib.sha256(sys.stdin.buffer.read()).hexdigest()[:32]
print(''.join(chr(ord('a') + int(c, 16)) for c in digest))
")

echo "manifest key (EXTENSION_PUBLIC_KEY):"
echo "$PUB_B64"
echo
echo "extension ID:     $EXT_ID"
echo "OAuth redirect:   https://${EXT_ID}.chromiumapp.org/"
