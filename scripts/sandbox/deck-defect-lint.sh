#!/usr/bin/env bash
# Sandbox-цикл lint'а дефектов колод — одна команда.
#   bash scripts/sandbox/deck-defect-lint.sh
# Короткий TMPDIR обязателен: Chrome не стартует, если путь до его
# SingletonSocket > 108 символов (в слоте агента TMPDIR длинный). Каталог
# временный и удаляется на выходе; на CI TMPDIR уже короткий.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SHORT="$(mktemp -d /tmp/deck-lint-XXXXXX)"
trap 'rm -rf "$SHORT"' EXIT
export TMPDIR="$SHORT"
node "$ROOT/scripts/sandbox/deck-defect-lint.js" "$@"
