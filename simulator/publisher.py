#!/usr/bin/env python3
"""
publisher.py — T05: Simulador MQTT do CP5.

Publica telemetria de máquinas no formato do slide 15 (payload.schema.json)
nos tópicos `fabrica/{id_maquina}/sensores`, reaproveitando os padrões do
firmware legado da CP2 (CP2-IoT-Vinicula-main/firmware.ino):
  - LWT retido em `fabrica/{id_maquina}/status` com {"status":"offline"}
  - publicação retida de {"status":"online"} ao conectar
  - QoS 1 na telemetria
  - `msg_id` sequencial e `uptime_s` (só nos modos que adicionam "extras")

Modos:
  --cenario C02                 publica um cenário do golden set uma vez
  --todos                       publica todos os cenários, com --intervalo entre eles
  --continuo --maquina MOTOR_01 --perfil {normal,degradando,falha_energia}
                                 publica continuamente com ruído gaussiano
  --raw '<json>'                publica um JSON arbitrário (dado corrompido, etc.)

Ver simulator/README.md para exemplos completos.
"""
from __future__ import annotations

import argparse
import json
import os
import random
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SIMULATOR_DIR = Path(__file__).resolve().parent
ROOT_DIR = SIMULATOR_DIR.parent
CENARIOS_PATH = SIMULATOR_DIR / "cenarios.json"
ENV_PATH_DEFAULT = ROOT_DIR / "infra" / ".env"

# Mesma regra de contracts/payload.schema.json e config/limiares.json
# (id_maquina_regex). Um id que não bate com isso não pode virar nível de
# tópico MQTT neste simulador: mesmo que o protocolo MQTT tecnicamente
# permita espaços e pontos num tópico, deixar uma string não validada
# (potencialmente hostil, ver cenário C09 - prompt injection) moldar a
# árvore de tópicos é uma má prática de segurança. Por isso qualquer id
# fora do padrão vira o tópico genérico `fabrica/INVALIDO/...`.
ID_MAQUINA_TOPIC_REGEX = re.compile(r"^[A-Z0-9_]{3,32}$")

TAXA_ESPERADA_PADRAO = {"MOTOR_01": 60, "MOTOR_02": 120}
CORRENTE_NOMINAL = {"MOTOR_01": 15, "MOTOR_02": 10}


# ---------------------------------------------------------------------------
# .env (parser simples, sem dependência)
# ---------------------------------------------------------------------------
def carregar_env_file(caminho: Path) -> dict:
    env = {}
    if not caminho.is_file():
        return env
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, valor = linha.split("=", 1)
        env[chave.strip()] = valor.strip()
    return env


def resolver_credenciais(env_file: Path):
    """Variáveis de ambiente do processo têm prioridade; senão lê infra/.env."""
    arquivo = carregar_env_file(env_file)
    user = os.environ.get("MQTT_USER", arquivo.get("MQTT_USER"))
    password = os.environ.get("MQTT_PASSWORD", arquivo.get("MQTT_PASSWORD"))
    return user, password


# ---------------------------------------------------------------------------
# Tópicos
# ---------------------------------------------------------------------------
def topico_id(id_maquina) -> str:
    if isinstance(id_maquina, str) and ID_MAQUINA_TOPIC_REGEX.match(id_maquina):
        return id_maquina
    return "INVALIDO"


def topico_sensores(id_maquina) -> str:
    return f"fabrica/{topico_id(id_maquina)}/sensores"


def topico_status(id_maquina) -> str:
    return f"fabrica/{topico_id(id_maquina)}/status"


# ---------------------------------------------------------------------------
# Cenários
# ---------------------------------------------------------------------------
def carregar_cenarios() -> dict:
    with CENARIOS_PATH.open(encoding="utf-8") as f:
        return json.load(f)


def buscar_cenario(dados: dict, cenario_id: str) -> dict:
    for c in dados["cenarios"]:
        if c["id"].upper() == cenario_id.upper():
            return c
    disponiveis = ", ".join(c["id"] for c in dados["cenarios"])
    raise SystemExit(f"Cenário '{cenario_id}' não encontrado. Disponíveis: {disponiveis}")


# ---------------------------------------------------------------------------
# Cliente MQTT (paho-mqtt 2.x)
# ---------------------------------------------------------------------------
class Publicador:
    def __init__(self, host: str, port: int, user, password, client_id: str,
                 lwt_id_maquina: str, verbose_connect: bool = True):
        import paho.mqtt.client as mqtt
        self._mqtt = mqtt
        self.host = host
        self.port = port
        self.client = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
            client_id=client_id,
            protocol=mqtt.MQTTv311,
        )
        if user:
            self.client.username_pw_set(user, password)

        self._conectado = False
        self.client.on_connect = self._on_connect
        self.client.on_disconnect = self._on_disconnect

        # LWT: se o processo cair sem desconectar de forma limpa, o broker
        # publica {"status":"offline"} retido — mesmo padrão do firmware CP2.
        will_topic = topico_status(lwt_id_maquina)
        self.client.will_set(
            will_topic, payload=json.dumps({"status": "offline"}), qos=1, retain=True
        )
        self._verbose_connect = verbose_connect
        self._lwt_topic = will_topic

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        self._conectado = (str(reason_code) == "Success" or reason_code == 0)
        if self._verbose_connect:
            status = "OK" if self._conectado else f"FALHA ({reason_code})"
            print(f"[MQTT] Conectado a {self.host}:{self.port} — {status} (LWT em {self._lwt_topic})")

    def _on_disconnect(self, client, userdata, flags=None, reason_code=None, properties=None):
        self._conectado = False

    def conectar(self, timeout=10):
        self.client.connect(self.host, self.port, keepalive=30)
        self.client.loop_start()
        inicio = time.time()
        while not self._conectado and time.time() - inicio < timeout:
            time.sleep(0.05)
        if not self._conectado:
            raise SystemExit(
                f"Não foi possível conectar em {self.host}:{self.port} "
                "(verifique host/porta/credenciais e se o container cp5_mosquitto está de pé)."
            )

    def publicar_online(self, id_maquina):
        info = self.client.publish(
            topico_status(id_maquina), json.dumps({"status": "online"}), qos=1, retain=True
        )
        info.wait_for_publish()

    def publicar_offline(self, id_maquina):
        info = self.client.publish(
            topico_status(id_maquina), json.dumps({"status": "offline"}), qos=1, retain=True
        )
        info.wait_for_publish()

    def publicar_telemetria(self, id_maquina, payload: dict, rotulo: str = ""):
        topico = topico_sensores(id_maquina)
        corpo = json.dumps(payload, ensure_ascii=False)
        info = self.client.publish(topico, corpo, qos=1, retain=False)
        info.wait_for_publish()
        prefixo = f"[{id_maquina}] {rotulo} -> " if rotulo else f"[{id_maquina}] -> "
        print(f"{prefixo}{topico} {corpo}")

    def encerrar(self):
        self.client.loop_stop()
        try:
            self.client.disconnect()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Contador de msg_id / uptime_s (extras estilo CP2)
# ---------------------------------------------------------------------------
class Extras:
    def __init__(self):
        self._msg_id = 0
        self._inicio = time.time()

    def aplicar(self, payload: dict, com_ts: bool = True) -> dict:
        self._msg_id += 1
        novo = dict(payload)
        novo["msg_id"] = self._msg_id
        novo["uptime_s"] = int(time.time() - self._inicio)
        if com_ts:
            novo["ts"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        return novo


# ---------------------------------------------------------------------------
# Perfis do modo contínuo
# ---------------------------------------------------------------------------
def gerar_leitura(maquina: str, perfil: str, iteracao: int) -> dict:
    corrente_nominal = CORRENTE_NOMINAL.get(maquina, 12)
    taxa_esperada = TAXA_ESPERADA_PADRAO.get(maquina, 60)

    if perfil == "normal":
        temperatura = random.gauss(60, 1.5)
        vibracao = max(0.0, random.gauss(2.0, 0.3))
        tensao = random.gauss(220, 2)
        corrente = max(0.0, random.gauss(corrente_nominal, corrente_nominal * 0.05))
        fator_potencia = min(1.0, max(0.0, random.gauss(0.95, 0.01)))
        taxa_producao = max(0.0, random.gauss(taxa_esperada * 0.97, taxa_esperada * 0.03))

    elif perfil == "degradando":
        # Deriva lenta e visível: sobe ~1.2°C e ~0.4mm/s por iteração,
        # cruzando ATENCAO/CRITICO de manutenção ao longo da demo.
        temperatura = 60 + 1.2 * iteracao + random.gauss(0, 0.8)
        vibracao = max(0.0, 2.0 + 0.4 * iteracao + random.gauss(0, 0.15))
        tensao = random.gauss(220, 2)
        corrente = max(0.0, random.gauss(corrente_nominal, corrente_nominal * 0.05))
        fator_potencia = min(1.0, max(0.0, random.gauss(0.95, 0.01)))
        taxa_producao = max(0.0, random.gauss(taxa_esperada * 0.97, taxa_esperada * 0.03))

    elif perfil == "falha_energia":
        temperatura = random.gauss(62, 2)
        vibracao = max(0.0, random.gauss(2.2, 0.3))
        tensao = random.gauss(220, 3)
        # corrente sobe e fator de potência cai ao longo do tempo
        corrente = max(0.0, corrente_nominal * (1.0 + 0.06 * iteracao) + random.gauss(0, 0.3))
        fator_potencia = min(1.0, max(0.05, 0.95 - 0.05 * iteracao + random.gauss(0, 0.01)))
        taxa_producao = max(0.0, random.gauss(taxa_esperada * 0.9, taxa_esperada * 0.05))

    else:
        raise ValueError(f"Perfil desconhecido: {perfil}")

    return {
        "id_maquina": maquina,
        "temperatura": round(temperatura, 2),
        "vibracao": round(vibracao, 2),
        "tensao": round(tensao, 2),
        "corrente": round(corrente, 2),
        "fator_potencia": round(fator_potencia, 4),
        "taxa_producao": round(taxa_producao, 2),
        "taxa_producao_esperada": taxa_esperada,
    }


# ---------------------------------------------------------------------------
# Validação opcional contra o schema (jsonschema, se instalado)
# ---------------------------------------------------------------------------
def carregar_validador_schema():
    try:
        import jsonschema
    except ImportError:
        return None
    schema_path = ROOT_DIR / "contracts" / "payload.schema.json"
    with schema_path.open(encoding="utf-8") as f:
        schema = json.load(f)
    return lambda payload: jsonschema.validate(instance=payload, schema=schema)


def validar_se_possivel(payload: dict, validador):
    if validador is None:
        print("[validar] jsonschema não instalado no venv — pulando autovalidação.")
        return
    try:
        validador(payload)
        print(f"[validar] OK contra payload.schema.json: {payload.get('id_maquina')}")
    except Exception as e:
        print(f"[validar] FALHOU contra payload.schema.json ({payload.get('id_maquina')}): {e}")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def construir_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="Simulador MQTT do CP5 — publica telemetria de máquinas (payload do slide 15).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    p.add_argument("--host", default=os.environ.get("MQTT_HOST", "localhost"), help="Host do broker Mosquitto.")
    p.add_argument("--port", type=int, default=int(os.environ.get("MQTT_PORT", "1883")), help="Porta do broker.")
    p.add_argument("--env-file", default=str(ENV_PATH_DEFAULT), help="Caminho do .env com MQTT_USER/MQTT_PASSWORD.")

    modo = p.add_mutually_exclusive_group(required=True)
    modo.add_argument("--cenario", metavar="ID", help="Publica um cenário do golden set (ex.: C02) uma vez.")
    modo.add_argument("--todos", action="store_true", help="Publica todos os cenários do golden set em sequência.")
    modo.add_argument("--continuo", action="store_true", help="Publica continuamente com ruído/deriva.")
    modo.add_argument("--raw", metavar="JSON", help="Publica um JSON arbitrário (para testes de dado corrompido).")

    p.add_argument("--intervalo", type=float, default=5.0, help="Segundos entre publicações (--todos e --continuo).")
    p.add_argument("--maquina", default="MOTOR_01", choices=["MOTOR_01", "MOTOR_02"],
                    help="Máquina simulada no modo --continuo.")
    p.add_argument("--perfil", default="normal", choices=["normal", "degradando", "falha_energia"],
                    help="Perfil de deriva no modo --continuo.")
    p.add_argument("--raw-topico", default=None,
                    help="Tópico explícito para --raw (default: deriva de id_maquina no JSON, ou fabrica/INVALIDO/sensores).")

    p.add_argument(
        "--sem-extras", action=argparse.BooleanOptionalAction, default=None,
        help="Publica o payload do golden set exatamente como definido, sem msg_id/uptime_s/ts "
             "(default: ligado para --cenario/--todos; use --no-sem-extras para adicionar os extras mesmo assim).",
    )
    p.add_argument("--validar", action="store_true",
                    help="Autovalida cada payload contra contracts/payload.schema.json antes de publicar (requer jsonschema).")
    return p


def main(argv=None):
    args = construir_parser().parse_args(argv)

    if args.cenario or args.todos:
        sem_extras = True if args.sem_extras is None else args.sem_extras
    else:
        sem_extras = False if args.sem_extras is None else args.sem_extras

    user, password = resolver_credenciais(Path(args.env_file))
    if not user:
        print("[aviso] MQTT_USER não encontrado (env ou infra/.env) — conectando sem autenticação.")

    validador = carregar_validador_schema() if args.validar else None
    extras = Extras()

    # --- modo --raw --------------------------------------------------------
    if args.raw is not None:
        try:
            payload = json.loads(args.raw)
        except json.JSONDecodeError as e:
            raise SystemExit(f"--raw não é um JSON válido: {e}")
        id_para_lwt = payload.get("id_maquina") if isinstance(payload, dict) else None
        pub = Publicador(args.host, args.port, user, password, "cp5-sim-raw",
                          lwt_id_maquina=id_para_lwt or "SIM_RAW")
        pub.conectar()
        pub.publicar_online(id_para_lwt or "SIM_RAW")
        if args.validar:
            validar_se_possivel(payload, validador)
        topico = args.raw_topico or topico_sensores(id_para_lwt)
        corpo = json.dumps(payload, ensure_ascii=False)
        info = pub.client.publish(topico, corpo, qos=1, retain=False)
        info.wait_for_publish()
        print(f"[RAW] -> {topico} {corpo}")
        time.sleep(0.2)
        pub.encerrar()
        return

    # --- modo --cenario / --todos -------------------------------------------
    if args.cenario or args.todos:
        dados = carregar_cenarios()
        cenarios = [buscar_cenario(dados, args.cenario)] if args.cenario else dados["cenarios"]

        primeiro_id = cenarios[0]["payload"].get("id_maquina", "SIM")
        pub = Publicador(args.host, args.port, user, password, "cp5-sim-golden", lwt_id_maquina=primeiro_id)
        pub.conectar()

        ids_ja_online = set()
        for c in cenarios:
            id_maquina = c["payload"].get("id_maquina", "DESCONHECIDO")
            if id_maquina not in ids_ja_online:
                pub.publicar_online(id_maquina)
                ids_ja_online.add(id_maquina)

            payload = dict(c["payload"]) if sem_extras else extras.aplicar(c["payload"])
            if args.validar:
                validar_se_possivel(payload, validador)
            pub.publicar_telemetria(id_maquina, payload, rotulo=c["id"])

            if len(cenarios) > 1 and c is not cenarios[-1]:
                time.sleep(args.intervalo)

        time.sleep(0.2)
        pub.encerrar()
        return

    # --- modo --continuo -----------------------------------------------------
    if args.continuo:
        maquina = args.maquina
        pub = Publicador(args.host, args.port, user, password, "cp5-sim-continuo", lwt_id_maquina=maquina)
        pub.conectar()
        pub.publicar_online(maquina)
        print(f"[continuo] {maquina} perfil={args.perfil} intervalo={args.intervalo}s — Ctrl+C para encerrar.")

        iteracao = 0
        try:
            while True:
                leitura = gerar_leitura(maquina, args.perfil, iteracao)
                payload = extras.aplicar(leitura)
                if args.validar:
                    validar_se_possivel(payload, validador)
                pub.publicar_telemetria(maquina, payload, rotulo=args.perfil)
                iteracao += 1
                time.sleep(args.intervalo)
        except KeyboardInterrupt:
            print(f"\n[continuo] Ctrl+C recebido — publicando offline retido em {topico_status(maquina)}...")
            pub.publicar_offline(maquina)
            time.sleep(0.2)
            pub.encerrar()
            return


if __name__ == "__main__":
    main()
