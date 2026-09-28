#!/usr/bin/env bash
# Cadastra a chave da Groq como credencial do n8n (id fixo cred-groq-cp5).
#
# A chave nunca passa pelo chat nem vai para o git:
#   1. adicione GROQ_API_KEY=gsk_... em infra/.env
#   2. rode: bash n8n/credentials/importar_groq.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$RAIZ/infra/.env"
SAIDA="$RAIZ/n8n/credentials/groq_cp5.json"   # ignorado pelo git

GROQ_API_KEY="$(grep -E '^GROQ_API_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"' || true)"
if [ -z "$GROQ_API_KEY" ]; then
  echo "GROQ_API_KEY não encontrada em infra/.env" >&2
  exit 1
fi

# Testa a chave antes de importar (lista modelos disponíveis)
http=$(curl -s -o /tmp/groq_models.json -w '%{http_code}' \
  -H "Authorization: Bearer $GROQ_API_KEY" https://api.groq.com/openai/v1/models)
if [ "$http" != "200" ]; then
  echo "A Groq recusou a chave (HTTP $http)." >&2
  exit 1
fi
echo "Chave válida. Modelos disponíveis:"
grep -o '"id":"[^"]*"' /tmp/groq_models.json | cut -d'"' -f4 | sort | sed 's/^/  - /'
rm -f /tmp/groq_models.json

cat > "$SAIDA" <<EOF
[
  {
    "id": "cred-groq-cp5",
    "name": "Groq CP5",
    "type": "groqApi",
    "data": { "apiKey": "$GROQ_API_KEY" }
  }
]
EOF

MSYS_NO_PATHCONV=1 docker cp "$SAIDA" cp5_n8n:/tmp/groq_cp5.json
MSYS_NO_PATHCONV=1 docker exec cp5_n8n n8n import:credentials --input=/tmp/groq_cp5.json
MSYS_NO_PATHCONV=1 docker exec cp5_n8n rm -f /tmp/groq_cp5.json
echo "Credencial cred-groq-cp5 importada no n8n."
