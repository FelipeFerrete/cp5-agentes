#!/usr/bin/env node
/*
 * tests/smoke_pipeline.js — T06/T07 (CP5)
 * =============================================================================
 * Smoke test end-to-end do harness síncrono (WF-01 -> WF-10 -> [WF-30]):
 * para cada cenário do golden set (simulator/cenarios.json), faz um POST em
 * http://localhost:5678/webhook/cp5/avaliar?origem=validacao com o payload
 * EXATO do cenário (inclusive C06b, cujo campo `temperatura` é a string
 * "abc") e compara a decisão devolvida com o bloco `esperado` do cenário:
 *   - status_guardrail            (igualdade exata)
 *   - status_final == status_final_min   (o LLM está desligado — stub — então
 *                                          o piso do guardrail É o final)
 *   - requer_humano               (igualdade exata)
 *   - sensor_fault                (igualdade exata)
 *   - acoes_previstas == acoes    (mesma ordem, mesmo conteúdo)
 * Também valida que a resposta tem todos os campos obrigatórios de
 * contracts/decisao.schema.json (checagem estrutural simples, sem depender
 * de biblioteca de JSON Schema — sem dependências externas, Node 24 puro).
 *
 * Além do golden set, testa 1 caso extra: body de texto cru não-JSON
 * ("isto nao e json") -> espera HTTP 200 com requer_humano=true (nunca
 * derruba o pipeline, nunca inventa dados).
 *
 * Uso:
 *   node tests/smoke_pipeline.js [--base-url http://localhost:5678]
 *
 * Sem dependências além do `fetch` nativo do Node >= 18 (usamos Node 24).
 * Sai com código 0 se tudo passar, 1 caso contrário.
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CENARIOS_PATH = path.join(ROOT, 'simulator', 'cenarios.json');
const DECISAO_SCHEMA_PATH = path.join(ROOT, 'contracts', 'decisao.schema.json');

const argv = process.argv.slice(2);
function getArg(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}
const BASE_URL = getArg('--base-url', 'http://localhost:5678');
// llm=0: caminho determinístico (supervisor LLM desligado), o piso do guardrail é o status final.
const URL = `${BASE_URL}/webhook/cp5/avaliar?origem=validacao&llm=0`;

function carregarJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Checagem estrutural simples contra decisao.schema.json (sem biblioteca de JSON Schema). */
function validarContraDecisaoSchema(decisao, schema) {
  const erros = [];
  for (const campo of schema.required || []) {
    if (!(campo in decisao)) erros.push(`campo obrigatório ausente: ${campo}`);
  }
  const permitidos = new Set(Object.keys(schema.properties || {}));
  if (schema.additionalProperties === false) {
    for (const k of Object.keys(decisao)) {
      if (!permitidos.has(k)) erros.push(`campo não previsto no contrato: ${k}`);
    }
  }
  const statusValidos = new Set(['NORMAL', 'ATENCAO', 'CRITICO']);
  if (!statusValidos.has(decisao.status_guardrail)) erros.push(`status_guardrail inválido: ${decisao.status_guardrail}`);
  if (!statusValidos.has(decisao.status_final)) erros.push(`status_final inválido: ${decisao.status_final}`);
  if (decisao.status_llm !== null && !statusValidos.has(decisao.status_llm)) erros.push(`status_llm inválido: ${decisao.status_llm}`);
  if (typeof decisao.requer_humano !== 'boolean') erros.push('requer_humano não é boolean');
  if (typeof decisao.sensor_fault !== 'boolean') erros.push('sensor_fault não é boolean');
  if (!Array.isArray(decisao.acoes_previstas)) erros.push('acoes_previstas não é array');
  return erros;
}

function arraysIguais(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

async function postCenario(payload, origemQuery) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = typeof payload === 'string'
    ? { 'Content-Type': 'text/plain' }
    : { 'Content-Type': 'application/json' };
  const resp = await fetch(`${BASE_URL}/webhook/cp5/avaliar?origem=${encodeURIComponent(origemQuery)}&llm=0`, {
    method: 'POST',
    headers,
    body,
  });
  const status = resp.status;
  let json = null;
  let parseErro = null;
  const texto = await resp.text();
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch (e) {
    parseErro = e.message;
  }
  return { status, json, texto, parseErro };
}

function compararCenario(cenario, decisao) {
  const falhas = [];
  const esp = cenario.esperado;

  if (decisao.status_guardrail !== esp.status_guardrail) {
    falhas.push(`status_guardrail: esperado ${esp.status_guardrail}, obtido ${decisao.status_guardrail}`);
  }
  if (decisao.status_final !== esp.status_final_min) {
    falhas.push(`status_final: esperado (mínimo) ${esp.status_final_min}, obtido ${decisao.status_final}`);
  }
  if (decisao.requer_humano !== esp.requer_humano) {
    falhas.push(`requer_humano: esperado ${esp.requer_humano}, obtido ${decisao.requer_humano}`);
  }
  if (decisao.sensor_fault !== esp.sensor_fault) {
    falhas.push(`sensor_fault: esperado ${esp.sensor_fault}, obtido ${decisao.sensor_fault}`);
  }
  if (!arraysIguais(decisao.acoes_previstas, esp.acoes)) {
    falhas.push(`acoes_previstas: esperado ${JSON.stringify(esp.acoes)}, obtido ${JSON.stringify(decisao.acoes_previstas)}`);
  }
  return falhas;
}

async function main() {
  const cenariosDoc = carregarJson(CENARIOS_PATH);
  const decisaoSchema = carregarJson(DECISAO_SCHEMA_PATH);
  const linhas = [];
  let algumaFalha = false;

  for (const cenario of cenariosDoc.cenarios) {
    let resultado;
    try {
      resultado = await postCenario(cenario.payload, 'validacao');
    } catch (e) {
      algumaFalha = true;
      linhas.push({ id: cenario.id, ok: false, detalhe: `erro de rede: ${e.message}` });
      continue;
    }

    if (resultado.status !== 200) {
      algumaFalha = true;
      linhas.push({ id: cenario.id, ok: false, detalhe: `HTTP ${resultado.status}: ${resultado.texto.slice(0, 200)}` });
      continue;
    }
    if (!resultado.json) {
      algumaFalha = true;
      linhas.push({ id: cenario.id, ok: false, detalhe: `resposta não é JSON válido: ${resultado.parseErro}` });
      continue;
    }

    const errosSchema = validarContraDecisaoSchema(resultado.json, decisaoSchema);
    const falhasComparacao = compararCenario(cenario, resultado.json);
    const falhas = [...errosSchema, ...falhasComparacao];

    if (falhas.length) {
      algumaFalha = true;
      linhas.push({ id: cenario.id, ok: false, detalhe: falhas.join(' | ') });
    } else {
      linhas.push({ id: cenario.id, ok: true, detalhe: `status_final=${resultado.json.status_final} acoes=${JSON.stringify(resultado.json.acoes_previstas)}` });
    }
  }

  // Caso extra: body de texto cru não-JSON.
  {
    let resultado;
    try {
      resultado = await postCenario('isto nao e json', 'validacao');
    } catch (e) {
      algumaFalha = true;
      linhas.push({ id: 'TEXTO_CRU', ok: false, detalhe: `erro de rede: ${e.message}` });
      resultado = null;
    }
    if (resultado) {
      if (resultado.status !== 200) {
        algumaFalha = true;
        linhas.push({ id: 'TEXTO_CRU', ok: false, detalhe: `HTTP ${resultado.status}: ${resultado.texto.slice(0, 200)}` });
      } else if (!resultado.json) {
        algumaFalha = true;
        linhas.push({ id: 'TEXTO_CRU', ok: false, detalhe: `resposta não é JSON válido: ${resultado.parseErro}` });
      } else if (resultado.json.requer_humano !== true) {
        algumaFalha = true;
        linhas.push({ id: 'TEXTO_CRU', ok: false, detalhe: `requer_humano esperado true, obtido ${resultado.json.requer_humano}` });
      } else {
        linhas.push({ id: 'TEXTO_CRU', ok: true, detalhe: `HTTP 200, requer_humano=true, status_final=${resultado.json.status_final}` });
      }
    }
  }

  // --- Tabela PASS/FAIL ---
  const idW = Math.max(4, ...linhas.map((l) => l.id.length));
  console.log(`${'ID'.padEnd(idW)}  RESULTADO  DETALHE`);
  console.log('-'.repeat(idW + 12 + 60));
  for (const l of linhas) {
    console.log(`${l.id.padEnd(idW)}  ${l.ok ? 'PASS' : 'FAIL'}       ${l.detalhe}`);
  }
  const total = linhas.length;
  const passou = linhas.filter((l) => l.ok).length;
  console.log('-'.repeat(idW + 12 + 60));
  console.log(`${passou}/${total} cenários OK`);

  process.exit(algumaFalha ? 1 : 0);
}

main().catch((e) => {
  console.error('Erro fatal no smoke test:', e);
  process.exit(1);
});
