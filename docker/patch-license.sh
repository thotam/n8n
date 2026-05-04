#!/bin/sh
# Script tự động patch license.js
# Dùng Node.js để patch chính xác (tránh lỗi sed multiline)
# Flag: --skip-exec → chỉ patch, không exec n8n (dùng khi Dockerfile build-time)

SKIP_EXEC=0
if [ "$1" = "--skip-exec" ]; then
  SKIP_EXEC=1
  shift
fi

LICENSE_FILE="/usr/local/lib/node_modules/n8n/dist/license.js"

if [ ! -f "$LICENSE_FILE" ]; then
  echo "[patch] CẢNH BÁO: Không tìm thấy license.js"
  [ "$SKIP_EXEC" = "1" ] && exit 0 || exec /docker-entrypoint.sh "$@"
fi

# Kiểm tra đã patch chưa
if grep -q "feat:showNonProdBanner" "$LICENSE_FILE"; then
  echo "[patch] Đã patch trước đó, bỏ qua."
  [ "$SKIP_EXEC" = "1" ] && exit 0 || exec /docker-entrypoint.sh "$@"
fi

echo "[patch] Đang patch license.js ..."

node -e "
const fs = require('fs');
let code = fs.readFileSync('$LICENSE_FILE', 'utf8');

// 1. isLicensed() → return true (trừ showNonProdBanner, apiDisabled, và toàn bộ AI features)
code = code.replace(
  /isLicensed\(feature\)\s*\{\s*return this\.manager\?\.hasFeatureEnabled\(feature\) \?\? false;\s*\}/,
  \"isLicensed(_feature) { const _disabled = ['feat:showNonProdBanner','feat:apiDisabled','feat:aiAssistant','feat:aiBuilder','feat:aiGateway','feat:aiCredits']; if (_disabled.includes(_feature)) return false; return true; }\"
);

// 2. getValue() → return unlimited cho mọi quota
code = code.replace(
  /getValue\(feature\)\s*\{\s*return this\.manager\?\.getFeatureValue\(feature\);\s*\}/,
  \"getValue(feature) { if (feature === 'planName') return 'Enterprise'; if (typeof feature === 'string' && feature.startsWith('quota:')) return constants_1.UNLIMITED_LICENSE_QUOTA; return this.manager?.getFeatureValue(feature); }\"
);

// 3. Quota methods - getUsersLimit
code = code.replace(
  /getUsersLimit\(\)\s*\{[^}]*LICENSE_QUOTAS\.USERS_LIMIT[^}]*\}/,
  'getUsersLimit() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getTriggerLimit
code = code.replace(
  /getTriggerLimit\(\)\s*\{[^}]*LICENSE_QUOTAS\.TRIGGER_LIMIT[^}]*\}/,
  'getTriggerLimit() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getVariablesLimit
code = code.replace(
  /getVariablesLimit\(\)\s*\{[^}]*LICENSE_QUOTAS\.VARIABLES_LIMIT[^}]*\}/,
  'getVariablesLimit() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getAiCredits
code = code.replace(
  /getAiCredits\(\)\s*\{[^}]*LICENSE_QUOTAS\.AI_CREDITS[^}]*\}/,
  'getAiCredits() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getWorkflowHistoryPruneLimit (multiline)
code = code.replace(
  /getWorkflowHistoryPruneLimit\(\)\s*\{[\s\S]*?DEFAULT_WORKFLOW_HISTORY_PRUNE_LIMIT\);?\s*\}/,
  'getWorkflowHistoryPruneLimit() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getTeamProjectLimit
code = code.replace(
  /getTeamProjectLimit\(\)\s*\{[^}]*LICENSE_QUOTAS\.TEAM_PROJECT_LIMIT[^}]*\}/,
  'getTeamProjectLimit() { return constants_1.UNLIMITED_LICENSE_QUOTA; }'
);

// getPlanName
code = code.replace(
  /getPlanName\(\)\s*\{[^}]*'Community'[^}]*\}/,
  \"getPlanName() { return 'Enterprise'; }\"
);

fs.writeFileSync('$LICENSE_FILE', code);
console.log('[patch] Ghi file thành công!');
"

if [ $? -ne 0 ]; then
  echo "[patch] LỖI: Patch thất bại!"
else
  echo "[patch] Hoàn tất!"
fi

if [ "$SKIP_EXEC" = "1" ]; then
  echo "[patch] Chế độ build-time: Hoàn tất, không khởi động n8n."
  exit 0
fi

echo "[patch] Khởi động n8n..."
exec /docker-entrypoint.sh "$@"
