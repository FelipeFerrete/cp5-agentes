# db — Schema MySQL CP5 (T04)

Evolução do `schema.sql` da CP2 (`vinicola_iot`) para o banco `fabrica_iot`: mesmo
estilo (seções comentadas, `COMMENT` em colunas, índices `(chave, created_at DESC)`,
view de último status, procedure de retenção), agora monitorando **máquinas**
(motores) em vez do ambiente da adega.

## Arquivos (ordem de aplicação)

| Arquivo | Conteúdo |
|---|---|
| `01_schema.sql` | Banco, tabelas, views, procedures, GRANT |
| `02_seed_maquinas.sql` | Cadastro de `MOTOR_01` (bomba de trasfega) e `MOTOR_02` (engarrafadora) |
| `03_seed_historico.sql` | Histórico estável das últimas 2h (24 amostras/5 min) para as duas máquinas |
| `queries/consultar_historico.sql` | Query `SELECT` parametrizada (`?`), equivalente à procedure `consultar_historico`, para o nó MySQL do n8n |
| `cenarios/tendencia_alta.sql` | Reescreve o histórico de `MOTOR_01` com temperatura subindo ~64→75°C (cenário C07 do golden set) |
| `cenarios/reset_estavel.sql` | Restaura `MOTOR_01` ao histórico estável (contrapartida de `tendencia_alta.sql`) |

`docker-entrypoint-initdb.d` executa os arquivos `.sql` da raiz de `db/` em ordem
alfabética (por isso o prefixo numérico); os arquivos dentro de `queries/` e
`cenarios/` **não** são executados automaticamente — são chamados sob demanda
(pelo WF-90, pelo maestro ou manualmente).

## Tabelas

- **`maquinas`** — cadastro e valores nominais de placa (`tensao_nominal`,
  `corrente_nominal`) usados pelo guardrail (`config/limiares.json`) para os
  cálculos `desvio_percentual_nominal` e `percentual_nominal`.
- **`leituras`** — uma linha por mensagem normalizada (MQTT/webhook/validação).
- **`decisoes`** — uma linha por decisão consolidada do Supervisor
  (`contracts/decisao.schema.json`); `pareceres` guarda o objeto
  `{manutencao, producao, energia}`.
- **`acoes_log`** — uma linha por ação disparada (ou simulada, com
  `DRY_RUN=true`) pelo WF-30.
- **`validacoes`** — resultados do WF-90 (golden set), uma linha por
  `(execucao_id, cenario_id, rodada)`.

### Por que as grandezas de `leituras` são `NULL`-áveis (nunca `0`)

A CP2 tinha o defeito `d.temperatura || 0`: um campo ausente virava `0 °C`
silenciosamente, e o consumidor não tinha como distinguir "sensor mediu zero"
de "sensor não respondeu". Isso é exatamente o cenário de "dado corrompido"
que a CP5 precisa tratar (reflexão R10b) — um LLM que recebesse `0` como
temperatura poderia classificar `NORMAL` quando na verdade não há dado algum.
Por isso `temperatura`, `vibracao`, `tensao`, `corrente`, `fator_potencia`,
`taxa_producao`, `taxa_producao_esperada` e `eficiencia` são `NULL`-áveis:
ausência ou invalidez (`contracts/guardrail.js::validar`) grava `NULL` e fica
registrada em `validacao` (`campos_ausentes`, `tipo_invalido`,
`fora_faixa_fisica`), nunca um valor inventado.

### Decisão de design: FK de `id_maquina` em `leituras`

O guardrail sempre devolve uma string para `id_maquina`: o valor original
(ex. `MOTOR_01`, ou `MOTOR_99` se a máquina não está cadastrada), ou o literal
`'ID_INVALIDO'` se o campo faltar, não for string, ou não casar com o regex de
`config/limiares.json` (defesa contra prompt injection — cenário C09). Os
cenários C06/C09/C10 do golden set exigem que a leitura seja **gravada mesmo
assim**, para auditoria e para que `requer_humano` funcione — mas
`'MOTOR_99'` e `'ID_INVALIDO'` não existem (e não devem existir) em
`maquinas`.

Solução: duas colunas em `leituras`.
- `id_maquina` — FK **nullable** para `maquinas.id_maquina`
  (`ON DELETE SET NULL`), preenchida só quando a máquina é conhecida.
- `id_maquina_recebido` — sempre preenchida com a string normalizada (nunca
  `NULL`), sem FK, usada para auditoria e para consultas por "máquina
  desconhecida"/"id inválido".

A tabela `decisoes` segue o mesmo raciocínio para `id_maquina`, mas sem FK
alguma (o valor é sempre uma string presente, possivelmente inválida ou
desconhecida — não há coluna "recebido" separada porque o contrato de decisão
já exige `id_maquina` sempre preenchido).

## Views e tools de histórico

- **`v_ultimo_status`** — última leitura + última decisão de cada máquina
  cadastrada (join por `MAX(id)`, no estilo da CP2).
- **`v_tendencia_2h`** — formato **longo** (uma linha por
  `id_maquina × grandeza`), para `temperatura`, `vibracao`, `corrente`,
  `taxa_producao`, `fator_potencia` e `eficiencia`, sobre os últimos 120 min.
  Ignora `NULL`s.
- **`consultar_historico(id_maquina, grandeza, janela_min)`** — mesma lógica
  da view, mas parametrizável por janela e por uma única grandeza. Valida
  `grandeza` contra uma lista fixa (`SIGNAL` se inválida) e nunca usa SQL
  dinâmico — `grandeza` só é comparada em `CASE WHEN`, nunca concatenada.
  Vira a tool `consultar_historico` dos agentes (WF-40).
- **`queries/consultar_historico.sql`** — a mesma consulta, como `SELECT`
  parametrizado com `?`, para quando for mais simples usar o nó MySQL do n8n
  do que o nó de "Stored Procedure"/`CALL`.

### Definição de `variacao_percentual`

As amostras da janela (ordenadas por `ts`) são divididas em 3 terços
(`NTILE(3)`); `variacao_percentual = (média do último terço − média do
primeiro terço) / média do primeiro terço × 100`. Comparar médias de terços,
em vez de só o primeiro e o último ponto, absorve ruído/outliers pontuais
mantendo sensibilidade a uma tendência sustentada — é o mesmo critério que
`config/limiares.json::tendencia` usa para decidir se um especialista pode
escalar a severidade (cenário C07 do golden set exige ≥ 15%).

## Retenção

`limpar_dados_antigos(dias_retencao)` — apaga em ordem segura para as FKs
(`acoes_log` → `decisoes` → `leituras`; `validacoes` é independente). Exemplo:
`CALL limpar_dados_antigos(90);`

## Como aplicar

Contêiner já em execução (`cp5_mysql`), banco existente:

```bash
MSYS_NO_PATHCONV=1 docker exec -i cp5_mysql \
  mysql -uroot -p"$MYSQL_ROOT_PASSWORD" fabrica_iot < db/01_schema.sql
# repetir para 02_seed_maquinas.sql e 03_seed_historico.sql
```

Todos os scripts são **idempotentes**: `01_schema.sql` usa
`CREATE TABLE IF NOT EXISTS` / `CREATE OR REPLACE VIEW` /
`DROP PROCEDURE IF EXISTS` + `CREATE PROCEDURE`; os seeds e cenários apagam a
própria janela de dados antes de inserir.

Volume novo (init automático): o `docker-compose.yml` já monta `../db` em
`/docker-entrypoint-initdb.d` — os arquivos da raiz de `db/` (não os de
`queries/` e `cenarios/`) rodam automaticamente na primeira subida de um
volume `mysql_data` vazio.

## Riscos / observações

- O `GRANT EXECUTE` no fim de `01_schema.sql` tem o usuário `cp5_app`
  hardcoded (scripts `.sql` do `docker-entrypoint-initdb.d` não recebem
  substituição de variáveis de ambiente). Se `MYSQL_USER` mudar em
  `infra/.env`, atualizar também esse `GRANT`. Na prática é redundante: o
  entrypoint da imagem `mysql` já concede `ALL PRIVILEGES` em `fabrica_iot.*`
  ao usuário de `MYSQL_USER`/`MYSQL_PASSWORD` antes destes scripts rodarem.
- `ts` é `DATETIME` (não `TIMESTAMP`): guarda o horário normalizado do payload
  tal como recebido, sem conversão de fuso na leitura/escrita — evita
  confusão com o `--default-time-zone=-03:00` do servidor, que já afeta
  `NOW()`/`CURRENT_TIMESTAMP` usados nos demais campos `created_at`.
