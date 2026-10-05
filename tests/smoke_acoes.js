#!/usr/bin/env node
// Smoke test do WF-30 (n8n/workflows/wf30_acoes.json), ticket T08.
//
// Node 24, fetch nativo, sem dependências externas. Usa `docker exec` (via
// child_process) para inserir uma linha real em `decisoes` antes de cada
// caso (satisfaz a FK de acoes_log.id_decisao), chama o webhook de teste
// `/cp5/acoes-teste`, consulta `acoes_log` daquele id_decisao e valida o
// número/conteúdo das linhas gravadas. Ao final, apaga só as linhas que
// este script criou.
//
// Uso: node tests/smoke_acoes.js
// Pré-requisitos: infra rodando (docker compose up -d), wf30_acoes importado
// e publicado (n8n/import.sh), DRY_RUN=true em infra/.env.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WEBHOOK_URL = 'http://localhost:5678/webhook/cp5/acoes-teste';
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
      '-N', '-B', '-r', // -r/--raw: sem isso, o cliente mysql escapa \, \n, \t na saída em modo batch, corrompendo o JSON
      ENV.MYSQL_DATABASE,
    ],
    { input: sql, encoding: 'utf8' }
  );
  if (res.status !== 0) {
    throw new Error('mysql falhou: ' + (res.stderr || res.stdout || `exit ${res.status}`));
  }
  return (res.stdout || '').trim();
}

function sqlStr(v) {
  if (v === null || v === undefined) return 'NULL';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}
function sqlBool(v) { return v ? '1' : '0'; }
function sqlJson(v) { return sqlStr(JSON.stringify(v)); }
function sqlNum(v) { return (v === null || v === undefined) ? 'NULL' : String(v); }

function inserirDecisao(d) {
  const sql = `
INSERT INTO decisoes
  (id_leitura, id_maquina, status_guardrail, status_llm, status_final,
   sensor_fault, requer_humano, resumo_operador, justificativa,
   pareceres, acoes_previstas, modelo, latencia_ms)
VALUES
  (${sqlNum(d.id_leitura)}, ${sqlStr(d.id_maquina)}, ${sqlStr(d.status_guardrail)},
   ${d.status_llm === null ? 'NULL' : sqlStr(d.status_llm)}, ${sqlStr(d.status_final)},
   ${sqlBool(d.sensor_fault)}, ${sqlBool(d.requer_humano)},
   ${sqlStr(d.resumo_operador)}, ${sqlStr(d.justificativa)},
   ${sqlJson(d.especialistas)}, ${sqlJson(d.acoes_previstas)},
   ${d.modelo === null || d.modelo === undefined ? 'NULL' : sqlStr(d.modelo)},
   ${sqlNum(d.latencia_ms)});
SELECT LAST_INSERT_ID();
`;
  const out = mysqlRun(sql);
  const id = parseInt(out.trim().split('\n').pop(), 10);
  if (!Number.isInteger(id)) {
    throw new Error('Não consegui obter o id da decisão inserida. Saída: ' + out);
  }
  return id;
}

function consultarAcoesLog(idDecisao) {
  const sql = `
SELECT COALESCE(
  JSON_ARRAYAGG(JSON_OBJECT(
    'id', id, 'canal', canal, 'dry_run', dry_run, 'destino', destino,
    'conteudo', conteudo, 'sucesso', sucesso, 'erro', erro
  )),
  JSON_ARRAY()
) FROM acoes_log WHERE id_decisao = ${sqlNum(idDecisao)};
`;
  const out = mysqlRun(sql);
  return JSON.parse(out);
}

function apagarAcoesLog(idDecisao) {
  mysqlRun(`DELETE FROM acoes_log WHERE id_decisao = ${sqlNum(idDecisao)};`);
}
function apagarDecisao(idDecisao) {
  mysqlRun(`DELETE FROM decisoes WHERE id = ${sqlNum(idDecisao)};`);
}

// ---------------------------------------------------------------------------
// Chamada ao webhook de teste do WF-30
// ---------------------------------------------------------------------------
async function chamarAcoesTeste(decisao, idDecisao) {
  const resp = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decisao, id_decisao: idDecisao }),
  });
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* mantém null */ }
  return { status: resp.status, json, text };
}

// ---------------------------------------------------------------------------
// Casos de teste (contracts/decisao.schema.json)
// ---------------------------------------------------------------------------
const ESPECIALISTAS_NULOS = { manutencao: null, producao: null, energia: null };

function baseDecisao(overrides) {
  return Object.assign({
    id_leitura: null,
    id_maquina: 'MOTOR_01',
    ts: new Date().toISOString(),
    status_guardrail: 'NORMAL',
    status_llm: null,
    status_final: 'NORMAL',
    sensor_fault: false,
    requer_humano: false,
    especialistas: ESPECIALISTAS_NULOS,
    resumo_operador: '',
    justificativa: '',
    acoes_previstas: [],
    modelo: null,
    latencia_ms: null,
  }, overrides);
}

const casoNormal = baseDecisao({
  status_guardrail: 'NORMAL',
  status_final: 'NORMAL',
  resumo_operador: 'MOTOR_01 operando dentro da faixa normal.',
  justificativa: 'Todas as grandezas dentro dos limiares de config/limiares.json.',
  acoes_previstas: [],
});

const casoAtencao = baseDecisao({
  status_guardrail: 'ATENCAO',
  status_final: 'ATENCAO',
  resumo_operador: 'Temperatura de MOTOR_01 acima do limiar de atenção (74.2°C).',
  justificativa: 'temperatura 74.2°C > limiar de atenção 70°C (config/limiares.json::especialistas.manutencao.grandezas.temperatura).',
  acoes_previstas: ['TELEGRAM'],
  especialistas: {
    manutencao: {
      especialista: 'manutencao', status: 'ATENCAO',
      achados: [{ grandeza: 'temperatura', valor: 74.2, limite_violado: 70, status: 'ATENCAO', observacao: 'Acima do limiar de atenção (70°C), abaixo do crítico (80°C).' }],
      tendencia: null, recomendacao: 'Monitorar nas próximas leituras; sem ação imediata.',
      dados_insuficientes: false, confianca: 'media',
    },
    producao: null,
    energia: null,
  },
});

const casoCritico = baseDecisao({
  id_maquina: 'MOTOR_01',
  status_guardrail: 'CRITICO',
  status_llm: 'CRITICO',
  status_final: 'CRITICO',
  requer_humano: false,
  resumo_operador: 'MOTOR_01 em CRÍTICO: temperatura 92.3°C e vibração 5.1 mm/s acima dos limites; corrente 118% da nominal.',
  justificativa: 'Guardrail e LLM concordam em CRITICO. Manutenção: temperatura 92.3°C > crítico 80°C (ISO 10816-3 zona C/D aproximada para vibração). Energia: corrente 118% da nominal, ainda abaixo do crítico de 120%, mas em tendência de alta sustentada na janela de 120 min. Produção sem dados suficientes nesta leitura.',
  acoes_previstas: ['TELEGRAM', 'EMAIL', 'TRELLO'],
  modelo: 'llama-3.3-70b-versatile',
  latencia_ms: 2140,
  especialistas: {
    manutencao: {
      especialista: 'manutencao', status: 'CRITICO',
      achados: [
        { grandeza: 'temperatura', valor: 92.3, limite_violado: 80, status: 'CRITICO', observacao: 'Temperatura 92.3°C acima do limite crítico de 80°C.' },
        { grandeza: 'vibracao', valor: 5.1, limite_violado: 4.5, status: 'ATENCAO', observacao: 'Vibração 5.1 mm/s RMS acima do limiar de atenção (4.5).' },
      ],
      tendencia: { grandeza: 'temperatura', janela_min: 120, media: 88.4, desvio_padrao: 3.2, variacao_percentual: 18.5, amostras: 12 },
      recomendacao: 'Parar a máquina e inspecionar o sistema de refrigeração imediatamente.',
      dados_insuficientes: false, confianca: 'alta',
    },
    producao: null,
    energia: {
      especialista: 'energia', status: 'ATENCAO',
      achados: [
        { grandeza: 'corrente', valor: 59.0, limite_violado: 50, status: 'ATENCAO', observacao: 'Corrente em 118% da nominal (50A), acima do limiar de atenção (100%).' },
      ],
      tendencia: null,
      recomendacao: 'Verificar carga mecânica e conexões do quadro elétrico.',
      dados_insuficientes: false, confianca: 'media',
    },
  },
});

const casoAtencaoRequerHumano = baseDecisao({
  status_guardrail: 'ATENCAO',
  status_final: 'ATENCAO',
  requer_humano: true,
  resumo_operador: 'Leitura de MOTOR_02 com campo ausente (vibracao); dado insuficiente para diagnóstico completo.',
  justificativa: 'campo obrigatório "vibracao" ausente no payload; requer verificação humana antes de qualquer ação automática adicional.',
  acoes_previstas: ['TELEGRAM'],
  id_maquina: 'MOTOR_02',
});

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------
const criados = { decisoes: [], };
let falhas = 0;

function check(desc, cond) {
  console.log((cond ? '[OK] ' : '[FALHA] ') + desc);
  if (!cond) falhas++;
  return cond;
}

async function rodarCaso(nome, decisao, expectativa) {
  console.log('\n=== Caso: ' + nome + ' ===');
  const idDecisao = inserirDecisao(decisao);
  criados.decisoes.push(idDecisao);
  console.log('id_decisao inserido:', idDecisao);

  const resp = await chamarAcoesTeste(decisao, idDecisao);
  check('HTTP 200 do webhook', resp.status === 200);
  console.log('Resposta do webhook:', JSON.stringify(resp.json ?? resp.text));

  // O webhook de teste responde quando o primeiro ramo chega ao fan-in; os outros
  // canais terminam logo depois. Espera as linhas aparecerem (até 15 s) antes de conferir.
  let linhas = consultarAcoesLog(idDecisao);
  for (let i = 0; i < 30 && linhas.length < expectativa.linhas; i++) {
    await new Promise((r) => setTimeout(r, 500));
    linhas = consultarAcoesLog(idDecisao);
  }
  check(`acoes_log tem ${expectativa.linhas} linha(s) (obtido: ${linhas.length})`, linhas.length === expectativa.linhas);

  if (expectativa.canais) {
    const canaisObtidos = linhas.map((l) => l.canal).sort();
    const canaisEsperados = [...expectativa.canais].sort();
    check(
      `canais gravados = [${canaisEsperados.join(',')}] (obtido: [${canaisObtidos.join(',')}])`,
      JSON.stringify(canaisObtidos) === JSON.stringify(canaisEsperados)
    );
  }

  if (expectativa.contemTexto) {
    const algumContem = linhas.some((l) => (l.conteudo || '').includes(expectativa.contemTexto));
    check(`alguma linha contém "${expectativa.contemTexto}"`, algumContem);
  }

  linhas.forEach((l) => check(`linha ${l.canal}: dry_run=1`, Number(l.dry_run) === 1));
  linhas.forEach((l) => check(`linha ${l.canal}: sucesso=1`, Number(l.sucesso) === 1));

  return { idDecisao, linhas, respWebhook: resp.json };
}

(async () => {
  console.log('Smoke test WF-30 Ações — ' + WEBHOOK_URL);

  await rodarCaso('NORMAL (acoes_previstas: [])', casoNormal, { linhas: 0 });

  await rodarCaso('ATENCAO (["TELEGRAM"])', casoAtencao, { linhas: 1, canais: ['TELEGRAM'] });

  const critico = await rodarCaso('CRITICO (["TELEGRAM","EMAIL","TRELLO"])', casoCritico, {
    linhas: 3, canais: ['TELEGRAM', 'EMAIL', 'TRELLO'],
  });

  await rodarCaso('ATENCAO + requer_humano (["TELEGRAM"])', casoAtencaoRequerHumano, {
    linhas: 1, canais: ['TELEGRAM'], contemTexto: 'Verificação humana',
  });

  // -------------------------------------------------------------------
  // Evidência para revisão de redação: conteúdo renderizado do caso CRÍTICO
  // -------------------------------------------------------------------
  console.log('\n=== Conteúdo renderizado — caso CRÍTICO (revisão de redação) ===');
  const porCanal = {};
  for (const l of critico.linhas) porCanal[l.canal] = JSON.parse(l.conteudo);

  console.log('\n--- Telegram ---');
  console.log(porCanal.TELEGRAM ? porCanal.TELEGRAM.text : '(ausente)');

  console.log('\n--- E-mail: assunto ---');
  console.log(porCanal.EMAIL ? porCanal.EMAIL.assunto : '(ausente)');

  console.log('\n--- E-mail: HTML (primeiros 2000 caracteres) ---');
  const htmlEmail = porCanal.EMAIL ? porCanal.EMAIL.html : '';
  console.log(htmlEmail.slice(0, 2000));

  console.log('\n--- Trello: card ---');
  if (porCanal.TRELLO) {
    console.log('nome:', porCanal.TRELLO.nome);
    console.log('descricao:\n' + porCanal.TRELLO.descricao);
  } else {
    console.log('(ausente)');
  }

  // Salva o HTML completo do e-mail como evidência
  const evidenciasDir = path.join(ROOT, 'docs', 'evidencias');
  fs.mkdirSync(evidenciasDir, { recursive: true });
  const htmlPath = path.join(evidenciasDir, 'exemplo_email_critico.html');
  fs.writeFileSync(htmlPath, htmlEmail, 'utf8');
  console.log('\nHTML do e-mail salvo em: ' + htmlPath);

  // -------------------------------------------------------------------
  // Limpeza: apaga só as linhas criadas por este script
  // -------------------------------------------------------------------
  console.log('\n=== Limpeza ===');
  for (const id of criados.decisoes) {
    apagarAcoesLog(id);
    apagarDecisao(id);
    console.log('Removidos: decisoes.id=' + id + ' (+ acoes_log correspondente, se houver)');
  }

  console.log('\n=== Resultado final ===');
  if (falhas === 0) {
    console.log('TODOS OS CASOS PASSARAM.');
    process.exit(0);
  } else {
    console.log(falhas + ' verificação(ões) FALHARAM.');
    process.exit(1);
  }
})().catch((err) => {
  console.error('ERRO NO SMOKE TEST:', err);
  process.exit(1);
});
