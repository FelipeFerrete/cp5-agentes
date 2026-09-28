-- ============================================================================
--  CP5 — Sistema Multiagente de Manutenção Inteligente
--  Banco: fabrica_iot
--  Evolução do schema.sql da CP2 (vinicola_iot): mesmo estilo (comentários de
--  seção, COMMENT nas colunas, índices compostos (chave, created_at DESC),
--  view de último status, procedure de retenção), agora monitorando MÁQUINAS
--  (motores) em vez do ambiente da adega.
--
--  Idempotência: todo objeto usa IF NOT EXISTS / OR REPLACE / DROP...CREATE,
--  então reaplicar este arquivo sobre um banco já inicializado não falha.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS fabrica_iot
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE fabrica_iot;

-- ----------------------------------------------------------------------------
-- Tabela: maquinas
-- Cadastro dos motores monitorados e seus valores nominais de placa, usados
-- pelo guardrail (config/limiares.json) para calcular desvio_percentual_nominal
-- (tensão) e percentual_nominal (corrente).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS maquinas (
  id_maquina             VARCHAR(32)   NOT NULL COMMENT 'Ex: MOTOR_01. Deve casar com id_maquina_regex de config/limiares.json',
  descricao              VARCHAR(150)  NOT NULL COMMENT 'Ex: Bomba de trasfega',
  local                  VARCHAR(100)           COMMENT 'Ex: Setor de trasfega / Linha de engarrafamento',
  tensao_nominal         DECIMAL(6,2)  NOT NULL COMMENT 'V — usado no guardrail de energia (desvio_percentual_nominal)',
  corrente_nominal       DECIMAL(6,2)  NOT NULL COMMENT 'A — usado no guardrail de energia (percentual_nominal)',
  taxa_producao_nominal  DECIMAL(8,2)          COMMENT 'un/h de referência da placa/linha; informativo — o guardrail de produção usa taxa_producao_esperada do próprio payload, que pode variar por turno',
  ativo                  BOOLEAN       NOT NULL DEFAULT TRUE COMMENT 'FALSE = máquina desativada/em manutenção programada, ainda visível no cadastro',
  created_at             TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id_maquina)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Tabela: leituras
-- Uma linha por mensagem normalizada (MQTT, webhook do harness ou seed de
-- validação). Colunas numéricas são NULLABLE: ausente/inválido/fora da faixa
-- física vira NULL, NUNCA 0 (ver contracts/guardrail.js::validar — é
-- exatamente o defeito "d.temperatura || 0" da CP2 que a CP5 corrige, R10b).
--
-- Decisão de design — FK de id_maquina:
--   O guardrail (contracts/guardrail.js) SEMPRE devolve um id_maquina como
--   string: o valor original se casar com o regex (ex.: "MOTOR_01" ou, se
--   desconhecida, "MOTOR_99"), ou o literal 'ID_INVALIDO' se o campo faltar,
--   não for string ou não casar com o regex (defesa contra prompt injection —
--   ver cenário C09 do golden set). Cenários C06/C09/C10 exigem que a leitura
--   seja gravada mesmo assim (para auditoria e para requer_humano), mas
--   "MOTOR_99" e "ID_INVALIDO" não existem em `maquinas`.
--   Solução adotada: duas colunas.
--     - id_maquina            FK NULLABLE -> maquinas.id_maquina, populada
--       somente quando a máquina é conhecida (validacao.maquina_conhecida).
--       ON DELETE SET NULL: remover uma máquina do cadastro não apaga o
--       histórico, apenas desfaz o vínculo referencial.
--     - id_maquina_recebido   sempre preenchida com a string normalizada
--       (inclusive 'MOTOR_99' ou 'ID_INVALIDO'), sem FK, para auditoria e
--       para as consultas de "máquina desconhecida"/"id inválido".
--   Assim a tabela nunca rejeita uma leitura por FK, e as tools de
--   histórico/tendência (que sempre filtram por máquina conhecida) usam a
--   coluna id_maquina com FK.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leituras (
  id                      BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_maquina              VARCHAR(32)   COMMENT 'FK -> maquinas.id_maquina; NULL se máquina desconhecida ou id inválido',
  id_maquina_recebido     VARCHAR(64)   NOT NULL COMMENT 'Sempre preenchida (inclusive MOTOR_99/ID_INVALIDO); nunca propaga texto livre não sanitizado — ver contracts/guardrail.js',
  ts                      DATETIME      NOT NULL COMMENT 'Timestamp normalizado da leitura (payload.ts ou horário de recepção)',
  msg_id                  BIGINT        COMMENT 'Sequencial da origem (ESP32/simulador), quando presente',
  origem                  ENUM('mqtt','webhook','validacao') NOT NULL,

  -- Grandezas do payload (slide 15). NULL = ausente/tipo inválido/fora da
  -- faixa física (config/limiares.json::faixa_fisica). Nunca default 0.
  temperatura             DECIMAL(6,2)  COMMENT '°C',
  vibracao                DECIMAL(6,2)  COMMENT 'mm/s RMS',
  tensao                  DECIMAL(6,2)  COMMENT 'V',
  corrente                DECIMAL(6,2)  COMMENT 'A',
  fator_potencia          DECIMAL(4,3)  COMMENT '0 a 1',
  taxa_producao           DECIMAL(8,2)  COMMENT 'un/h',
  taxa_producao_esperada  DECIMAL(8,2)  COMMENT 'un/h',
  eficiencia              DECIMAL(6,2)  COMMENT '% = taxa_producao / taxa_producao_esperada * 100; derivado no nó "validar", NULL se qualquer operando faltar',

  validacao               JSON          NOT NULL COMMENT '{ok, campos_ausentes[], tipo_invalido[], fora_faixa_fisica[], id_invalido, maquina_conhecida, campos_extras[]} — ver contracts/leitura.schema.json',
  guardrail_status        ENUM('NORMAL','ATENCAO','CRITICO') NOT NULL COMMENT 'Piso determinístico (guardrail.status), antes do LLM',
  sensor_fault            BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'TRUE se algum campo teve tipo inválido ou ficou fora da faixa física (sensor ruidoso/corrompido)',
  requer_humano           BOOLEAN       NOT NULL DEFAULT FALSE COMMENT 'TRUE se validacao.ok = false (dado ausente/inválido/máquina desconhecida)',
  payload_bruto           JSON          NOT NULL COMMENT 'Payload original recebido, para auditoria/replay',
  created_at              TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_leituras_maquina FOREIGN KEY (id_maquina)
    REFERENCES maquinas (id_maquina) ON DELETE SET NULL ON UPDATE CASCADE,

  -- Índice principal: séries temporais por máquina (tool de histórico, view de tendência)
  INDEX idx_leituras_maquina_ts (id_maquina, ts DESC),
  -- Auditoria de leituras problemáticas (C05, C06, C09, C10)
  INDEX idx_leituras_recebido_ts (id_maquina_recebido, ts DESC),
  INDEX idx_leituras_guardrail (guardrail_status, created_at DESC)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Tabela: decisoes
-- Uma linha por decisão consolidada do Supervisor (contracts/decisao.schema.json).
-- status_final e acoes_previstas são calculados por código (nó "consolidar"),
-- nunca pelo LLM — ver contracts/guardrail.js::consolidar.
-- id_maquina aqui NÃO tem FK: é o mesmo valor sempre-presente do payload
-- normalizado (pode ser MOTOR_99/ID_INVALIDO), mantendo o mesmo raciocínio de
-- "nunca perder o registro por causa de um cadastro ausente" usado em leituras.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisoes (
  id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_leitura        BIGINT UNSIGNED COMMENT 'FK -> leituras.id; NULL se a leitura de origem foi removida pela retenção',
  id_maquina        VARCHAR(32)   NOT NULL COMMENT 'Sem FK — ver comentário acima da tabela',
  status_guardrail  ENUM('NORMAL','ATENCAO','CRITICO') NOT NULL,
  status_llm        ENUM('NORMAL','ATENCAO','CRITICO') COMMENT 'NULL quando o LLM não foi chamado (ex.: sensor_fault) ou falhou',
  status_final      ENUM('NORMAL','ATENCAO','CRITICO') NOT NULL COMMENT 'max(status_llm, status_guardrail); nunca é rebaixado pelo LLM (R9)',
  sensor_fault      BOOLEAN NOT NULL DEFAULT FALSE,
  requer_humano     BOOLEAN NOT NULL DEFAULT FALSE,
  resumo_operador   VARCHAR(500) NOT NULL COMMENT 'Texto curto usado no Telegram',
  justificativa     TEXT NOT NULL COMMENT 'Raciocínio do supervisor, usado no e-mail e no card Trello (até 2000 chars no contrato)',
  pareceres         JSON NOT NULL COMMENT 'Objeto {manutencao, producao, energia}, cada um um especialista.schema.json ou null',
  acoes_previstas   JSON NOT NULL COMMENT 'Array de TELEGRAM/EMAIL/TRELLO — derivado de limiares.json::acoes_por_status',
  modelo            VARCHAR(64) COMMENT 'Nome do modelo LLM usado (GROQ_MODEL_SUPERVISOR), NULL se não chamado',
  latencia_ms       INT UNSIGNED COMMENT 'Tempo total do pipeline de agentes, em ms',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_decisoes_leitura FOREIGN KEY (id_leitura)
    REFERENCES leituras (id) ON DELETE SET NULL ON UPDATE CASCADE,

  INDEX idx_decisoes_maquina_tempo (id_maquina, created_at DESC),
  INDEX idx_decisoes_status_tempo (status_final, created_at DESC)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Tabela: acoes_log
-- Um registro por ação disparada (ou simulada, se DRY_RUN=true) pelo WF-30.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS acoes_log (
  id           BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  id_decisao   BIGINT UNSIGNED NOT NULL COMMENT 'FK -> decisoes.id',
  canal        ENUM('TELEGRAM','EMAIL','TRELLO') NOT NULL,
  dry_run      BOOLEAN NOT NULL DEFAULT TRUE COMMENT 'TRUE = gravado em vez de chamar a API externa (ver infra/.env DRY_RUN)',
  destino      VARCHAR(255) COMMENT 'chat_id / e-mail destino / id da lista Trello, conforme o canal',
  conteudo     TEXT NOT NULL COMMENT 'Mensagem enviada (ou simulada): texto simples, HTML (e-mail) ou JSON serializado (card Trello), conforme o canal',
  sucesso      BOOLEAN NOT NULL DEFAULT TRUE,
  erro         TEXT COMMENT 'Mensagem de erro da API externa, se sucesso = false',
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT fk_acoeslog_decisao FOREIGN KEY (id_decisao)
    REFERENCES decisoes (id) ON DELETE CASCADE ON UPDATE CASCADE,

  INDEX idx_acoeslog_decisao (id_decisao),
  INDEX idx_acoeslog_canal_tempo (canal, created_at DESC)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------------------
-- Tabela: validacoes
-- Resultado do WF-90 (suíte de cenários golden set, ver PLANO_CP5.md §7).
-- Uma linha por (execucao, cenário, rodada).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS validacoes (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  execucao_id   VARCHAR(64)  NOT NULL COMMENT 'Identifica uma rodada completa do WF-90 (ex.: timestamp ISO ou uuid)',
  cenario_id    VARCHAR(16)  NOT NULL COMMENT 'Ex: C01..C10 (tests/cenarios.json)',
  rodada        INT UNSIGNED NOT NULL COMMENT '1..N execuções do mesmo cenário (LLM não determinístico)',
  esperado      JSON NOT NULL,
  obtido        JSON NOT NULL,
  invariantes   JSON NOT NULL COMMENT 'Lista de {nome, passou, detalhe} avaliada pelo WF-90',
  passou        BOOLEAN NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_validacoes_execucao (execucao_id),
  INDEX idx_validacoes_cenario_tempo (cenario_id, created_at DESC)
) ENGINE=InnoDB;

-- ============================================================================
-- View: v_ultimo_status
-- Última leitura + última decisão de cada máquina cadastrada (dashboard de
-- status rápido). Segue o padrão da CP2 (join com MAX(id) por chave).
-- ============================================================================
CREATE OR REPLACE VIEW v_ultimo_status AS
SELECT
  m.id_maquina,
  m.descricao,
  m.local,
  m.ativo,
  l.id                    AS id_leitura,
  l.ts                    AS leitura_ts,
  l.origem,
  l.temperatura, l.vibracao, l.tensao, l.corrente, l.fator_potencia,
  l.taxa_producao, l.taxa_producao_esperada, l.eficiencia,
  l.guardrail_status,
  l.sensor_fault          AS leitura_sensor_fault,
  l.requer_humano         AS leitura_requer_humano,
  d.id                    AS id_decisao,
  d.status_guardrail,
  d.status_llm,
  d.status_final,
  d.requer_humano         AS decisao_requer_humano,
  d.resumo_operador,
  d.justificativa,
  d.acoes_previstas,
  d.created_at            AS decisao_ts
FROM maquinas m
LEFT JOIN (
  SELECT lt.*
  FROM leituras lt
  INNER JOIN (
    SELECT id_maquina, MAX(id) AS max_id
    FROM leituras
    WHERE id_maquina IS NOT NULL
    GROUP BY id_maquina
  ) lm ON lt.id_maquina = lm.id_maquina AND lt.id = lm.max_id
) l ON l.id_maquina = m.id_maquina
LEFT JOIN (
  SELECT dt.*
  FROM decisoes dt
  INNER JOIN (
    SELECT id_maquina, MAX(id) AS max_id
    FROM decisoes
    GROUP BY id_maquina
  ) dm ON dt.id_maquina = dm.id_maquina AND dt.id = dm.max_id
) d ON d.id_maquina = m.id_maquina;

-- ============================================================================
-- View: v_tendencia_2h
-- Formato "longo" (uma linha por id_maquina x grandeza): amostras, média,
-- desvio padrão amostral, primeiro/último valor da janela e variação
-- percentual, sobre leituras dos últimos 120 minutos. Ignora NULLs.
--
-- Definição de variacao_percentual (robusta a ruído de sensor pontual):
--   as amostras da janela (ordenadas por ts) são divididas em 3 terços
--   (NTILE(3)); variacao_percentual = (média do último terço − média do
--   primeiro terço) / média do primeiro terço × 100. Comparar médias de
--   terços em vez de só o primeiro/último ponto absorve ruído/outliers
--   pontuais, mantendo sensibilidade a uma tendência sustentada (é o mesmo
--   raciocínio da procedure consultar_historico, usada pelos agentes para
--   decidir se escalam severidade — config/limiares.json::tendencia).
--
-- Grandezas incluídas: as 5 do enunciado (temperatura, vibracao, corrente,
-- taxa_producao, fator_potencia) + eficiencia (derivada), útil ao
-- especialista de Produção.
-- ============================================================================
CREATE OR REPLACE VIEW v_tendencia_2h AS
WITH base AS (
  SELECT id_maquina, ts, 'temperatura' AS grandeza, temperatura AS valor
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND temperatura IS NOT NULL
  UNION ALL
  SELECT id_maquina, ts, 'vibracao', vibracao
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND vibracao IS NOT NULL
  UNION ALL
  SELECT id_maquina, ts, 'corrente', corrente
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND corrente IS NOT NULL
  UNION ALL
  SELECT id_maquina, ts, 'taxa_producao', taxa_producao
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND taxa_producao IS NOT NULL
  UNION ALL
  SELECT id_maquina, ts, 'fator_potencia', fator_potencia
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND fator_potencia IS NOT NULL
  UNION ALL
  SELECT id_maquina, ts, 'eficiencia', eficiencia
    FROM leituras
    WHERE id_maquina IS NOT NULL AND ts >= NOW() - INTERVAL 120 MINUTE AND eficiencia IS NOT NULL
),
ranked AS (
  SELECT
    b.*,
    ROW_NUMBER() OVER (PARTITION BY id_maquina, grandeza ORDER BY ts ASC)  AS rn_asc,
    ROW_NUMBER() OVER (PARTITION BY id_maquina, grandeza ORDER BY ts DESC) AS rn_desc,
    NTILE(3)     OVER (PARTITION BY id_maquina, grandeza ORDER BY ts ASC)  AS terco
  FROM base b
)
SELECT
  r.id_maquina,
  r.grandeza,
  120                                                    AS janela_min,
  COUNT(*)                                               AS amostras,
  ROUND(AVG(r.valor), 4)                                 AS media,
  ROUND(STDDEV_SAMP(r.valor), 4)                         AS desvio_padrao,
  MIN(r.valor)                                           AS minimo,
  MAX(r.valor)                                           AS maximo,
  MAX(CASE WHEN r.rn_asc = 1 THEN r.valor END)           AS primeiro,
  MAX(CASE WHEN r.rn_desc = 1 THEN r.valor END)          AS ultimo,
  ROUND(
    CASE
      WHEN AVG(CASE WHEN r.terco = 1 THEN r.valor END) IS NULL
        OR AVG(CASE WHEN r.terco = 1 THEN r.valor END) = 0 THEN NULL
      ELSE (AVG(CASE WHEN r.terco = 3 THEN r.valor END) - AVG(CASE WHEN r.terco = 1 THEN r.valor END))
           / AVG(CASE WHEN r.terco = 1 THEN r.valor END) * 100
    END, 4)                                              AS variacao_percentual
FROM ranked r
GROUP BY r.id_maquina, r.grandeza;

-- ============================================================================
-- Procedure: consultar_historico
-- Tool de histórico/tendência dos agentes (WF-40). Mesma definição de
-- variacao_percentual da view v_tendencia_2h, mas parametrizável por janela
-- (não fixa em 120 min) e por uma única grandeza.
--
-- Defesa contra SQL injection: p_grandeza NUNCA entra em SQL dinâmico. É
-- validada contra uma lista fixa (SIGNAL se inválida) e depois usada apenas
-- como valor comparado em CASE WHEN — nunca concatenada a uma string SQL.
-- ============================================================================
DROP PROCEDURE IF EXISTS consultar_historico;

DELIMITER //
CREATE PROCEDURE consultar_historico (
  IN p_id_maquina VARCHAR(32),
  IN p_grandeza   VARCHAR(32),
  IN p_janela_min INT
)
BEGIN
  DECLARE v_grandeza_valida INT DEFAULT 0;

  SELECT p_grandeza IN ('temperatura','vibracao','corrente','taxa_producao','fator_potencia','eficiencia')
    INTO v_grandeza_valida;

  IF v_grandeza_valida = 0 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'grandeza invalida: use temperatura, vibracao, corrente, taxa_producao, fator_potencia ou eficiencia';
  END IF;

  IF p_janela_min IS NULL OR p_janela_min <= 0 THEN
    SET p_janela_min = 120;
  END IF;

  SELECT
    p_id_maquina AS id_maquina,
    p_grandeza   AS grandeza,
    p_janela_min AS janela_min,
    t.amostras,
    t.media,
    t.desvio_padrao,
    t.minimo,
    t.maximo,
    t.primeiro,
    t.ultimo,
    t.variacao_percentual
  FROM (
    SELECT
      COUNT(*)                                          AS amostras,
      ROUND(AVG(s.valor), 4)                             AS media,
      ROUND(STDDEV_SAMP(s.valor), 4)                      AS desvio_padrao,
      MIN(s.valor)                                        AS minimo,
      MAX(s.valor)                                        AS maximo,
      MAX(CASE WHEN s.rn_asc = 1 THEN s.valor END)        AS primeiro,
      MAX(CASE WHEN s.rn_desc = 1 THEN s.valor END)       AS ultimo,
      ROUND(
        CASE
          WHEN AVG(CASE WHEN s.terco = 1 THEN s.valor END) IS NULL
            OR AVG(CASE WHEN s.terco = 1 THEN s.valor END) = 0 THEN NULL
          ELSE (AVG(CASE WHEN s.terco = 3 THEN s.valor END) - AVG(CASE WHEN s.terco = 1 THEN s.valor END))
               / AVG(CASE WHEN s.terco = 1 THEN s.valor END) * 100
        END, 4)                                           AS variacao_percentual
    FROM (
      SELECT
        valor,
        ROW_NUMBER() OVER (ORDER BY ts ASC)  AS rn_asc,
        ROW_NUMBER() OVER (ORDER BY ts DESC) AS rn_desc,
        NTILE(3)     OVER (ORDER BY ts ASC)  AS terco
      FROM (
        SELECT
          ts,
          CASE p_grandeza
            WHEN 'temperatura'    THEN temperatura
            WHEN 'vibracao'       THEN vibracao
            WHEN 'corrente'       THEN corrente
            WHEN 'taxa_producao'  THEN taxa_producao
            WHEN 'fator_potencia' THEN fator_potencia
            WHEN 'eficiencia'     THEN eficiencia
          END AS valor
        FROM leituras
        WHERE id_maquina = p_id_maquina
          AND ts >= NOW() - INTERVAL p_janela_min MINUTE
      ) base
      WHERE valor IS NOT NULL
    ) s
  ) t;
END //
DELIMITER ;

-- Exemplo de uso: CALL consultar_historico('MOTOR_01', 'temperatura', 120);
-- Query SELECT equivalente (para o nó MySQL do n8n, que lida melhor com
-- SELECT parametrizado do que com CALL): ver db/queries/consultar_historico.sql

-- ============================================================================
-- Procedure: limpar_dados_antigos
-- Retenção de dados, no estilo da CP2 (limpar_telemetria_antiga). Ordem de
-- exclusão respeita as FKs: acoes_log -> decisoes -> leituras; validacoes é
-- independente.
-- ============================================================================
DROP PROCEDURE IF EXISTS limpar_dados_antigos;

DELIMITER //
CREATE PROCEDURE limpar_dados_antigos (IN dias_retencao INT)
BEGIN
  DELETE FROM acoes_log
  WHERE created_at < NOW() - INTERVAL dias_retencao DAY;

  DELETE FROM decisoes
  WHERE created_at < NOW() - INTERVAL dias_retencao DAY;

  DELETE FROM leituras
  WHERE created_at < NOW() - INTERVAL dias_retencao DAY;

  DELETE FROM validacoes
  WHERE created_at < NOW() - INTERVAL dias_retencao DAY;
END //
DELIMITER ;

-- Exemplo de uso: CALL limpar_dados_antigos(90);

-- ----------------------------------------------------------------------------
-- Event Scheduler (opcional, igual à CP2): limpeza automática semanal
-- Requer: SET GLOBAL event_scheduler = ON;
-- ----------------------------------------------------------------------------
-- CREATE EVENT IF NOT EXISTS evt_limpeza_semanal
-- ON SCHEDULE EVERY 1 WEEK
-- STARTS CURRENT_TIMESTAMP
-- DO CALL limpar_dados_antigos(90);

-- ============================================================================
-- Permissões do usuário de aplicação (n8n)
-- MYSQL_USER/MYSQL_PASSWORD (infra/.env) já recebem ALL PRIVILEGES em
-- fabrica_iot.* pelo próprio entrypoint da imagem mysql (o usuário é criado
-- ANTES destes scripts rodarem). GRANT EXECUTE explícito abaixo é redundante
-- com ALL PRIVILEGES, mas fica documentado e à prova de futura mudança para
-- um conjunto de privilégios mais restrito.
-- ATENÇÃO: se o nome do usuário mudar em infra/.env (MYSQL_USER), atualize
-- também aqui — este valor não pode ser lido de variável de ambiente dentro
-- de um script .sql executado pelo docker-entrypoint-initdb.d.
-- ============================================================================
GRANT EXECUTE ON fabrica_iot.* TO 'cp5_app'@'%';
FLUSH PRIVILEGES;
