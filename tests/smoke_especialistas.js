#!/usr/bin/env node
// Smoke test dos 3 especialistas (WF-20 Manutenção, WF-21 Produção, WF-22 Energia), ticket T11.
//
// Node 24, fetch nativo, sem dependências. Monta a leitura LOCALMENTE com
// contracts/guardrail.js (validar + guardrail; nominais lidos da tabela `maquinas`
// via docker exec), no formato de contracts/leitura.schema.json
// (origem "validacao", id_leitura null), e chama o webhook de TESTE de cada
// especialista: POST /webhook/cp5/especialista-teste/<area>
// com corpo { leitura, pergunta }.
//
// Asserções por caso: parecer não nulo; valida contra contracts/especialista.schema.json
// (validador mínimo local: type, enum, required, additionalProperties, items, maxLength);
// especialista correto; status >= piso do guardrail; meta.valores_nao_rastreaveis vazio
// (anti-alucinação) e meta.erro nulo; + expectativas específicas do caso.
//
// Rate limit do Groq gratuito: espaça as chamadas (--intervalo, padrão 25 s) e, se o
// especialista devolver erro de 429/limite, espera o tempo sugerido e tenta UMA vez de novo.
//
// Uso:
//   node tests/smoke_especialistas.js [--intervalo 25] [--casos C02-manutencao,C01-energia]
//                                     [--saida caminho.json] [--verbose]
// Pré-requisitos: infra no ar, wf20/21/22 e wf40 importados e publicados (n8n/import.sh),
// chave Groq válida na credencial cred-groq-cp5.
//
// Efeito colateral: o caso C07 semeia db/cenarios/tendencia_alta.sql; ao final (mesmo em
// falha) roda db/cenarios/reset_estavel.sql. Este teste não grava em decisoes/acoes_log.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = 'http://localhost:5678';
const MYSQL_CONTAINER = 'cp5_mysql';
const ORDEM = ['NORMAL', 'ATENCAO', 'CRITICO'];

const { validar, guardrail } = require(path.join(ROOT, 'contracts', 'guardrail.js'));
const LIMIARES = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'limiares.json'), 'utf8'));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'especialista.schema.json'), 'utf8'));
const CENARIOS = JSON.parse(fs.readFileSync(path.join(ROOT, 'simulator', 'cenarios.json'), 'utf8')).cenarios;

// ---------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------
function argVal(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : padrao;
}
const INTERVALO_S = Number(argVal('--intervalo', '25'));
const FILTRO = argVal('--casos', '') ? argVal('--casos', '').split(',') : null;
const SAIDA = argVal('--saida', '');
const VERBOSE = process.argv.includes('--verbose');

// ---------------------------------------------------------------------------
// Config de infra/.env (nunca imprime segredos)
// ---------------------------------------------------------------------------
function readEnvFile(p) {
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const ENV = readEnvFile(path.join(ROOT, 'infra', '.env'));

function mysqlRun(sql) {
  const res = spawnSync(
    'docker',
    ['exec', '-i', MYSQL_CONTAINER, 'mysql', `-u${ENV.MYSQL_USER}`, `-p${ENV.MYSQL_PASSWORD}`,
      '--default-character-set=utf8mb4', '-N', '-B', '-r', ENV.MYSQL_DATABASE],
    { input: sql, encoding: 'utf8' }
  );
  if (res.status !== 0) throw new Error('mysql falhou: ' + (res.stderr || res.stdout || `exit ${res.status}`).replace(ENV.MYSQL_PASSWORD, '***'));
  return (res.stdout || '').trim();
}
function runSqlFile(rel) { mysqlRun(fs.readFileSync(path.join(ROOT, rel), 'utf8')); }

function lerNominais(idMaquina) {
  const out = mysqlRun(`SELECT descricao, tensao_nominal, corrente_nominal FROM maquinas WHERE id_maquina = '${idMaquina.replace(/[^A-Z0-9_]/g, '')}';`);
  if (!out) return null;
  const [descricao, tv, cn] = out.split('\n')[0].split('\t');
  return { descricao, tensao_nominal: Number(tv), corrente_nominal: Number(cn) };
}

// ---------------------------------------------------------------------------
// Monta a leitura no formato de leitura.schema.json
// ---------------------------------------------------------------------------
function montarLeitura(payload) {
  const idOk = typeof payload.id_maquina === 'string' && /^[A-Z0-9_]{3,32}$/.test(payload.id_maquina);
  const nominais = idOk ? lerNominais(payload.id_maquina) : null;
  const l = validar(payload, LIMIARES, nominais);
  l.origem = 'validacao';
  l.id_leitura = null;
  l.guardrail = guardrail(l, LIMIARES);
  return l;
}

// ---------------------------------------------------------------------------
// Validador JSON Schema mínimo (o subconjunto usado em especialista.schema.json)
// ---------------------------------------------------------------------------
function tipoDe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v; // string, boolean, object
}
function tipoConfere(v, t) {
  const real = tipoDe(v);
  return real === t || (t === 'number' && real === 'integer');
}
function validarSchema(valor, schema, caminho, erros) {
  if (schema.enum && !schema.enum.includes(valor)) { erros.push(`${caminho}: valor ${JSON.stringify(valor)} fora do enum ${JSON.stringify(schema.enum)}`); return; }
  if (schema.type) {
    const tipos = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!tipos.some((t) => tipoConfere(valor, t))) { erros.push(`${caminho}: tipo ${tipoDe(valor)} não está em ${JSON.stringify(tipos)}`); return; }
  }
  if (typeof valor === 'string' && schema.maxLength !== undefined && valor.length > schema.maxLength) {
    erros.push(`${caminho}: string com ${valor.length} caracteres (máx ${schema.maxLength})`);
  }
  if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
    for (const r of schema.required || []) if (!(r in valor)) erros.push(`${caminho}: campo obrigatório ausente: ${r}`);
    const props = schema.properties || {};
    if (schema.additionalProperties === false) {
      for (const k of Object.keys(valor)) if (!(k in props)) erros.push(`${caminho}: campo não permitido: ${k}`);
    }
    for (const [k, s] of Object.entries(props)) if (k in valor) validarSchema(valor[k], s, `${caminho}.${k}`, erros);
  }
  if (Array.isArray(valor) && schema.items) valor.forEach((x, i) => validarSchema(x, schema.items, `${caminho}[${i}]`, erros));
}

// ---------------------------------------------------------------------------
// Chamada ao webhook com tratamento de 429
// ---------------------------------------------------------------------------
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

function ehRateLimit(saida) {
  const msg = saida && saida.meta && saida.meta.erro ? String(saida.meta.erro) : '';
  return /429|rate.?limit|too many requests|tokens per minute|TPM/i.test(msg);
}
function esperaSugeridaMs(msg) {
  const m = String(msg).match(/try again in\s+(?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) return Math.ceil(((Number(m[1] || 0) * 60) + Number(m[2])) * 1000) + 2000;
  return 45000;
}

async function chamar(area, leitura, pergunta) {
  const t0 = Date.now();
  const resp = await fetch(`${BASE_URL}/webhook/cp5/especialista-teste/${area}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ leitura, pergunta }),
  });
  const texto = await resp.text();
  let json = null;
  try { json = texto ? JSON.parse(texto) : null; } catch (e) { /* mantém null */ }
  return { status: resp.status, json, texto, ms: Date.now() - t0 };
}

async function chamarComRetry(area, leitura, pergunta) {
  let r = await chamar(area, leitura, pergunta);
  let tentativas = 1;
  if (r.json && ehRateLimit(r.json)) {
    const espera = esperaSugeridaMs(r.json.meta.erro);
    console.log(`   [429] ${area}: aguardando ${Math.round(espera / 1000)} s e tentando de novo...`);
    await dormir(espera);
    r = await chamar(area, leitura, pergunta);
    tentativas = 2;
  }
  r.tentativas = tentativas;
  return r;
}

// ---------------------------------------------------------------------------
// Casos
// ---------------------------------------------------------------------------
const cen = (id) => CENARIOS.find((c) => c.id === id);
const achado = (p, re) => (p.achados || []).find((a) => re.test(a.grandeza));

const CASOS = [
  {
    id: 'C02-manutencao', cenario: 'C02', area: 'manutencao',
    esp(p) {
      const f = [];
      if (p.status !== 'CRITICO') f.push(`status esperado CRITICO, obtido ${p.status}`);
      const t = achado(p, /temperatura/i), v = achado(p, /vibra/i);
      if (!t || t.valor !== 86.5) f.push(`achado de temperatura com valor 86.5 ausente (${t ? t.valor : 'sem achado'})`);
      if (!v || v.valor !== 8.2) f.push(`achado de vibração com valor 8.2 ausente (${v ? v.valor : 'sem achado'})`);
      return f;
    },
  },
  {
    id: 'C02-producao', cenario: 'C02', area: 'producao',
    esp(p) {
      const f = [];
      // eficiência 70 % não é < 70: guardrail = ATENCAO (limítrofe). O LLM pode escalar.
      if (ORDEM.indexOf(p.status) < ORDEM.indexOf('ATENCAO')) f.push(`status esperado >= ATENCAO, obtido ${p.status}`);
      const e = achado(p, /efici|taxa|produ/i);
      if (!e) f.push('nenhum achado de eficiência/taxa de produção');
      return f;
    },
  },
  {
    id: 'C02-energia', cenario: 'C02', area: 'energia',
    esp(p) {
      const f = [];
      if (p.status !== 'CRITICO') f.push(`status esperado CRITICO, obtido ${p.status}`);
      const fp = achado(p, /fator|pot/i);
      if (!fp || fp.valor !== 0.62) f.push(`achado de fator de potência com valor 0.62 ausente (${fp ? fp.valor : 'sem achado'})`);
      return f;
    },
  },
  ...['manutencao', 'producao', 'energia'].map((area) => ({
    id: `C01-${area}`, cenario: 'C01', area,
    esp(p) {
      const f = [];
      if (p.status !== 'NORMAL') f.push(`status esperado NORMAL, obtido ${p.status}`);
      if (p.dados_insuficientes !== false) f.push(`dados_insuficientes esperado false, obtido ${p.dados_insuficientes}`);
      return f;
    },
  })),
  {
    id: 'C05-manutencao', cenario: 'C05', area: 'manutencao',
    esp(p) {
      const f = [];
      if (p.dados_insuficientes !== true) f.push(`dados_insuficientes esperado true, obtido ${p.dados_insuficientes}`);
      const v = achado(p, /vibra/i);
      if (!v) f.push('achado de vibração ausente');
      else if (v.valor !== null) f.push(`achado de vibração deveria ter valor null, obtido ${v.valor}`);
      return f;
    },
  },
  {
    id: 'C07-manutencao', cenario: 'C07', area: 'manutencao', seed: 'db/cenarios/tendencia_alta.sql',
    obrigaTool: true,
    esp(p, saida) {
      const f = [];
      if (!p.tendencia) f.push('tendencia deveria estar preenchida');
      else {
        if (!(p.tendencia.variacao_percentual >= 15)) f.push(`tendencia.variacao_percentual esperada >= 15, obtida ${p.tendencia.variacao_percentual}`);
      }
      if (p.status !== 'CRITICO') f.push(`status esperado CRITICO (elevação por tendência), obtido ${p.status}`);
      if (!saida.meta.tool_calls.length) f.push('nenhuma chamada a consultar_historico em intermediateSteps');
      return f;
    },
  },
];

function avaliar(caso, leitura, r) {
  const falhas = [];
  const avisos = [];
  const saida = r.json;
  if (r.status !== 200 || !saida) return { falhas: [`HTTP ${r.status}: ${String(r.texto).slice(0, 300)}`], avisos };
  const meta = saida.meta || {};
  const p = saida.parecer;
  if (!p) return { falhas: [`parecer nulo (meta.erro: ${meta.erro})`], avisos };
  if (saida.area !== caso.area) falhas.push(`area esperada ${caso.area}, obtida ${saida.area}`);

  const errosSchema = [];
  validarSchema(p, SCHEMA, 'parecer', errosSchema);
  if (errosSchema.length) falhas.push('schema: ' + errosSchema.slice(0, 4).join(' | '));

  if (p.especialista !== caso.area) falhas.push(`especialista esperado ${caso.area}, obtido ${p.especialista}`);
  const piso = leitura.guardrail.por_especialista[caso.area];
  if (ORDEM.indexOf(p.status) < ORDEM.indexOf(piso)) falhas.push(`status ${p.status} abaixo do piso ${piso}`);
  if (meta.erro) falhas.push(`meta.erro: ${meta.erro}`);
  if (Array.isArray(meta.valores_nao_rastreaveis) && meta.valores_nao_rastreaveis.length) {
    falhas.push('valores não rastreáveis: ' + JSON.stringify(meta.valores_nao_rastreaveis));
  }
  falhas.push(...caso.esp(p, saida));
  if (!caso.obrigaTool && !(meta.tool_calls || []).length) avisos.push('não chamou consultar_historico');
  if (meta.piso_aplicado) avisos.push('piso aplicado pelo n8n (LLM abaixo do guardrail)');
  return { falhas, avisos };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
async function main() {
  const casos = FILTRO ? CASOS.filter((c) => FILTRO.includes(c.id)) : CASOS;
  const resultados = [];
  const pareceres = {};
  let ultimaChamada = 0;

  try {
    runSqlFile('db/cenarios/reset_estavel.sql'); // base determinística
    for (const caso of casos) {
      const espera = ultimaChamada ? INTERVALO_S * 1000 - (Date.now() - ultimaChamada) : 0;
      if (espera > 0) await dormir(espera);

      if (caso.seed) runSqlFile(caso.seed);
      const payload = cen(caso.cenario).payload;
      const leitura = montarLeitura(payload);
      console.log(`>> ${caso.id} (guardrail ${caso.area}: ${leitura.guardrail.por_especialista[caso.area]})...`);
      ultimaChamada = Date.now();
      let r;
      try {
        r = await chamarComRetry(caso.area, leitura, null);
      } finally {
        if (caso.seed) runSqlFile('db/cenarios/reset_estavel.sql');
      }
      ultimaChamada = Date.now();

      const { falhas, avisos } = avaliar(caso, leitura, r);
      const meta = (r.json && r.json.meta) || {};
      const p = r.json && r.json.parecer;
      resultados.push({
        id: caso.id, ok: falhas.length === 0, falhas, avisos,
        status: p ? p.status : '-', piso: leitura.guardrail.por_especialista[caso.area],
        conf: p ? p.confianca : '-', tools: (meta.tool_calls || []).length,
        lat: meta.latencia_ms ?? null, wall: r.ms, tentativas: r.tentativas,
      });
      pareceres[caso.id] = r.json;
      if (VERBOSE) console.log(JSON.stringify(r.json, null, 2));
    }
  } finally {
    try { runSqlFile('db/cenarios/reset_estavel.sql'); } catch (e) { console.error('AVISO: falha no reset final:', e.message); }
  }

  if (SAIDA) fs.writeFileSync(SAIDA, JSON.stringify(pareceres, null, 2));

  const w = Math.max(4, ...resultados.map((x) => x.id.length));
  const linha = '-'.repeat(w + 66);
  console.log('');
  console.log(`${'CASO'.padEnd(w)}  RES   STATUS   PISO     CONF   TOOLS  LAT(ms)  TENT  DETALHE`);
  console.log(linha);
  for (const x of resultados) {
    const det = x.ok ? (x.avisos.length ? 'ok (aviso: ' + x.avisos.join('; ') + ')' : 'ok') : x.falhas.join(' || ');
    console.log(
      `${x.id.padEnd(w)}  ${(x.ok ? 'PASS' : 'FAIL').padEnd(4)}  ${String(x.status).padEnd(7)}  ${String(x.piso).padEnd(7)}  ` +
      `${String(x.conf).padEnd(5)}  ${String(x.tools).padEnd(5)}  ${String(x.lat ?? '-').padEnd(7)}  ${String(x.tentativas).padEnd(4)}  ${det}`
    );
  }
  console.log(linha);
  const ok = resultados.filter((x) => x.ok).length;
  console.log(`${ok}/${resultados.length} casos OK`);
  process.exit(ok === resultados.length ? 0 : 1);
}

main().catch((e) => {
  console.error('Erro fatal no smoke test:', e);
  try { runSqlFile('db/cenarios/reset_estavel.sql'); } catch (e2) { /* ignora */ }
  process.exit(1);
});
