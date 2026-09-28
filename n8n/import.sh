#!/usr/bin/env bash
# Importa (e ativa, quando aplicável) todos os workflows de n8n/workflows/*.json
# dentro do container cp5_n8n, via n8n CLI.
#
# Uso:
#   ./import.sh
#
# Requisitos: Docker rodando, container cp5_n8n no ar, Git Bash no Windows
# (usa MSYS_NO_PATHCONV=1 para não deixar o Git Bash reescrever caminhos
# absolutos do tipo /tmp/... nos comandos `docker exec`).
#
# Idempotência: cada workflow JSON deve ter um campo "id" fixo (ex.: "wf-smoke-0001").
# `n8n import:workflow` faz upsert por esse id: reimportar o mesmo arquivo
# atualiza o workflow existente em vez de duplicar.
#
# ARMADILHA n8n 2.40 (modo single-instance, sem queue mode):
#   - `import:workflow --activeState=fromJson` NÃO funciona fora do modo
#     queue/multi-main (erro explícito). Por isso este script sempre importa
#     como inativo e, para workflows com "active": true no JSON, chama
#     `n8n publish:workflow --id=<id>` em seguida.
#   - `publish:workflow` grava a publicação no banco, mas o processo n8n
#     que já está rodando só passa a registrar o webhook/trigger ativo
#     DEPOIS de um restart do processo. Por isso este script reinicia o
#     container cp5_n8n (docker restart, não down/recria volumes) sempre
#     que pelo menos um workflow foi publicado nesta execução.

set -euo pipefail

CONTAINER="cp5_n8n"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS_DIR="$SCRIPT_DIR/workflows"
REMOTE_DIR="/tmp/cp5_import"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "ERRO: container ${CONTAINER} não está rodando. Suba a infra primeiro (docker compose up -d)." >&2
  exit 1
fi

if ! ls "$WORKFLOWS_DIR"/*.json >/dev/null 2>&1; then
  echo "Nenhum workflow em $WORKFLOWS_DIR/*.json. Nada a importar."
  exit 0
fi

MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" mkdir -p "$REMOTE_DIR"

activated_ids=()

for f in "$WORKFLOWS_DIR"/*.json; do
  name="$(basename "$f")"
  echo ">> Importando ${name}..."
  # docker cp: o caminho de ORIGEM precisa estar em formato Windows (senão o
  # cliente Docker no Windows resolve errado um caminho estilo /c/... vindo
  # do Git Bash); o DESTINO é "container:/caminho" e não pode ser reescrito
  # pelo MSYS, daí MSYS_NO_PATHCONV=1 só neste comando.
  f_win="$(cygpath -w "$f" 2>/dev/null || echo "$f")"
  MSYS_NO_PATHCONV=1 docker cp "$f_win" "${CONTAINER}:${REMOTE_DIR}/${name}"
  MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" n8n import:workflow --input="${REMOTE_DIR}/${name}"

  is_active="$(python -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print('1' if d.get('active') else '0')" "$f")"
  wf_id="$(python -c "import json,sys; d=json.load(open(sys.argv[1], encoding='utf-8')); print(d.get('id') or '')" "$f")"

  if [ "$is_active" = "1" ]; then
    if [ -z "$wf_id" ]; then
      echo "   AVISO: ${name} tem \"active\": true mas não define \"id\" fixo; não é possível publicar com segurança (evitando duplicar). Adicione um \"id\"." >&2
    else
      echo "   Publicando ${wf_id}..."
      MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" n8n publish:workflow --id="$wf_id"
      activated_ids+=("$wf_id")
    fi
  fi
done

if [ "${#activated_ids[@]}" -gt 0 ]; then
  echo ">> ${#activated_ids[@]} workflow(s) publicado(s): ${activated_ids[*]}"
  echo ">> Reiniciando ${CONTAINER} para ativar triggers (necessário no modo single-instance)..."
  docker restart "$CONTAINER" >/dev/null

  for _ in $(seq 1 30); do
    status="$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "")"
    if [ "$status" = "healthy" ]; then
      break
    fi
    sleep 2
  done

  status="$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "unknown")"
  echo ">> ${CONTAINER} status: ${status}"
else
  echo ">> Nenhum workflow marcado como \"active\": true; nenhum restart necessário."
fi

echo ""
echo ">> Workflows ativos no momento:"
MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" n8n list:workflow --active=true
