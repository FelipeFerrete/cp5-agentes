#!/usr/bin/env bash
# T01 - Healthcheck da infra Docker (n8n + Mosquitto + MySQL)
# Uso: rodar a partir de cp5-agentes/infra/  ->  bash healthcheck.sh
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

PASS=0
FAIL=0

ok()   { echo "[PASS] $1"; PASS=$((PASS+1)); }
bad()  { echo "[FAIL] $1"; FAIL=$((FAIL+1)); }

echo "== T01 healthcheck =="

# ---------------------------------------------------------------------------
# 1) n8n /healthz
# ---------------------------------------------------------------------------
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:5678/healthz 2>/dev/null)
if [ "$HTTP_CODE" = "200" ]; then
  ok "n8n /healthz respondeu 200"
else
  bad "n8n /healthz respondeu '$HTTP_CODE' (esperado 200)"
fi

# ---------------------------------------------------------------------------
# 2) MQTT roundtrip (pub/sub) via mosquitto no compose
# ---------------------------------------------------------------------------
TOPIC="fabrica/TESTE/sensores"
SUB_OUT_FILE="$(mktemp)"
docker compose exec -T mosquitto mosquitto_sub \
  -h 127.0.0.1 -p 1883 -u "$MQTT_USER" -P "$MQTT_PASSWORD" \
  -t "$TOPIC" -C 1 -W 10 >"$SUB_OUT_FILE" 2>/dev/null &
SUB_PID=$!

sleep 1

docker compose exec -T mosquitto mosquitto_pub \
  -h 127.0.0.1 -p 1883 -u "$MQTT_USER" -P "$MQTT_PASSWORD" \
  -t "$TOPIC" -m '{"teste":"healthcheck"}' >/dev/null 2>&1

wait "$SUB_PID"
SUB_RESULT=$(cat "$SUB_OUT_FILE")
rm -f "$SUB_OUT_FILE"

if [ -n "$SUB_RESULT" ]; then
  ok "MQTT roundtrip em '$TOPIC' recebeu: $SUB_RESULT"
else
  bad "MQTT roundtrip em '$TOPIC' não recebeu nenhuma mensagem"
fi

# ---------------------------------------------------------------------------
# 3) MySQL ping
# ---------------------------------------------------------------------------
if docker compose exec -T mysql mysqladmin ping -h 127.0.0.1 -u root -p"$MYSQL_ROOT_PASSWORD" --silent >/dev/null 2>&1; then
  ok "mysqladmin ping OK"
else
  bad "mysqladmin ping falhou"
fi

echo "== Resultado: $PASS passou / $FAIL falhou =="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
