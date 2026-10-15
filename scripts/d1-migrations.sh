#!/usr/bin/env bash
# D1 migrations of the support database (SUPPORT_DB, wrangler.production.toml).
#
#   scripts/d1-migrations.sh apply   apply every pending migration (production deploy, before `wrangler deploy`)
#   scripts/d1-migrations.sh check   list pending migrations, apply nothing (pull request probe)
#
# Needs CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) with the account permission
# "D1: Edit". A token without it cannot read or change D1: the script then fails
# with the founder's step instead of letting a deploy ship code whose tables do not
# exist (the incident of PR 672, migration 0011). Never prints the token.
set -uo pipefail

mode="${1:-}"
config="wrangler.production.toml"
db="SUPPORT_DB"
dash="https://dash.cloudflare.com/profile/api-tokens"

case "$mode" in apply | check) ;; *) echo "usage: $0 apply|check" >&2; exit 2 ;; esac

annotate() { # level, message
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2"; fi
}

out="$(npx --yes wrangler@4 d1 migrations list "$db" --remote --config "$config" 2>&1)"
rc=$?
echo "$out"

if [ $rc -ne 0 ]; then
  if echo "$out" | grep -qiE 'authentication error|10000|not authorized|permission|unauthorized|forbidden'; then
    annotate error "CLOUDFLARE_API_TOKEN cannot read D1, so pending migrations cannot be checked or applied. Founder step: edit the token at $dash and add the permission Account > D1 > Edit, then re-run. Until then apply migrations by hand: npx wrangler d1 migrations apply $db --remote --config $config"
  else
    annotate error "wrangler d1 migrations list failed (exit $rc); see the output above."
  fi
  exit 1
fi

if echo "$out" | grep -q "No migrations to apply"; then
  annotate notice "D1 $db: no pending migrations."
  exit 0
fi

pending="$(echo "$out" | grep -oE '[0-9]{4}_[A-Za-z0-9_]+\.sql' | sort -u | tr '\n' ' ')"
if [ "$mode" = "check" ]; then
  annotate warning "D1 $db has pending migrations: ${pending:-see output}. They are applied by the production deploy before the Worker is deployed."
  exit 0
fi

annotate notice "Applying D1 migrations: ${pending:-see output}"
if ! npx --yes wrangler@4 d1 migrations apply "$db" --remote --config "$config"; then
  annotate error "Applying the D1 migrations failed; the Worker was not deployed. Apply them by hand (npx wrangler d1 migrations apply $db --remote --config $config) and re-run the deploy."
  exit 1
fi
