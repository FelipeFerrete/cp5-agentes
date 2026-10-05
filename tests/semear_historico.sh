#!/usr/bin/env bash
# Semeia o histórico de 2 h do MOTOR_01 antes de uma demonstração.
#
#   bash tests/semear_historico.sh estavel     # histórico plano (padrão; use antes de C01, C03, C11...)
#   bash tests/semear_historico.sh tendencia   # temperatura subindo ~20 % em 2 h (use antes do C07)
#
# O seed é relativo a NOW(): ele "envelhece" e sai da janela de 2 h. Rode de novo
# logo antes de cada cenário que dependa do histórico.
# A senha do MySQL é lida dentro do próprio container (não passa por este script).
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
case "${1:-estavel}" in
  estavel)   ARQ="reset_estavel.sql" ;;
  tendencia) ARQ="tendencia_alta.sql" ;;
  *) echo "uso: bash tests/semear_historico.sh [estavel|tendencia]" >&2; exit 1 ;;
esac

docker exec -i cp5_mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" fabrica_iot 2>/dev/null' \
  < "$RAIZ/db/cenarios/$ARQ"

echo "Histórico do MOTOR_01 semeado com db/cenarios/$ARQ"
