#!/usr/bin/env bash
# scripts/cross-repo-deploy.sh — Spot (webmcp-workout) → mootoo-cloud auto-deploy.
#
# Adapted from nomad-dashboard's copy of stark's WS-CJ seam, which has carried
# every stark deploy since Wave 11. Same shape, deliberately: after CI pushes
# ghcr.io/moolikethecow/webmcp-workout:${CIRCLE_SHA1}, this script rewrites the
# image pin in mootoo-cloud's stacks/webmcp-workout/docker-compose.yml to that
# SHA, opens a per-SHA PR, waits for mootoo-cloud CI, and merges it — which
# fires mootoo-cloud's deploy-changed workflow and Ansible rolls the stack.
# Merging main therefore IS deploying, exactly like stark and nomad.
#
# What this replaces: a human building the arm64 image on a laptop, pushing it,
# hand-editing the pin, opening the PR and merging it. That seam is why the
# Devpost-week deploys are a list of commit SHAs in a memory file rather than a
# pipeline, and why nothing ran the test suite in between.
#
# Differences from nomad's version, all simplifications:
#   * ONE pin, not two. This stack runs a single app service.
#   * A post-merge verification poll: /api/health reports the build SHA baked in
#     by build-and-push, so "merged" is not mistaken for "live" (a deploy can
#     hard-fail and leave the OLD container serving healthy — that has happened
#     on this very stack).
#
# Required env (from the `mootoo-cloud` CircleCI context):
#   CIRCLE_SHA1             — spot commit SHA (40 chars); also the image tag
#   CIRCLE_BRANCH           — must be "main" unless DRY_RUN=1
#   MOOTOO_CLOUD_PAT        — fine-grained PAT scoped to moolikethecow/mootoo-cloud
#   MOOTOO_CLOUD_CCI_TOKEN  — CircleCI API token (CI wait + confirmation poll)
#
# Optional env:
#   DRY_RUN=1               — everything except push/PR/merge; anonymous clone
#                             works, so this runs locally with zero secrets.
#   VERIFY_URL              — health endpoint to poll (default the live demo).
#   VERIFY_TIMEOUT=600      — seconds to wait for prod to report this build.
#                             0 skips the check.
#   MC_REPO / MC_CLONE_DIR / PR_WAIT_TIMEOUT / POST_MERGE_SLEEP — as in stark.
#
# All log lines are prefixed `[spot-deploy]` so they grep cleanly.
set -euo pipefail

log()  { printf '[spot-deploy] %s\n'        "$*"; }
warn() { printf '[spot-deploy] WARN: %s\n'  "$*" >&2; }
die()  { printf '[spot-deploy] FATAL: %s\n' "$*" >&2; exit 1; }

require_env() { [ -n "${!1:-}" ] || die "required env var \$$1 is empty"; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || die "required command not on PATH: $1"; }

# Deploy-seam race guard, verbatim semantics from stark (which learned it the
# hard way: 2026-06-30, a newer image tag clobbered by an older concurrent
# build). Returns 0 iff THIS commit is a STRICT ANCESTOR of the commit whose
# image mootoo-cloud main currently pins — i.e. merging us would roll prod
# BACKWARDS. Only a positively-confirmed regression blocks; any uncertainty
# (unresolvable SHA, shallow clone, equal SHAs) lets the deploy proceed.
deployed_is_newer() {
  local deployed="$1"
  [ -n "$deployed" ]                || return 1
  [ "$deployed" != "$CIRCLE_SHA1" ] || return 1
  if ! git -C "$SPOT_ROOT" cat-file -e "${deployed}^{commit}" 2>/dev/null; then
    git -C "$SPOT_ROOT" fetch --quiet origin main 2>/dev/null || true
    git -C "$SPOT_ROOT" fetch --quiet origin "$deployed" 2>/dev/null || true
  fi
  git -C "$SPOT_ROOT" cat-file -e "${deployed}^{commit}"    2>/dev/null || return 1
  git -C "$SPOT_ROOT" cat-file -e "${CIRCLE_SHA1}^{commit}" 2>/dev/null || return 1
  git -C "$SPOT_ROOT" merge-base --is-ancestor "$CIRCLE_SHA1" "$deployed" 2>/dev/null
}

# ── inputs ──────────────────────────────────────────────────────────────────
DRY_RUN="${DRY_RUN:-0}"
MC_REPO="${MC_REPO:-moolikethecow/mootoo-cloud}"
MC_CLONE_DIR="${MC_CLONE_DIR:-/tmp/mc}"
PR_WAIT_TIMEOUT="${PR_WAIT_TIMEOUT:-900}"
POST_MERGE_SLEEP="${POST_MERGE_SLEEP:-30}"
VERIFY_URL="${VERIFY_URL:-https://spot.mootoo.co/api/health}"
VERIFY_TIMEOUT="${VERIFY_TIMEOUT:-600}"
SPOT_ROOT="${CIRCLE_WORKING_DIRECTORY:-$(pwd)}"
COMPOSE_PATH="stacks/webmcp-workout/docker-compose.yml"
IMAGE="ghcr.io/moolikethecow/webmcp-workout"

require_env CIRCLE_SHA1

BRANCH="${CIRCLE_BRANCH:-}"
if [ "$DRY_RUN" != "1" ]; then
  [ "$BRANCH" = "main" ] || die "refusing live deploy from branch '$BRANCH' (set DRY_RUN=1 to test)"
  require_env MOOTOO_CLOUD_PAT
  require_env MOOTOO_CLOUD_CCI_TOKEN
fi

require_cmd git; require_cmd gh; require_cmd jq; require_cmd curl

SHORT_SHA="${CIRCLE_SHA1:0:7}"
SYNC_BRANCH="chore/spot-sync-${SHORT_SHA}"

log "spot commit:       ${CIRCLE_SHA1}"
log "image tag (built): ${IMAGE}:${CIRCLE_SHA1}"
log "sync branch:       ${SYNC_BRANCH}"
log "DRY_RUN:           ${DRY_RUN}"

# ── 1. Clone mootoo-cloud (shallow) ─────────────────────────────────────────
rm -rf "$MC_CLONE_DIR"
if [ "$DRY_RUN" = "1" ] && [ -z "${MOOTOO_CLOUD_PAT:-}" ]; then
  log "DRY_RUN without MOOTOO_CLOUD_PAT — cloning anonymously"
  git clone --depth 1 "https://github.com/${MC_REPO}.git" "$MC_CLONE_DIR" >/dev/null 2>&1 \
    || die "git clone failed (anonymous)"
else
  git clone --depth 1 \
    "https://x-access-token:${MOOTOO_CLOUD_PAT}@github.com/${MC_REPO}.git" \
    "$MC_CLONE_DIR" >/dev/null 2>&1 \
    || die "git clone failed (authenticated)"
fi
cd "$MC_CLONE_DIR"
git config user.email "ci@spot.mootoo.co"
git config user.name  "Spot CI"

[ -f "$COMPOSE_PATH" ] || die "missing ${COMPOSE_PATH} in ${MC_REPO} — has the stack moved?"

# ── 2. Read the currently-deployed SHA off the pin (the race-guard input) ───
CURRENT_PIN=$(grep -oE "${IMAGE}:[0-9a-f]{40}" "$COMPOSE_PATH" | head -1 | sed "s|${IMAGE}:||")
log "currently pinned:  ${CURRENT_PIN:-<none / non-SHA pin>}"

if [ "$CURRENT_PIN" = "$CIRCLE_SHA1" ]; then
  log "already pinned to ${SHORT_SHA}; nothing to deploy."
  exit 0
fi

# ── 3. Rewrite the pin ──────────────────────────────────────────────────────
# The compose carries exactly one image line for this app. Rewrite every
# SHA-shaped pin for this image and then assert the result: exactly 1 line on
# the new SHA, and no other SHA pin left behind. Any other count means the
# compose changed shape and blind substitution is no longer safe.
git checkout -B "$SYNC_BRANCH" >/dev/null 2>&1
# BSD sed reads `-i -E` as "-i with backup suffix -E" — the portability trap
# stark's script documents. Branch on platform so the DRY_RUN path keeps
# working on a Mac.
if [ "$(uname -s)" = "Darwin" ]; then
  sed -i '' -E "s|(${IMAGE}):[0-9a-f]{40}|\\1:${CIRCLE_SHA1}|g" "$COMPOSE_PATH"
else
  sed -i -E "s|(${IMAGE}):[0-9a-f]{40}|\\1:${CIRCLE_SHA1}|g" "$COMPOSE_PATH"
fi

NEW_COUNT=$(grep -c "${IMAGE}:${CIRCLE_SHA1}" "$COMPOSE_PATH" || true)
STRAY_COUNT=$(grep -cE "${IMAGE}:[0-9a-f]{40}" "$COMPOSE_PATH" || true)
[ "$NEW_COUNT" = "1" ] && [ "$STRAY_COUNT" = "1" ] \
  || die "pin rewrite sanity failed: expected exactly 1 pin on ${SHORT_SHA}, found ${NEW_COUNT} (total SHA pins: ${STRAY_COUNT})."
log "pin rewrite OK: app → :${SHORT_SHA}"

git add "$COMPOSE_PATH"
if git diff --cached --quiet; then
  log "no pin change for ${SHORT_SHA}; nothing to deploy."
  exit 0
fi

# ── 4. Commit + PR body ─────────────────────────────────────────────────────
COMMIT_TITLE="chore(spot): sync compose for ${SHORT_SHA}"
COMMIT_BODY="Triggered by webmcp-workout commit ${CIRCLE_SHA1} on main.

Image pushed to GHCR: ${IMAGE}:${CIRCLE_SHA1}

Auto-generated by Spot CI (scripts/cross-repo-deploy.sh).
Merging this PR fires mootoo-cloud's deploy-changed workflow."

PR_BODY_FILE="$(mktemp)"
trap 'rm -f "$PR_BODY_FILE"' EXIT
cat >"$PR_BODY_FILE" <<EOF
**Auto-generated by Spot CI** — image pin sync.

Triggered by webmcp-workout commit [\`${CIRCLE_SHA1:0:8}\`](https://github.com/moolikethecow/webmcp-workout/commit/${CIRCLE_SHA1}) on \`main\`.

Rewrites the \`stacks/webmcp-workout/docker-compose.yml\` pin to \`${IMAGE}:${CIRCLE_SHA1}\`.

### What happens on merge

1. mootoo-cloud's setup workflow sees only \`stacks/webmcp-workout/\` changed → \`deploy-changed\` fires.
2. Ansible \`stack_deploy\` rolls the stack. The change-aware bring-up recreates
   only the service whose image changed — \`app\` — and leaves the stack's
   Postgres, which holds every visitor's workspace, running.
3. \`https://spot.mootoo.co/api/health\` starts reporting \`build: ${CIRCLE_SHA1:0:8}…\`;
   the CI job that opened this PR waits for exactly that before going green.

### Rollback

Revert this PR — that re-fires \`deploy-changed\` with the previous pin.

---

🤖 Opened by [\`scripts/cross-repo-deploy.sh\`](https://github.com/moolikethecow/webmcp-workout/blob/main/scripts/cross-repo-deploy.sh).
EOF

if [ "$DRY_RUN" = "1" ]; then
  log "── DRY_RUN: PR that WOULD have been opened ──"
  log "title: ${COMMIT_TITLE}"
  git --no-pager diff --cached --stat | sed 's/^/[spot-deploy]   /'
  log "DRY_RUN complete; no push, no PR, no merge."
  exit 0
fi

git commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY" >/dev/null
git push --force \
  "https://x-access-token:${MOOTOO_CLOUD_PAT}@github.com/${MC_REPO}.git" \
  "$SYNC_BRANCH" 2>&1 | sed 's/^/[spot-deploy] git: /' \
  || die "git push failed"
log "pushed ${SYNC_BRANCH}"

# ── 5. Open or refresh the per-SHA PR ───────────────────────────────────────
export GH_TOKEN="$MOOTOO_CLOUD_PAT"
PR_URL=""
if PR_URL=$(gh pr view "$SYNC_BRANCH" --repo "$MC_REPO" --json url -q .url 2>/dev/null); then
  gh pr edit "$PR_URL" --repo "$MC_REPO" --title "$COMMIT_TITLE" --body-file "$PR_BODY_FILE" >/dev/null
  log "reusing existing PR: $PR_URL"
else
  PR_URL=$(gh pr create --repo "$MC_REPO" --base main --head "$SYNC_BRANCH" \
    --title "$COMMIT_TITLE" --body-file "$PR_BODY_FILE")
  log "opened PR: $PR_URL"
fi
PR_NUMBER=$(printf '%s' "$PR_URL" | sed -E 's@.*/pull/([0-9]+).*@\1@')
[ -n "$PR_NUMBER" ] || die "could not extract PR number from URL: $PR_URL"

# ── 6. Wait for mootoo-cloud CI (via the CircleCI API — the fine-grained PAT
#       deliberately lacks Checks:read, same constraint as stark) ────────────
POLL_INTERVAL=15
# A function because the stale-branch retry below waits a SECOND time after
# force-pushing a rebuilt branch.
wait_for_mc_ci() {
  log "waiting for mootoo-cloud CI on ${SYNC_BRANCH} (timeout ${PR_WAIT_TIMEOUT}s)…"
  local elapsed=0 ok=0 pipeline_id wf_status
  sleep 10
  while [ "$elapsed" -lt "$PR_WAIT_TIMEOUT" ]; do
    pipeline_id=$(curl -fsS -H "Circle-Token: ${MOOTOO_CLOUD_CCI_TOKEN}" \
      "https://circleci.com/api/v2/project/gh/${MC_REPO}/pipeline?branch=${SYNC_BRANCH}" 2>/dev/null \
      | jq -r '.items[0].id // empty' || true)
    if [ -n "$pipeline_id" ]; then
      wf_status=$(curl -fsS -H "Circle-Token: ${MOOTOO_CLOUD_CCI_TOKEN}" \
        "https://circleci.com/api/v2/pipeline/${pipeline_id}/workflow" 2>/dev/null \
        | jq -r '.items[0].status // empty' || true)
      case "$wf_status" in
        success)              ok=1; break ;;
        failed|error|failing) die "mootoo-cloud workflow ${wf_status} for ${SYNC_BRANCH} — see ${PR_URL}" ;;
        canceled)             die "mootoo-cloud workflow canceled for ${SYNC_BRANCH}" ;;
      esac
    fi
    sleep "$POLL_INTERVAL"; elapsed=$((elapsed + POLL_INTERVAL))
  done
  [ "$ok" -eq 1 ] || die "mootoo-cloud CI timed out after ${PR_WAIT_TIMEOUT}s (see ${PR_URL})"
  log "mootoo-cloud CI GREEN for ${SYNC_BRANCH}"
}

wait_for_mc_ci

# ── 7. Race guard at the last moment, then merge ────────────────────────────
git fetch --depth 1 origin main >/dev/null 2>&1 || true
DEPLOYED_SHA=$(git show "FETCH_HEAD:${COMPOSE_PATH}" 2>/dev/null \
  | grep -oE "${IMAGE}:[0-9a-f]{40}" | head -1 | sed "s|${IMAGE}:||" || true)
log "pin on mootoo-cloud main right now: ${DEPLOYED_SHA:-<none>}"

if deployed_is_newer "$DEPLOYED_SHA"; then
  warn "mootoo-cloud main already pins a NEWER spot commit (${DEPLOYED_SHA:0:8})."
  warn "Merging ${SHORT_SHA} would REGRESS prod. Skipping (race guard)."
  gh pr close "$PR_NUMBER" --repo "$MC_REPO" --delete-branch \
    --comment "Superseded: mootoo-cloud main pins \`${DEPLOYED_SHA:0:8}\`, a descendant of this PR's \`${SHORT_SHA}\`. Auto-closed by the race guard." \
    >/dev/null 2>&1 || warn "could not auto-close superseded PR #${PR_NUMBER}"
  exit 0
fi

# Re-parent onto the CURRENT main, keeping our pin rewrite as-is.
#
# WHY (learned on the stark and nomad sides, 2026-08-15): two merges close
# together each open a sync PR. While ours waits on mootoo-cloud CI, an earlier
# one can merge — moving main under us and leaving our branch conflicting on the
# very line every sync rewrites. `gh pr merge` then fails and that commit never
# deploys.
#
# NOT the regression case the guard above handles: there a NEWER commit already
# won and skipping is right. Here we ARE the newer commit and must still land.
# `reset --soft` keeps our rewritten compose and only re-points HEAD, so the
# replayed commit is "latest main + our pin" with no conflict possible.
refresh_branch_onto_main() {
  log "re-parenting ${SYNC_BRANCH} onto the current ${MC_REPO} main…"
  git fetch --depth 1 origin main >/dev/null 2>&1 \
    || { warn "could not fetch ${MC_REPO} main for the retry"; return 1; }
  git reset --soft FETCH_HEAD >/dev/null 2>&1 \
    || { warn "could not re-parent onto main"; return 1; }
  if git diff --cached --quiet; then
    log "main already pins this exact SHA; nothing left to merge."
    return 2
  fi
  git commit -m "$COMMIT_TITLE" -m "$COMMIT_BODY" >/dev/null \
    || { warn "could not commit the re-parented tree"; return 1; }
  git push --force \
    "https://x-access-token:${MOOTOO_CLOUD_PAT}@github.com/${MC_REPO}.git" \
    "$SYNC_BRANCH" >/dev/null 2>&1 \
    || { warn "could not force-push the re-parented branch"; return 1; }
  log "re-parented and force-pushed ${SYNC_BRANCH}"
  return 0
}

log "merging PR #${PR_NUMBER}…"
if ! gh pr merge "$PR_NUMBER" --repo "$MC_REPO" --squash --delete-branch; then
  warn "first merge attempt failed for #${PR_NUMBER} — main likely moved while we waited."
  refresh_branch_onto_main
  case "$?" in
    2) log "nothing to merge after re-parenting; treating ${SHORT_SHA} as deployed."
       gh pr close "$PR_NUMBER" --repo "$MC_REPO" --delete-branch \
         --comment "Closed by the deploy seam: after re-parenting onto the current main this PR had no remaining diff — a concurrent sync already pinned the same image." \
         >/dev/null 2>&1 || true
       exit 0 ;;
    0) : ;;
    *) die "gh pr merge failed for #${PR_NUMBER} and the branch could not be re-parented" ;;
  esac
  wait_for_mc_ci
  log "retrying merge of PR #${PR_NUMBER}…"
  gh pr merge "$PR_NUMBER" --repo "$MC_REPO" --squash --delete-branch \
    || die "gh pr merge failed for #${PR_NUMBER} even after re-parenting onto main"
fi
log "PR #${PR_NUMBER} merged — this IS the deploy"

# ── 8. Confirm the downstream pipeline fired ────────────────────────────────
sleep "${POST_MERGE_SLEEP}"
LATEST_NUMBER=$(curl -fsS -H "Circle-Token: ${MOOTOO_CLOUD_CCI_TOKEN}" \
  "https://circleci.com/api/v2/project/gh/${MC_REPO}/pipeline?branch=main" 2>/dev/null \
  | jq -r '.items[0].number // empty' || true)
if [ -n "$LATEST_NUMBER" ]; then
  log "mootoo-cloud pipeline fired: https://app.circleci.com/pipelines/github/${MC_REPO}/${LATEST_NUMBER}"
else
  warn "merge succeeded but could not confirm the downstream pipeline —"
  warn "check https://app.circleci.com/pipelines/github/${MC_REPO}?branch=main"
fi

# ── 9. Wait for prod to actually report THIS build ──────────────────────────
# "Merged" is not "live". A failed deploy leaves the previous container running
# and healthy, so a pipeline that stops at the merge reports success for a
# deploy that never landed — the exact failure mode that cost this stack a
# hard-failed apply on 2026-09-03 while gym.mootoo.co kept serving the old
# image. /api/health echoes the APP_BUILD baked in by build-and-push, so the
# check is a string compare against a value only this build can produce.
if [ "${VERIFY_TIMEOUT}" -eq 0 ]; then
  log "VERIFY_TIMEOUT=0 — skipping the post-deploy health check."
  exit 0
fi

log "waiting for ${VERIFY_URL} to report build ${SHORT_SHA} (timeout ${VERIFY_TIMEOUT}s)…"
ELAPSED=0
while [ "$ELAPSED" -lt "$VERIFY_TIMEOUT" ]; do
  LIVE_BUILD=$(curl -fsS --max-time 10 "$VERIFY_URL" 2>/dev/null | jq -r '.build // empty' || true)
  if [ "$LIVE_BUILD" = "$CIRCLE_SHA1" ]; then
    log "prod is serving ${SHORT_SHA}. Deploy complete."
    exit 0
  fi
  sleep 15; ELAPSED=$((ELAPSED + 15))
done

die "prod still reports build '${LIVE_BUILD:-<none>}' after ${VERIFY_TIMEOUT}s, not ${SHORT_SHA}.
The pin merged, so the image is right — check mootoo-cloud's deploy-changed run
(https://app.circleci.com/pipelines/github/${MC_REPO}?branch=main). A hard-failed
apply leaves the OLD container serving healthy, which is why this is red."
