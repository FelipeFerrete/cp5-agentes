-- ============================================================================
--  CP5 — Query equivalente à procedure consultar_historico(id_maquina,
--  grandeza, janela_min), para uso direto no nó MySQL do n8n (WF-40), que
--  lida melhor com um SELECT parametrizado (`?`) do que com CALL a uma
--  procedure. Mesma lógica e mesma definição de variacao_percentual da
--  procedure em db/01_schema.sql e da view v_tendencia_2h.
--
--  Consulta UMA grandeza por vez (usa CASE sobre a grandeza, sem SQL
--  dinâmico). O n8n deve validar `grandeza` contra a mesma lista permitida
--  ANTES de montar os parâmetros (ex.: num nó Code, comparando com
--  ['temperatura','vibracao','corrente','taxa_producao','fator_potencia',
--  'eficiencia']) — aqui, se a grandeza não bater com nenhum WHEN, a coluna
--  `valor` fica sempre NULL e a query devolve `amostras = 0` em vez de um
--  erro controlado (diferente da procedure, que usa SIGNAL). Não há risco de
--  injection: `?` é sempre um parâmetro bind, nunca concatenado à string SQL.
--
--  Parâmetros posicionais (`?`), NESTA ORDEM (a grandeza e o id_maquina
--  aparecem repetidos — uma vez para exibição no resultado, outra dentro do
--  CASE/WHERE):
--    1. id_maquina   (exibido no resultado)
--    2. grandeza     (exibido no resultado)
--    3. janela_min   (exibido no resultado)
--    4. grandeza     (usado no CASE que escolhe a coluna)
--    5. id_maquina   (usado no WHERE)
--    6. janela_min   (usado no INTERVAL, em minutos)
--
--  Exemplo (mysql2 / nó MySQL do n8n): parâmetros
--    ['MOTOR_01','temperatura',120,'temperatura','MOTOR_01',120]
-- ============================================================================
SELECT
  t.id_maquina,
  t.grandeza,
  t.janela_min,
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
    ?  AS id_maquina,
    ?  AS grandeza,
    ?  AS janela_min,
    COUNT(*)                                            AS amostras,
    ROUND(AVG(s.valor), 4)                               AS media,
    ROUND(STDDEV_SAMP(s.valor), 4)                        AS desvio_padrao,
    MIN(s.valor)                                          AS minimo,
    MAX(s.valor)                                          AS maximo,
    MAX(CASE WHEN s.rn_asc = 1 THEN s.valor END)          AS primeiro,
    MAX(CASE WHEN s.rn_desc = 1 THEN s.valor END)         AS ultimo,
    ROUND(
      CASE
        WHEN AVG(CASE WHEN s.terco = 1 THEN s.valor END) IS NULL
          OR AVG(CASE WHEN s.terco = 1 THEN s.valor END) = 0 THEN NULL
        ELSE (AVG(CASE WHEN s.terco = 3 THEN s.valor END) - AVG(CASE WHEN s.terco = 1 THEN s.valor END))
             / AVG(CASE WHEN s.terco = 1 THEN s.valor END) * 100
      END, 4)                                             AS variacao_percentual
  FROM (
    SELECT
      valor,
      ROW_NUMBER() OVER (ORDER BY ts ASC)  AS rn_asc,
      ROW_NUMBER() OVER (ORDER BY ts DESC) AS rn_desc,
      NTILE(3)     OVER (ORDER BY ts ASC)  AS terco
    FROM (
      SELECT
        ts,
        CASE ?
          WHEN 'temperatura'    THEN temperatura
          WHEN 'vibracao'       THEN vibracao
          WHEN 'corrente'       THEN corrente
          WHEN 'taxa_producao'  THEN taxa_producao
          WHEN 'fator_potencia' THEN fator_potencia
          WHEN 'eficiencia'     THEN eficiencia
        END AS valor
      FROM leituras
      WHERE id_maquina = ?
        AND ts >= NOW() - INTERVAL ? MINUTE
    ) base
    WHERE valor IS NOT NULL
  ) s
) t;
