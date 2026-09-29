#!/usr/bin/env bash
# Cadastra no n8n as credenciais da infra local (ids fixos usados pelos workflows):
#   cred-mysql-cp5  (MySQL CP5)
#   cred-mqtt-cp5   (Mosquitto CP5)
#
# Os valores vêm de infra/.env; nada passa pelo chat nem vai para o git.
#   bash n8n/credentials/importar_infra.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$RAIZ/infra/.env"
SAIDA="$RAIZ/n8n/credentials/infra_cp5.json"   # ignorado pelo git

ler() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r"'; }

MYSQL_DATABASE="$(ler MYSQL_DATABASE)"
MYSQL_USER="$(ler MYSQL_USER)"
MYSQL_PASSWORD="$(ler MYSQL_PASSWORD)"
MQTT_USER="$(ler MQTT_USER)"
MQTT_PASSWORD="$(ler MQTT_PASSWORD)"

for v in MYSQL_DATABASE MYSQL_USER MYSQL_PASSWORD MQTT_USER MQTT_PASSWORD; do
  if [ -z "${!v}" ]; then echo "$v vazio em infra/.env" >&2; exit 1; fi
done

cat > "$SAIDA" <<EOF
[
  {
    "id": "cred-mysql-cp5",
    "name": "MySQL CP5",
    "type": "mySql",
    "data": {
      "host": "mysql",
      "database": "$MYSQL_DATABASE",
      "user": "$MYSQL_USER",
      "password": "$MYSQL_PASSWORD",
      "port": 3306,
      "ssl": false
    }
  },
  {
    "id": "cred-mqtt-cp5",
    "name": "Mosquitto CP5",
    "type": "mqtt",
    "data": {
      "protocol": "mqtt",
      "host": "mosquitto",
      "port": 1883,
      "username": "$MQTT_USER",
      "password": "$MQTT_PASSWORD",
      "clean": true,
      "clientId": "",
      "ssl": false
    }
  }
]
EOF

ORIGEM="$(cygpath -w "$SAIDA" 2>/dev/null || echo "$SAIDA")"   # Git Bash: caminho no formato Windows
MSYS_NO_PATHCONV=1 docker cp "$ORIGEM" cp5_n8n:/tmp/infra_cp5.json
MSYS_NO_PATHCONV=1 docker exec cp5_n8n n8n import:credentials --input=/tmp/infra_cp5.json
MSYS_NO_PATHCONV=1 docker exec -u root cp5_n8n rm -f /tmp/infra_cp5.json
rm -f "$SAIDA"
echo "Credenciais cred-mysql-cp5 e cred-mqtt-cp5 importadas no n8n."
