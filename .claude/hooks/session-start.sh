#!/bin/bash
# Облачная сессия Claude Code: всё для проверок плагина — зависимости tests/
# и сборка Lampa для проверок в настоящем приложении (npm run e2e)
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}/tests"

# npm install, а не npm ci: состояние контейнера кешируется после хука,
# и повторный запуск только сверяет уже установленное
npm install --no-audit --no-fund --loglevel=error

# Сборка Lampa нужна только проверкам в настоящем приложении — без неё
# эмулятор и линтер работают, поэтому её недоступность сессию не роняет
npm run --silent setup || echo "Сборка Lampa не скачалась: npm run e2e недоступен, npm run check работает" >&2
