-- ============================================================================
--  CP5 — Seed: cadastro dos motores monitorados
--  Idempotente: INSERT ... ON DUPLICATE KEY UPDATE (reaplicar não duplica nem falha)
-- ============================================================================
USE fabrica_iot;

INSERT INTO maquinas (id_maquina, descricao, local, tensao_nominal, corrente_nominal, taxa_producao_nominal, ativo)
VALUES
  ('MOTOR_01', 'Bomba de trasfega', 'Setor de trasfega', 220.00, 15.00, 60.00, TRUE),
  ('MOTOR_02', 'Motor da engarrafadora', 'Linha de engarrafamento', 220.00, 10.00, 120.00, TRUE)
ON DUPLICATE KEY UPDATE
  descricao              = VALUES(descricao),
  local                  = VALUES(local),
  tensao_nominal         = VALUES(tensao_nominal),
  corrente_nominal       = VALUES(corrente_nominal),
  taxa_producao_nominal  = VALUES(taxa_producao_nominal),
  ativo                  = VALUES(ativo);
