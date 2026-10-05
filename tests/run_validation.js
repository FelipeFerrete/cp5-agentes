#!/usr/bin/env node
/*
 * tests/run_validation.js — T13–T15 (CP5)
 * =============================================================================
 * Validação ponta a ponta do sistema multiagente COM o supervisor LLM ligado,
 * sobre o golden set (simulator/cenarios.json) e as invariantes do §7.2 do plano.
 *
 * Para cada cenário e rodada:
 *   1. semeia o histórico de MOTOR_01 (db/cenarios/reset_estavel.sql, ou
 *      tendencia_alta.sql quando o cenário pede). Isso também tira do histórico
 *      as leituras gravadas pelos cenários anteriores, que senão contaminariam
 *      a tendência consultada pelos especialistas;
 *   2. POST /webhook/cp5/avaliar?origem=validacao (WF-01 → WF-10 → WF-30);
 *   3. confere a resposta e o banco (decisoes, acoes_log).
 *
 * Invariantes RÍGIDAS (determinísticas, têm de passar 100%):
 *   - status_guardrail igual ao esperado do cenário;
 *   - status_final >= status_guardrail (piso de severidade);
 *   - situacao (NORMAL/ALERTA), problemas e acoes_previstas iguais aos da implementação de
 *     referência (contracts/guardrail.js::consolidar) com o status e os pareceres que o LLM devolveu;
 *   - requer_humano e sensor_fault iguais ao esperado;
 *   - campos obrigatórios de contracts/decisao.schema.json presentes;
 *   - decisão persistida em `decisoes` com o id da leitura;
 *   - linhas em `acoes_log` = acoes_previstas (DRY_RUN=true).
 * Invariantes FLEXÍVEIS (LLM não determinístico; maioria das rodadas):
 *   - status_llm igual ao esperado (C02, C03, C04, C07);
 *   - recomendação presente;
 *   - especialista certo aponta a causa-raiz (status >= ATENCAO na área);
 *   - números citados no resumo_operador existem na entrada, nos limiares,
 *     nos nominais ou nos pareceres (checagem anti-alucinação).
 *
 * Uso:
 *   node tests/run_validation.js [--rodadas 1] [--intervalo 20] [--cenarios C01,C07]
 *                                [--base-url http://localhost:5678]
 * Gera docs/evidencias/relatorio_validacao.md e tests/relatorios/validacao_<ts>.json.
 * Sai com 0 se todas as invariantes rígidas passarem.
 *
 * Por que um runner externo e não o WF-90 dentro do n8n: mesmas asserções,
 * sem gastar um workflow extra com o limite de tokens do Groq e com a
 * semeadura de histórico (SQL multi-statement) mais simples via docker exec.
 * Sem dependências além do Node 24 e do Docker.
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const cenariosArq = require(path.join(ROOT, 'simulator', 'cenarios.json'));
const limiares = require(path.join(ROOT, 'config', 'limiares.json'));
const decisaoSchema = require(path.join(ROOT, 'contracts', 'decisao.schema.json'));
const { validar, guardrail, consolidar } = require(path.join(ROOT, 'contracts', 'guardrail.js'));

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE_URL = arg('--base-url', 'http://localhost:5678');
const RODADAS = Number(arg('--rodadas', '1'));
const INTERVALO_S = Number(arg('--intervalo', '20'));
const FILTRO = arg('--cenarios', null);

const ORDEM = ['NORMAL', 'ATENCAO', 'CRITICO'];
const rank = (s) => ORDEM.indexOf(s);

// Área que deve apontar a causa-raiz (flexível).
const CAUSA_RAIZ = { C02: ['manutencao', 'energia'], C03: ['energia'], C04: ['producao'], C07: ['manutencao'], C08: ['manutencao'], C11: ['manutencao'] };

const dormir = (s) => new Promise((r) => setTimeout(r, s * 1000));

/** SQL no container: a senha fica no ambiente do próprio container (nunca passa por aqui). */
function sql(texto) {
  return execFileSync('docker', ['exec', '-i', 'cp5_mysql', 'sh', '-c',
    'mysql -N -B -uroot -p"$MYSQL_ROOT_PASSWORD" fabrica_iot 2>/dev/null'], { input: texto, encoding: 'utf8' });
}
function semear(historico) {
  const arq = historico === 'tendencia_alta' ? 'tendencia_alta.sql' : 'reset_estavel.sql';
  sql(fs.readFileSync(path.join(ROOT, 'db', 'cenarios', arq), 'utf8'));
}

/** Números "rastreáveis": tudo que aparece na entrada, limiares, nominais e pareceres. */
function numerosDe(obj) {
  const s = JSON.stringify(obj);
  return new Set((s.match(/-?\d+(?:\.\d+)?/g) || []).map(Number));
}
function numerosNaoRastreaveis(texto, fontes) {
  const conhecidos = numerosDe(fontes);
  const citados = (String(texto).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => Number(n.replace(',', '.')));
  return citados.filter((n) => {
    if (n === 0) return false;
    if (conhecidos.has(n)) return false;
    // tolera arredondamento (ex.: 123.33 % citado como 123 %)
    for (const k of conhecidos) if (Math.abs(k - n) <= 0.5 + Math.abs(k) * 0.01) return false;
    return true;
  });
}

async function avaliar(payload) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE_URL}/webhook/cp5/avaliar?origem=validacao`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  const texto = await resp.text();
  let json = null;
  try { json = JSON.parse(texto); } catch (e) { /* fica null */ }
  return { http: resp.status, json, texto, ms: Date.now() - t0 };
}

function checar(c, r) {
  const d = r.json;
  const esp = c.esperado;
  const rig = [];
  const flex = [];
  const add = (lista, nome, ok, det) => lista.push({ nome, ok: !!ok, det: det || '' });

  if (r.http !== 200 || !d) {
    add(rig, 'resposta HTTP 200 com JSON', false, `HTTP ${r.http}: ${String(r.texto).slice(0, 200)}`);
    return { rig, flex };
  }

  add(rig, 'status_guardrail', d.status_guardrail === esp.status_guardrail, `${d.status_guardrail} (esperado ${esp.status_guardrail})`);
  add(rig, 'piso: status_final >= status_guardrail', rank(d.status_final) >= rank(d.status_guardrail), `${d.status_final} >= ${d.status_guardrail}`);
  add(rig, 'status_final >= status_final_min', rank(d.status_final) >= rank(esp.status_final_min), `${d.status_final} >= ${esp.status_final_min}`);
  // Referência: a mesma consolidar() dos testes, com o status e os pareceres que o LLM devolveu.
  const nom = cenariosArq.maquinas_nominais[c.payload.id_maquina];
  const ref = validar(c.payload, limiares, nom ? { tensao_nominal: nom.tensao_nominal, corrente_nominal: nom.corrente_nominal } : null);
  ref.guardrail = guardrail(ref, limiares);
  const pareceres = d.especialistas || {};
  const dadosInsuf = Object.values(pareceres).some((p) => p && p.dados_insuficientes === true);
  const rf = consolidar(ref, d.status_llm, limiares, dadosInsuf, pareceres);
  add(rig, 'situação NORMAL/ALERTA', d.situacao === rf.situacao, `${d.situacao} (esperado ${rf.situacao})`);
  add(rig, 'problemas identificados', JSON.stringify((d.problemas || []).map((p) => p.descricao)) === JSON.stringify(rf.problemas.map((p) => p.descricao)), JSON.stringify((d.problemas || []).map((p) => p.descricao)));
  add(rig, 'ações por tipo de problema', JSON.stringify(d.acoes_previstas) === JSON.stringify(rf.acoes_previstas), `${JSON.stringify(d.acoes_previstas)} (esperado ${JSON.stringify(rf.acoes_previstas)})`);
  add(rig, 'recomendação presente', typeof d.recomendacao === 'string' && d.recomendacao.trim().length > 0, d.recomendacao);
  add(rig, 'requer_humano', d.requer_humano === esp.requer_humano, String(d.requer_humano));
  add(rig, 'sensor_fault', d.sensor_fault === esp.sensor_fault, String(d.sensor_fault));
  if (esp.requer_humano) add(rig, 'dado duvidoso não abre card Trello', !(d.acoes_previstas || []).includes('TRELLO'));
  const faltando = decisaoSchema.required.filter((k) => !(k in d));
  const extras = Object.keys(d).filter((k) => !(k in decisaoSchema.properties));
  add(rig, 'campos do decisao.schema.json', !faltando.length && !extras.length, [faltando.length ? `faltam ${faltando}` : '', extras.length ? `extras ${extras}` : ''].join(' '));

  if (d.id_decisao) {
    const linha = sql(`SELECT IFNULL(id_leitura,'NULL'), status_final FROM decisoes WHERE id = ${Number(d.id_decisao)};`).trim();
    const [idLeitura, stFinal] = linha.split('\t');
    add(rig, 'decisão persistida com id da leitura', linha && String(idLeitura) === String(d.id_leitura) && stFinal === d.status_final, `decisoes#${d.id_decisao} → leitura ${idLeitura}`);
    const canais = sql(`SELECT canal FROM acoes_log WHERE id_decisao = ${Number(d.id_decisao)} ORDER BY canal;`).trim().split('\n').filter(Boolean);
    add(rig, 'acoes_log = ações previstas', JSON.stringify([...canais].sort()) === JSON.stringify([...d.acoes_previstas].sort()), JSON.stringify(canais));
  } else {
    add(rig, 'decisão persistida com id da leitura', false, 'id_decisao ausente');
  }

  const llmEsp = esp.status_llm_esperado;
  if (llmEsp) add(flex, 'status_llm esperado', d.status_llm === llmEsp, `${d.status_llm} (esperado ${llmEsp})`);
  for (const area of CAUSA_RAIZ[c.id] || []) {
    const p = d.especialistas && d.especialistas[area];
    add(flex, `causa-raiz em ${area}`, p && rank(p.status) >= 1, p ? p.status : 'parecer null');
  }
  if (d.status_llm) {
    const fontes = [c.payload, limiares, cenariosArq.maquinas_nominais, d.especialistas, d.id_maquina];
    const soltos = numerosNaoRastreaveis(d.resumo_operador.replace(/MOTOR_\d+/g, ''), fontes);
    add(flex, 'resumo cita só números rastreáveis', !soltos.length, soltos.length ? `não rastreados: ${soltos.join(', ')}` : 'ok');
  }
  return { rig, flex };
}

async function main() {
  let cenarios = cenariosArq.cenarios;
  if (FILTRO) cenarios = cenarios.filter((c) => FILTRO.split(',').includes(c.id));
  const resultados = [];
  const inicio = new Date();
  let primeiro = true;

  for (const c of cenarios) {
    for (let rodada = 1; rodada <= RODADAS; rodada += 1) {
      if (!primeiro && INTERVALO_S > 0) await dormir(INTERVALO_S);
      primeiro = false;
      semear(c.historico);
      const r = await avaliar(c.payload);
      const { rig, flex } = checar(c, r);
      const d = r.json || {};
      const okRig = rig.every((x) => x.ok);
      resultados.push({ id: c.id, nome: c.descricao, rodada, ms: r.ms, okRig, rig, flex,
        decisao: { situacao: d.situacao, problemas: (d.problemas || []).map((p) => p.descricao), recomendacao: d.recomendacao, status_guardrail: d.status_guardrail, status_llm: d.status_llm, status_final: d.status_final,
          requer_humano: d.requer_humano, acoes_previstas: d.acoes_previstas, resumo_operador: d.resumo_operador,
          especialistas: Object.fromEntries(Object.entries(d.especialistas || {}).map(([k, v]) => [k, v && v.status])) } });
      const flexOk = flex.filter((x) => x.ok).length;
      console.log(`${c.id.padEnd(5)} r${rodada}  ${okRig ? 'PASS' : 'FAIL'}  final=${String(d.status_final).padEnd(8)} llm=${String(d.status_llm).padEnd(8)} flex ${flexOk}/${flex.length}  ${(r.ms / 1000).toFixed(0)}s`);
      for (const x of [...rig, ...flex].filter((y) => !y.ok)) console.log(`        ✗ ${x.nome}: ${x.det}`);
    }
  }
  semear('estavel');

  // ---- agregação
  const rigTotal = resultados.flatMap((r) => r.rig);
  const rigOk = rigTotal.filter((x) => x.ok).length;
  const flexPorCenario = {};
  for (const r of resultados) for (const f of r.flex) {
    const k = `${r.id}|${f.nome}`;
    (flexPorCenario[k] = flexPorCenario[k] || []).push(f.ok);
  }
  const flexChaves = Object.keys(flexPorCenario);
  const flexMaioria = flexChaves.filter((k) => flexPorCenario[k].filter(Boolean).length * 2 > flexPorCenario[k].length);

  const linhas = [];
  linhas.push('# Relatório de validação — golden set com supervisor LLM', '');
  linhas.push(`Gerado por \`node tests/run_validation.js --rodadas ${RODADAS}\` em ${inicio.toISOString().slice(0, 16).replace('T', ' ')} (UTC), com \`DRY_RUN=true\`.`, '');
  linhas.push(`- **Invariantes rígidas:** ${rigOk}/${rigTotal.length} (${((rigOk / rigTotal.length) * 100).toFixed(0)} %)`);
  linhas.push(`- **Invariantes flexíveis (maioria das rodadas):** ${flexMaioria.length}/${flexChaves.length} (${flexChaves.length ? ((flexMaioria.length / flexChaves.length) * 100).toFixed(0) : 100} %)`);
  linhas.push(`- Modelos: supervisor \`${process.env.GROQ_MODEL_SUPERVISOR || 'openai/gpt-oss-120b'}\`; especialistas conforme \`infra/.env\`.`, '');
  linhas.push('| Cenário | Rodada | Rígidas | Situação | Guardrail | LLM | Final | Ações | Manut. | Prod. | Energia | Tempo |');
  linhas.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of resultados) {
    const d = r.decisao;
    const e = d.especialistas || {};
    linhas.push(`| ${r.id} | ${r.rodada} | ${r.okRig ? 'PASS' : '**FAIL**'} | ${d.situacao} | ${d.status_guardrail} | ${d.status_llm ?? '—'} | ${d.status_final} | ${(d.acoes_previstas || []).join(' + ') || '—'} | ${e.manutencao ?? '—'} | ${e.producao ?? '—'} | ${e.energia ?? '—'} | ${(r.ms / 1000).toFixed(0)} s |`);
  }
  linhas.push('', '## Falhas e observações', '');
  const falhas = resultados.flatMap((r) => [...r.rig.map((x) => ({ ...x, tipo: 'rígida' })), ...r.flex.map((x) => ({ ...x, tipo: 'flexível' }))].filter((x) => !x.ok).map((x) => `- ${r.id} r${r.rodada} (${x.tipo}) ${x.nome}: ${x.det}`));
  linhas.push(...(falhas.length ? falhas : ['Nenhuma.']));
  linhas.push('', '## Saída por cenário (primeira rodada)', '');
  for (const r of resultados.filter((x) => x.rodada === 1)) {
    const d = r.decisao;
    linhas.push(`### ${r.id} · ${r.nome}`, '', `- **Situação:** ${d.situacao}`, `- **Problemas identificados:** ${d.problemas.length ? d.problemas.join('; ') : 'nenhum'}`, `- **Recomendação:** ${d.recomendacao}`, `- **Análise do agente:** ${d.resumo_operador}`, '');
  }
  linhas.push('');

  const md = path.join(ROOT, 'docs', 'evidencias', 'relatorio_validacao.md');
  fs.writeFileSync(md, linhas.join('\n'), 'utf8');
  const bruto = path.join(ROOT, 'tests', 'relatorios', `validacao_${inicio.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
  fs.writeFileSync(bruto, JSON.stringify(resultados, null, 2), 'utf8');
  console.log(`\nRígidas ${rigOk}/${rigTotal.length} · flexíveis (maioria) ${flexMaioria.length}/${flexChaves.length}`);
  console.log(`Relatório: ${path.relative(ROOT, md)} · bruto: ${path.relative(ROOT, bruto)}`);
  process.exit(rigOk === rigTotal.length ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
