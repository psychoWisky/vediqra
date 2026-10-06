#!/usr/bin/env bash
# VEDIQRA production deployment (existing PM2 process only).
# Run from /var/www/vediqra:  ./deploy.sh
#
# Deliberately does NOT: touch backend/.env, run migrations or seeds, reset/clean git, or
# delete anything. Migrations stay a manual step (see docs/DATABASE_MIGRATIONS.md).

set -Eeuo pipefail

APP_ROOT="/var/www/vediqra"
PM2_NAME="vediqra-backend"
BRANCH="main"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:5000/health}"   # GET /health in backend/src/app.ts; port = PORT (default 5000)
TOTAL=9
STAGE="starting up"
RESTARTED=0

on_error() {
  local code=$?
  echo
  echo "========================================"
  echo " Deployment FAILED during: ${STAGE}"
  echo " (exit code ${code}, line ${BASH_LINENO[0]}: ${BASH_COMMAND})"
  if [ "$RESTARTED" -eq 1 ]; then
    echo " The backend WAS restarted before this failure. Check: pm2 logs ${PM2_NAME}"
  else
    echo " PM2 was NOT restarted; the running production app is unchanged."
  fi
  echo "========================================"
  exit "$code"
}
trap on_error ERR

stage() { STAGE="$2"; echo "[$1/${TOTAL}] $2..."; }
abort() { echo "Deployment aborted: $1" >&2; exit 1; }

echo "========================================"
echo " VEDIQRA Production Deployment"
echo "========================================"

stage 1 "Checking repository"
[ "$(pwd -P)" = "$APP_ROOT" ] || abort "must be run from ${APP_ROOT} (currently in $(pwd -P))."
[ -d .git ] || abort "${APP_ROOT} is not a Git repository."
[ -d backend ] && [ -d frontend ] || abort "backend/ and frontend/ directories not found."
git remote get-url origin >/dev/null 2>&1 || abort "no 'origin' remote configured."
command -v pm2 >/dev/null || abort "pm2 is not installed."
command -v curl >/dev/null || abort "curl is not installed."
pm2 describe "$PM2_NAME" >/dev/null 2>&1 || abort "PM2 process '${PM2_NAME}' does not exist (this script does not create it)."

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "  Branch: ${CURRENT_BRANCH}"
echo "  Commit before deploy: $(git rev-parse --short HEAD)"
[ "$CURRENT_BRANCH" = "$BRANCH" ] || abort "must deploy from '${BRANCH}', but the current branch is '${CURRENT_BRANCH}'."
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  git status --short --untracked-files=no >&2
  abort "working tree contains uncommitted changes."
fi

stage 2 "Pulling latest ${BRANCH}"
git pull --ff-only origin "$BRANCH"
DEPLOYED_SHA="$(git rev-parse HEAD)"

stage 3 "Installing backend dependencies"
(cd backend && npm ci)

stage 4 "Validating backend (typecheck)"
(cd backend && npm run typecheck)

stage 5 "Building backend"
(cd backend && npm run build)

stage 6 "Installing frontend dependencies"
(cd frontend && npm ci)

stage 7 "Building frontend"
(cd frontend && npm run build)

stage 8 "Restarting backend"
RESTARTED=1
pm2 restart "$PM2_NAME"
sleep 3
PM2_STATUS="$(pm2 jlist | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const p = JSON.parse(s).find(x => x.name === process.argv[1]);
    process.stdout.write(p ? String(p.pm2_env.status) : "missing");
  });' "$PM2_NAME")"
[ "$PM2_STATUS" = "online" ] || { echo "PM2 status for ${PM2_NAME}: ${PM2_STATUS}" >&2; exit 1; }
echo "  ${PM2_NAME} is online."

stage 9 "Running health check"
HEALTHY=0
for attempt in 1 2 3 4 5 6 7 8; do
  if curl --fail --silent --show-error --max-time 5 "$HEALTH_URL" >/dev/null; then HEALTHY=1; break; fi
  echo "  Health check attempt ${attempt} failed; retrying..."
  sleep 2
done
[ "$HEALTHY" -eq 1 ] || abort "health check failed at ${HEALTH_URL}. Check: pm2 logs ${PM2_NAME}"

trap - ERR
echo
echo "========================================"
echo " Deployment successful."
echo " Commit: ${DEPLOYED_SHA}"
echo "========================================"
