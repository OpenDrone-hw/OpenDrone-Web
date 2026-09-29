#!/bin/sh
# Start the dedicated Chrome for `npm run emails:paste` (remote debugging on
# 9222). Log into Shopify in this window once; the profile keeps the session.
# The profile is separate from your daily Chrome and lives outside the repo.
set -e
PROFILE="${SHOPIFY_CHROME_PROFILE:-$HOME/.incutec/chrome-shopify}"
mkdir -p "$PROFILE"
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  "https://admin.shopify.com/store/${SHOPIFY_ADMIN_STORE_HANDLE:-ktjqug-jw}"
echo "Chrome started with remote debugging on 9222 (profile $PROFILE)."
