#!/usr/bin/env node
// Smoke test da tool WF-40 (n8n/workflows/wf40_tool_historico.json), ticket T09.
//
// Node 24, fetch nativo, sem dependências externas. Usa `docker exec` (via
// child_process) para:
//   - rodar db/cenarios/reset_estavel.sql e db/cenarios/tendencia_alta.sql
//     (os mesmos scripts que o WF-90/T04 usam para semear cenários),
//   - chamar CALL consultar_historico(...) diretamente no MySQL, como
//     conferência independente do resultado da tool.
// Chama o webhook de TESTE do WF-40 (`/cp5/tool-historico-teste`, documentado
// no próprio workflow como "só teste") em vez de precisar de um AI Agent no
// meio -- ele passa pelo EXATO mesmo caminho (Validar Entrada -> MySQL ->
// Formatar) que o toolWorkflow usaria a partir de T11.
//
// Uso: node tests/smoke_tool_historico.js
// Pré-requisitos: infra rodando (docker compose up -d), wf40_tool_historico
// importado e publicado (n8n/import.sh).
//
// Ao final, restaura a linha de base (reset_estavel.sql) -- os cenários
// tocam só a janela de 130 min de MOTOR_01, igual ao que o WF-90 faria.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = 'http://localhost:5678';
const WEBHOOK_URL = `${BASE_URL}/webhook/cp5/tool-historico-teste`;
const MYSQL_CONTAINER = 'cp5_mysql';

// ---------------------------------------------------------------------------
// Config lida de infra/.env (nunca hardcode credenciais no script)
// ---------------------------------------------------------------------------
function readEnvFile(p) {
  const txt = fs.readFileSync(p, 'utf8');
  const env = {};
  for (const line of txt.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const ENV = readEnvFile(path.join(ROOT, 'infra', '.env'));

// ---------------------------------------------------------------------------
// Helpers MySQL via docker exec (mysql client dentro do container cp5_mysql)
// ---------------------------------------------------------------------------
function mysqlRun(sql) {
  const res = spawnSync(
    'docker',
    [
      'exec', '-i', MYSQL_CONTAINER,
      'mysql',
      `-u${ENV.MYSQL_USER}`,
      `-p${ENV.MYSQL_PASSWORD}`,
      '--default-character-set=utf8mb4',
      '-N', '-B', '-r', // -r/--raw: sem isso, o cliente mysql escapa \, \n, \t na saída em modo batch
      ENV.MYSQL_DATABASE,
    ],
    { input: sql, encoding: 'utf8' }
  );
  if (res.status !== 0) {
    throw new Error('mysql falhou: ' + (res.stderr || res.stdout || `exit ${res.status}`));
  }
  return (res.stdout || '').trim();
}

function runSqlFile(relPath) {
  const sql = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  mysqlRun(sql);
}

function sqlStr(v) {
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

/** CALL consultar_historico(...) direto no MySQL, como conferência independente da tool. */
function callProcedureDirect(idMaquina, grandeza, janelaMin) {
  const sql = `CALL consultar_historico(${sqlStr(idMaquina)}, ${sqlStr(grandeza)}, ${Number(janelaMin)});`;
  const out = mysqlRun(sql);
  const linha = out.split('\n').filter(Boolean)[0] || '';
  const cols = linha.split('\t');
  const num = (s) => (s === undefined || s === 'NULL' ? null : Number(s));
  return {
    id_maquina: cols[0],
    grandeza: cols[1],
    janela_min: num(cols[2]),
    amostras: num(cols[3]),
    media: num(cols[4]),
    desvio_padrao: num(cols[5]),
    minimo: num(cols[6]),
    maximo: num(cols[7]),
    primeiro: num(cols[8]),
    ultimo: num(cols[9]),
    variacao_percentual: num(cols[10]),
  };
}

function contarLeituras() {
  return Number(mysqlRun('SELECT COUNT(*) FROM leituras;'));
}

// ---------------------------------------------------------------------------
// Chamada ao webhook de teste do WF-40
// ---------------------------------------------------------------------------
async function chamarTool(payload) {
  const resp = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const status = resp.status;
  const texto = await resp.text();
  let json = null;
  let parseErro = null;
  try {
    json = texto ? JSON.parse(texto) : null;
  } catch (e) {
    parseErro = e.message;
  }
  return { status, json, texto, parseErro };
}

function close(a, b, eps = 0.05) {
  if (a === null || b === null) return a === b;
  return Math.abs(Number(a) - Number(b)) <= eps;
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------
const linhas = [];
let algumaFalha = false;

function registrar(id, ok, detalhe) {
  if (!ok) algumaFalha = true;
  linhas.push({ id, ok, detalhe });
}

async function casoEstavel() {
  runSqlFile('db/cenarios/reset_estavel.sql');

  const { status, json, texto } = await chamarTool({ id_maquina: 'MOTOR_01', grandeza: 'temperatura', janela_min: 120 });
  if (status !== 200 || !json) {
    registrar('ESTAVEL', false, `HTTP ${status}: ${texto.slice(0, 200)}`);
    return;
  }

  const falhas = [];
  if (json.ok !== true) falhas.push(`ok esperado true, obtido ${json.ok}`);
  if (json.tendencia !== 'estavel') falhas.push(`tendencia esperada 'estavel', obtida '${json.tendencia}'`);
  if (!(Math.abs(json.variacao_percentual) < 2)) falhas.push(`|variacao_percentual| esperado < 2, obtido ${json.variacao_percentual}`);
  if (json.amostras !== 24) falhas.push(`amostras esperado 24, obtido ${json.amostras}`);

  // Conferência independente: CALL consultar_historico direto no MySQL.
  const proc = callProcedureDirect('MOTOR_01', 'temperatura', 120);
  if (json.amostras !== proc.amostras) falhas.push(`amostras (${json.amostras}) != CALL consultar_historico (${proc.amostras})`);
  for (const campo of ['media', 'desvio_padrao', 'minimo', 'maximo', 'primeiro', 'ultimo', 'variacao_percentual']) {
    if (!close(json[campo], proc[campo])) {
      falhas.push(`${campo}: tool=${json[campo]} vs procedure=${proc[campo]} (diferença > tolerância)`);
    }
  }

  if (falhas.length) {
    registrar('ESTAVEL', false, falhas.join(' | '));
  } else {
    registrar('ESTAVEL', true, `amostras=${json.amostras} variacao=${json.variacao_percentual}% tendencia=${json.tendencia} (bate com CALL consultar_historico)`);
  }
}

async function casoTendenciaAlta() {
  runSqlFile('db/cenarios/tendencia_alta.sql');

  const { status, json, texto } = await chamarTool({ id_maquina: 'MOTOR_01', grandeza: 'temperatura', janela_min: 120 });
  if (status !== 200 || !json) {
    registrar('TENDENCIA_ALTA', false, `HTTP ${status}: ${texto.slice(0, 200)}`);
    return;
  }

  const falhas = [];
  if (json.ok !== true) falhas.push(`ok esperado true, obtido ${json.ok}`);
  if (!(json.variacao_percentual >= 15)) falhas.push(`variacao_percentual esperado >= 15, obtido ${json.variacao_percentual}`);
  if (json.tendencia !== 'alta') falhas.push(`tendencia esperada 'alta', obtida '${json.tendencia}'`);
  const mencionaLimiar = typeof json.interpretacao === 'string' && /15\s*%/.test(json.interpretacao);
  if (!mencionaLimiar) falhas.push(`interpretacao não menciona o limiar de 15%: "${json.interpretacao}"`);

  if (falhas.length) {
    registrar('TENDENCIA_ALTA', false, falhas.join(' | '));
  } else {
    registrar('TENDENCIA_ALTA', true, `variacao=${json.variacao_percentual}% tendencia=${json.tendencia} interpretacao="${json.interpretacao}"`);
  }
}

async function casoInjecaoGrandeza() {
  const antesLeituras = contarLeituras();
  const { status, json, texto } = await chamarTool({ id_maquina: 'MOTOR_01', grandeza: 'x; DROP TABLE leituras', janela_min: 120 });
  if (status !== 200 || !json) {
    registrar('SQLI_GRANDEZA', false, `HTTP ${status}: ${texto.slice(0, 200)}`);
    return;
  }
  const falhas = [];
  if (json.ok !== false) falhas.push(`ok esperado false, obtido ${json.ok}`);
  let depoisLeituras;
  try {
    depoisLeituras = contarLeituras();
  } catch (e) {
    falhas.push(`tabela leituras não respondeu após o payload malicioso: ${e.message}`);
    depoisLeituras = null;
  }
  if (depoisLeituras !== null && depoisLeituras !== antesLeituras) {
    falhas.push(`contagem de leituras mudou (${antesLeituras} -> ${depoisLeituras}) -- não deveria`);
  }
  if (falhas.length) {
    registrar('SQLI_GRANDEZA', false, falhas.join(' | '));
  } else {
    registrar('SQLI_GRANDEZA', true, `ok=false, tabela leituras intacta (${depoisLeituras} linhas)`);
  }
}

async function casoGrandezaAcentuada() {
  const { status, json, texto } = await chamarTool({ id_maquina: 'MOTOR_01', grandeza: 'Vibração', janela_min: 120 });
  if (status !== 200 || !json) {
    registrar('GRANDEZA_ACENTO', false, `HTTP ${status}: ${texto.slice(0, 200)}`);
    return;
  }
  const falhas = [];
  if (json.ok !== true) falhas.push(`ok esperado true, obtido ${json.ok} (erro: ${json.erro})`);
  if (json.grandeza !== 'vibracao') falhas.push(`grandeza esperada normalizada 'vibracao', obtida '${json.grandeza}'`);
  if (falhas.length) {
    registrar('GRANDEZA_ACENTO', false, falhas.join(' | '));
  } else {
    registrar('GRANDEZA_ACENTO', true, `"Vibração" normalizado para "${json.grandeza}", amostras=${json.amostras}`);
  }
}

async function casoMaquinaDesconhecida() {
  const { status, json, texto } = await chamarTool({ id_maquina: 'MOTOR_99', grandeza: 'temperatura', janela_min: 120 });
  if (status !== 200 || !json) {
    registrar('MAQUINA_DESCONHECIDA', false, `HTTP ${status}: ${texto.slice(0, 200)}`);
    return;
  }
  const falhas = [];
  if (json.ok !== true) falhas.push(`ok esperado true, obtido ${json.ok} (erro: ${json.erro})`);
  if (json.amostras !== 0) falhas.push(`amostras esperado 0, obtido ${json.amostras}`);
  if (falhas.length) {
    registrar('MAQUINA_DESCONHECIDA', false, falhas.join(' | '));
  } else {
    registrar('MAQUINA_DESCONHECIDA', true, `ok=true, amostras=0, sem erro (interpretacao="${json.interpretacao}")`);
  }
}

async function main() {
  await casoEstavel();
  await casoTendenciaAlta();
  await casoInjecaoGrandeza();
  await casoGrandezaAcentuada();
  await casoMaquinaDesconhecida();

  // Restaura a linha de base (mesmo raciocínio do WF-90: sempre volta pro
  // histórico estável depois de rodar um cenário de tendência).
  runSqlFile('db/cenarios/reset_estavel.sql');

  const idW = Math.max(4, ...linhas.map((l) => l.id.length));
  console.log(`${'ID'.padEnd(idW)}  RESULTADO  DETALHE`);
  console.log('-'.repeat(idW + 12 + 60));
  for (const l of linhas) {
    console.log(`${l.id.padEnd(idW)}  ${l.ok ? 'PASS' : 'FAIL'}       ${l.detalhe}`);
  }
  const total = linhas.length;
  const passou = linhas.filter((l) => l.ok).length;
  console.log('-'.repeat(idW + 12 + 60));
  console.log(`${passou}/${total} casos OK`);

  process.exit(algumaFalha ? 1 : 0);
}

main().catch((e) => {
  console.error('Erro fatal no smoke test:', e);
  // Tenta restaurar a linha de base mesmo em caso de erro fatal.
  try { runSqlFile('db/cenarios/reset_estavel.sql'); } catch (e2) { /* ignore */ }
  process.exit(1);
});
