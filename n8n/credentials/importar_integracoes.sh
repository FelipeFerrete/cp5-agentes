#!/usr/bin/env bash
# Cadastra no n8n as credenciais das ações do WF-30 (ids fixos usados pelos workflows):
#   cred-telegram-cp5    (Telegram CP5)     <- TELEGRAM_BOT_TOKEN
#   cred-smtp-gmail-cp5  (SMTP Gmail CP5)   <- EMAIL_REMETENTE + GMAIL_APP_PASSWORD
#   cred-trello-cp5      (Trello CP5)       <- TRELLO_API_KEY + TRELLO_TOKEN
#
# Os valores vêm de infra/.env; nada passa pelo chat nem vai para o git.
# Integração sem valor preenchido é pulada (dá para cadastrar aos poucos).
#   bash n8n/credentials/importar_integracoes.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$RAIZ/infra/.env"
SAIDA="$RAIZ/n8n/credentials/integracoes_cp5.json"   # ignorado pelo git

ler() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"' || true; }

TELEGRAM_BOT_TOKEN="$(ler TELEGRAM_BOT_TOKEN)"
EMAIL_REMETENTE="$(ler EMAIL_REMETENTE)"
GMAIL_APP_PASSWORD="$(ler GMAIL_APP_PASSWORD | tr -d ' ')"
TRELLO_API_KEY="$(ler TRELLO_API_KEY)"
TRELLO_TOKEN="$(ler TRELLO_TOKEN)"

itens=()

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  itens+=("$(cat <<EOF
  {
    "id": "cred-telegram-cp5",
    "name": "Telegram CP5",
    "type": "telegramApi",
    "data": { "accessToken": "$TELEGRAM_BOT_TOKEN" }
  }
EOF
)")
else
  echo "Telegram: TELEGRAM_BOT_TOKEN vazio, pulando."
fi

if [ -n "$EMAIL_REMETENTE" ] && [ -n "$GMAIL_APP_PASSWORD" ]; then
  itens+=("$(cat <<EOF
  {
    "id": "cred-smtp-gmail-cp5",
    "name": "SMTP Gmail CP5",
    "type": "smtp",
    "data": {
      "user": "$EMAIL_REMETENTE",
      "password": "$GMAIL_APP_PASSWORD",
      "host": "smtp.gmail.com",
      "port": 465,
      "secure": true,
      "disableStartTls": false,
      "hostName": ""
    }
  }
EOF
)")
else
  echo "Gmail: EMAIL_REMETENTE ou GMAIL_APP_PASSWORD vazio, pulando."
fi

if [ -n "$TRELLO_API_KEY" ] && [ -n "$TRELLO_TOKEN" ]; then
  itens+=("$(cat <<EOF
  {
    "id": "cred-trello-cp5",
    "name": "Trello CP5",
    "type": "trelloApi",
    "data": { "apiKey": "$TRELLO_API_KEY", "apiToken": "$TRELLO_TOKEN", "oauthSecret": "" }
  }
EOF
)")
else
  echo "Trello: TRELLO_API_KEY ou TRELLO_TOKEN vazio, pulando."
fi

if [ "${#itens[@]}" -eq 0 ]; then
  echo "Nenhuma credencial para importar." >&2
  exit 1
fi

{
  echo "["
  for i in "${!itens[@]}"; do
    [ "$i" -gt 0 ] && echo ","
    echo "${itens[$i]}"
  done
  echo "]"
} > "$SAIDA"

ORIGEM="$(cygpath -w "$SAIDA" 2>/dev/null || echo "$SAIDA")"   # Git Bash: caminho no formato Windows
MSYS_NO_PATHCONV=1 docker cp "$ORIGEM" cp5_n8n:/tmp/integracoes_cp5.json
MSYS_NO_PATHCONV=1 docker exec cp5_n8n n8n import:credentials --input=/tmp/integracoes_cp5.json
MSYS_NO_PATHCONV=1 docker exec -u root cp5_n8n rm -f /tmp/integracoes_cp5.json
rm -f "$SAIDA"
echo "${#itens[@]} credencial(is) de integração importada(s) no n8n."
