#!/usr/bin/env bash
# D1 migrations of the support database (SUPPORT_DB, wrangler.production.toml).
#
#   scripts/d1-migrations.sh apply   apply every pending migration (production deploy, before `wrangler deploy`)
#   scripts/d1-migrations.sh check   list pending migrations, apply nothing (pull request probe)
#
# Needs CLOUDFLARE_API_TOKEN (and CLOUDFLARE_ACCOUNT_ID) with the account permission
# "D1: Edit". A token without it cannot read or change D1: the script then fails
# with the founder's step. It then falls back to the live Worker's applied list
# (GET /api/support/schema) so that, with pending migrations, the deploy still fails
# before it ships code whose tables do not exist (the incident of PR 672, migration
# 0011). Never prints the token.
set -uo pipefail

mode="${1:-}"
config="wrangler.production.toml"
db="SUPPORT_DB"
dash="https://dash.cloudflare.com/profile/api-tokens"
site="${SUPPORT_SITE:-https://opendrone.be}"

case "$mode" in apply | check) ;; *) echo "usage: $0 apply|check" >&2; exit 2 ;; esac

annotate() { # level, message
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$1::$2"; else echo "$1: $2"; fi
}

out="$(npx --yes wrangler@4 d1 migrations list "$db" --remote --config "$config" 2>&1)"
rc=$?
echo "$out"

if [ $rc -ne 0 ]; then
  if echo "$out" | grep -qiE 'authentication error|10000|7403|not authorized|permission|unauthorized|forbidden'; then
    annotate warning "CLOUDFLARE_API_TOKEN cannot read D1. Founder step: edit the token at $dash and add Account > D1 > Edit. Until then migrations are not applied by CI: apply them by hand with npx wrangler d1 migrations apply $db --remote --config $config"
    # Fallback without D1 access: what the live Worker reports as applied (GET /api/support/schema) against migrations/.
    applied="$(curl -fsS --max-time 20 "$site/api/support/schema" 2>/dev/null | python3 -c 'import sys,json; print(" ".join(json.load(sys.stdin)["migrations"]))' 2>/dev/null)"
    if [ -z "$applied" ]; then
      annotate warning "Could not read the applied migrations from $site/api/support/schema either (the endpoint ships with the Worker): pending migrations are NOT verified."
      if [ "$mode" = "apply" ]; then
        annotate error "The Worker was NOT deployed because its D1 schema could not be verified. Restore D1 access and re-run the deploy."
        exit 1
      fi
      exit 0
    fi
    missing=""
    for f in migrations/*.sql; do
      n="$(basename "$f")"
      case " $applied " in *" $n "*) ;; *) missing="$missing $n" ;; esac
    done
    if [ -z "$missing" ]; then
      annotate notice "D1 $db: no pending migrations (read from the live Worker)."
      exit 0
    fi
    if [ "$mode" = "check" ]; then
      annotate warning "D1 $db has pending migrations:$missing. The token cannot apply them: the production deploy will fail until they are applied by hand or the token has D1 Edit."
      exit 0
    fi
    annotate error "D1 $db has pending migrations:$missing and the token cannot apply them. The Worker was NOT deployed: it would run code whose tables do not exist. Apply them (npx wrangler d1 migrations apply $db --remote --config $config) or give the token Account > D1 > Edit ($dash), then re-run the deploy."
    exit 1
  fi
  annotate error "wrangler d1 migrations list failed (exit $rc); see the output above."
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
