#!/bin/bash
# SessionStart hook for PSX Dashboard.
#  1. Activate the committed git hooks (.githooks/pre-commit stamps the footer
#     build version on every commit). core.hooksPath isn't version-controlled,
#     so it must be re-set in every fresh clone — this does it automatically.
#  2. Install npm dependencies so `node server.js` and the chart page work.
# Idempotent and non-interactive: safe to run on every session start.
set -euo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}"

# 1) Point git at the repo's committed hooks directory.
if [ -d .githooks ]; then
  git config core.hooksPath .githooks
fi

# 2) Install dependencies (cheap no-op when already present).
if [ -f package.json ]; then
  npm install --no-audit --no-fund
fi
