#!/usr/bin/env bash
# 拉起一个真的 gateway，然后用客户端自己的 API 模块对着它跑 tests/live。
#
# 为什么要有这个：tests/api 下的单测全部打在 MSW 上，mock 是照契约手写的，
# 两边各自照文档实现、各自绿、合起来跑不通，是这类改动最常见的死法。
#
# gateway 仓库的位置默认按同级目录猜，可以用 GATEWAY_REPO 覆盖：
#   GATEWAY_REPO=~/src/llm_gateway ./scripts/live-gateway-test.sh
#
# 不在 CI 里跑（要另一个仓库 + go 工具链），改换档相关代码时手动跑。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GATEWAY_REPO="${GATEWAY_REPO:-${ROOT_DIR}/../model_gateway}"
PORT="${GATEWAY_PORT:-18141}"

if [ ! -d "${GATEWAY_REPO}/services/gateway-api" ]; then
  echo "找不到 gateway 仓库：${GATEWAY_REPO}"
  echo "用 GATEWAY_REPO=<path> 指过去。"
  exit 1
fi

LOG_FILE="$(mktemp)"
cleanup() {
  # 杀 GATEWAY_PID 是不够的：那是 `go run` 的 PID，真正 listen 的是它编译出来
  # 再 exec 的子进程，`go run` 被杀时不会带走它。端口就这么一直被占着，下一次
  # 跑会连上一个残留的、已经买过东西的 server —— 断言写死了金额，必然乱掉。
  if [ -n "${GATEWAY_PID:-}" ] && kill -0 "${GATEWAY_PID}" 2>/dev/null; then
    kill "${GATEWAY_PID}" 2>/dev/null || true
    wait "${GATEWAY_PID}" 2>/dev/null || true
  fi
  local squatter
  squatter="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [ -n "${squatter}" ]; then
    kill ${squatter} 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo ":${PORT} 已经被占用。这些用例断言了确切金额，只有在干净的 store 上才成立；"
  echo "先停掉占用者，或者用 GATEWAY_PORT=<其它端口> 重跑。"
  exit 1
fi

# 每次都是全新的内存态：几条断言写死了金额（$877 找零），只有在没人花过钱的
# store 上才成立。
(
  cd "${GATEWAY_REPO}/services/gateway-api"
  OAUTH_TOKEN_SIGNING_KEY="local-dev-token-signing-key" \
    OAUTH_REFRESH_TOKEN_PEPPER="local-dev-refresh-pepper" \
    OAUTH_ISSUER="llm-gateway-local" \
    GATEWAY_HTTP_ADDR=":${PORT}" \
    go run ./cmd/gateway-api
) >"${LOG_FILE}" 2>&1 &
GATEWAY_PID="$!"

echo "等 gateway 起来（:${PORT}）..."
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -fsS "http://localhost:${PORT}/healthz" >/dev/null 2>&1; then
  echo "gateway 没起来："
  cat "${LOG_FILE}"
  exit 1
fi

set +e
VITE_GATEWAY_URL="http://localhost:${PORT}" \
  "${ROOT_DIR}/node_modules/.bin/vitest" run --config vitest.live.config.ts
STATUS=$?
set -e

if [ "${STATUS}" -ne 0 ]; then
  echo "--- gateway 日志 ---"
  tail -40 "${LOG_FILE}"
fi
exit "${STATUS}"
