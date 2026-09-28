/*
 * Guardrail determinístico do CP5 — implementação de referência.
 *
 * Este arquivo é a fonte da verdade da lógica que roda nos nós Code do WF-10
 * ("validar" e "guardrail") e no nó "consolidar". Os nós do n8n copiam estas
 * funções; os testes (guardrail.test.js) garantem o comportamento.
 *
 * Princípio: valor ausente ou inválido vira null e é reportado — nunca 0.
 */

const ORDEM = ['NORMAL', 'ATENCAO', 'CRITICO'];
const ESPECIALISTA_DE = {
  temperatura: 'manutencao', vibracao: 'manutencao',
  tensao: 'energia', corrente: 'energia', fator_potencia: 'energia',
  eficiencia: 'producao',
};

const maxStatus = (...lista) =>
  lista.filter(s => ORDEM.includes(s))
       .reduce((a, b) => (ORDEM.indexOf(b) > ORDEM.indexOf(a) ? b : a), 'NORMAL');

/**
 * Valida e normaliza o payload bruto.
 * @param {object} bruto    payload recebido (MQTT ou webhook)
 * @param {object} limiares conteúdo de config/limiares.json
 * @param {object|null} nominais linha da tabela maquinas (null se desconhecida)
 */
function validar(bruto, limiares, nominais) {
  const payload = (bruto && typeof bruto === 'object' && !Array.isArray(bruto)) ? bruto : {};
  const campos = limiares.campos_obrigatorios.filter(c => c !== 'id_maquina');
  const permitidos = new Set([...limiares.campos_obrigatorios, 'ts', 'msg_id', 'uptime_s']);

  const idBruto = payload.id_maquina;
  const idInvalido = typeof idBruto !== 'string' || !new RegExp(limiares.id_maquina_regex).test(idBruto);

  const valores = {};
  const campos_ausentes = [];
  const tipo_invalido = [];
  const fora_faixa_fisica = [];

  for (const c of campos) {
    const v = payload[c];
    if (v === undefined || v === null || v === '') { campos_ausentes.push(c); valores[c] = null; continue; }
    if (typeof v !== 'number' || !Number.isFinite(v)) { tipo_invalido.push(c); valores[c] = null; continue; }
    const f = limiares.faixa_fisica[c];
    if (f && (v < f.min || v > f.max)) { fora_faixa_fisica.push(c); valores[c] = null; continue; }
    valores[c] = v;
  }

  valores.eficiencia = (valores.taxa_producao !== null && valores.taxa_producao_esperada)
    ? round2(valores.taxa_producao / valores.taxa_producao_esperada * 100)
    : null;

  const maquina_conhecida = !!nominais;
  const validacao = {
    ok: !idInvalido && maquina_conhecida && !campos_ausentes.length && !tipo_invalido.length && !fora_faixa_fisica.length,
    campos_ausentes, tipo_invalido, fora_faixa_fisica,
    id_invalido: idInvalido,
    maquina_conhecida,
    campos_extras: Object.keys(payload).filter(k => !permitidos.has(k)),
  };

  return {
    id_leitura: null,
    // id inválido nunca é propagado como texto livre (defesa contra prompt injection)
    id_maquina: idInvalido ? 'ID_INVALIDO' : idBruto,
    ts: typeof payload.ts === 'string' && !isNaN(Date.parse(payload.ts)) ? new Date(payload.ts).toISOString() : new Date().toISOString(),
    msg_id: Number.isInteger(payload.msg_id) ? payload.msg_id : null,
    valores,
    nominais: nominais || null,
    validacao,
  };
}

function classificar(regra, valor, cfg, nominais) {
  let x = valor;
  if (regra === 'desvio_percentual_nominal' || regra === 'percentual_nominal') {
    const nominal = nominais && nominais[cfg.nominal];
    if (!nominal) return { status: null, x: null };
    x = regra === 'desvio_percentual_nominal'
      ? Math.abs(valor - nominal) / nominal * 100
      : valor / nominal * 100;
  }
  const acima = regra !== 'abaixo';
  const passa = (lim) => (acima ? x > lim : x < lim);
  if (passa(cfg.critico)) return { status: 'CRITICO', x: round2(x), limite: cfg.critico };
  if (passa(cfg.atencao)) return { status: 'ATENCAO', x: round2(x), limite: cfg.atencao };
  return { status: 'NORMAL', x: round2(x) };
}

/**
 * Aplica os limiares. Recebe a saída de validar() e devolve o objeto guardrail.
 */
function guardrail(leitura, limiares) {
  const por_especialista = { manutencao: 'NORMAL', producao: 'NORMAL', energia: 'NORMAL' };
  const violacoes = [];

  for (const [esp, def] of Object.entries(limiares.especialistas)) {
    for (const [grandeza, cfg] of Object.entries(def.grandezas)) {
      const v = leitura.valores[grandeza];
      if (v === null || v === undefined) continue;
      const r = classificar(cfg.regra, v, cfg, leitura.nominais);
      if (!r.status) continue;
      por_especialista[esp] = maxStatus(por_especialista[esp], r.status);
      if (r.status !== 'NORMAL') {
        violacoes.push({ especialista: esp, grandeza, valor: r.x, limite: r.limite, status: r.status });
      }
    }
  }

  const val = leitura.validacao;
  const sensor_fault = val.tipo_invalido.length > 0 || val.fora_faixa_fisica.length > 0;
  const requer_humano = !val.ok;
  let status = maxStatus(...Object.values(por_especialista));
  if (requer_humano) status = maxStatus(status, 'ATENCAO');

  return { status, sensor_fault, requer_humano, por_especialista, violacoes };
}

/**
 * Consolida a resposta do Supervisor (LLM) com o guardrail.
 * statusLlm pode ser null (LLM não chamado ou falhou).
 * especialistasRequeremHumano: true se algum parecer veio com dados_insuficientes.
 */
function consolidar(leitura, statusLlm, limiares, especialistasRequeremHumano = false) {
  const g = leitura.guardrail;
  const status_llm = ORDEM.includes(statusLlm) ? statusLlm : null;
  const requer_humano = g.requer_humano || !!especialistasRequeremHumano;
  let status_final = maxStatus(g.status, status_llm);
  if (requer_humano) status_final = maxStatus(status_final, 'ATENCAO');

  let acoes = [...limiares.acoes_por_status[status_final]];
  if (requer_humano) acoes = acoes.filter(a => a !== 'TRELLO');

  return { status_guardrail: g.status, status_llm, status_final, sensor_fault: g.sensor_fault, requer_humano, acoes_previstas: acoes };
}

function round2(n) { return Math.round(n * 100) / 100; }

module.exports = { ORDEM, ESPECIALISTA_DE, maxStatus, validar, guardrail, consolidar };
