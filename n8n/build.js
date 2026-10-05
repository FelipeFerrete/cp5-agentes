#!/usr/bin/env node
/*
 * n8n/build.js — T06/T07 (CP5)
 * =============================================================================
 * Gera n8n/workflows/*.json a partir de n8n/templates/*.template.json.
 *
 * Por quê: o maestro exigiu que a lógica do guardrail (contracts/guardrail.js)
 * NÃO seja reescrita à mão dentro dos nós Code do n8n — isso criaria uma
 * segunda fonte da verdade que poderia divergir silenciosamente da lógica
 * coberta pelos 15 testes de contracts/guardrail.test.js.
 *
 * Como funciona:
 *   1. Lê contracts/guardrail.js e remove só a linha final `module.exports =
 *      {...}` (dentro de um Code node do n8n não existe `module`/`require`;
 *      as funções (validar, guardrail, consolidar, maxStatus, classificar,
 *      round2, ORDEM, ESPECIALISTA_DE) precisam ficar soltas no escopo do
 *      código gerado).
 *   2. Para cada template em n8n/templates/*.template.json, percorre os nós
 *      `n8n-nodes-base.code` e, em qualquer `parameters.jsCode` que contenha
 *      o marcador literal "__GUARDRAIL_JS__", substitui o marcador pelo
 *      código-fonte lido no passo 1 (substituição de string simples, sem
 *      regex, via split/join — evita qualquer interpretação de padrões
 *      especiais tipo "$&" caso um dia apareçam no arquivo fonte).
 *   3. Escreve o resultado em n8n/workflows/<nome>.json (mesmo nome do
 *      template, sem o sufixo ".template").
 *
 * O restante do jsCode de cada nó (tudo fora do marcador) é só "fiação":
 * ler a entrada do nó anterior, montar os argumentos de validar()/
 * guardrail()/consolidar() e formatar a saída no shape esperado pelo próximo
 * nó / pelos contratos (contracts/leitura.schema.json, decisao.schema.json).
 * Nenhuma regra de negócio (limiares, classificação NORMAL/ATENCAO/CRITICO,
 * piso de severidade) é reimplementada ali.
 *
 * Consequência prática: mudar uma regra do guardrail = editar
 * contracts/guardrail.js (e seus testes) + rodar `node n8n/build.js` de
 * novo + `bash n8n/import.sh`. Os arquivos em n8n/workflows/*.json são
 * artefato gerado — não editar à mão (a próxima rodada do build sobrescreve).
 *
 * Uso:
 *   node n8n/build.js
 *
 * VARIANTES (T11): um template pode gerar N workflows. `wf2x_especialista.template.json`
 * é a fonte única dos 3 especialistas (WF-20/21/22); para cada variante o build
 * substitui marcadores (__AREA__, __WF_ID__, __WF_NOME__, __WEBHOOK_ID__,
 * __SYSTEM_PROMPT__, __SCHEMA_ESPECIALISTA__) nos VALORES DE STRING já parseados
 * (percorrendo o objeto), nunca no texto JSON cru -- assim aspas, quebras de
 * linha e barras do prompt/schema são escapadas pelo JSON.stringify final.
 * O system prompt = prompts/<area>.md (sem a linha "<!-- concatenar: ... -->")
 * + linha em branco + prompts/especialista_base.md a partir do primeiro "---".
 * O schema = contracts/especialista.schema.json sem $schema/$id.
 * Templates sem variantes seguem o caminho antigo (saída idêntica), exceto pelo marcador
 * global __SUPERVISOR_PROMPT__ (T12: prompts/supervisor.md no WF-10) e por __AREA_UP__
 * (T11b: GROQ_MODEL_<AREA> nos especialistas).
 *
 * Sem dependências além dos módulos nativos do Node (fs, path).
 * =============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const OUTPUT_DIR = path.join(__dirname, 'workflows');
const GUARDRAIL_PATH = path.join(ROOT, 'contracts', 'guardrail.js');
const MARKER = '__GUARDRAIL_JS__';

/**
 * Lê contracts/guardrail.js e remove a linha final `module.exports = {...}`.
 * Lança erro se não encontrar exatamente esse padrão — preferimos falhar o
 * build a gerar um workflow com `module` (undefined dentro do Code node do n8n).
 */
function lerGuardrailSource() {
  const raw = fs.readFileSync(GUARDRAIL_PATH, 'utf8');
  const semExports = raw.replace(/\n\s*module\.exports\s*=\s*\{[\s\S]*?\};?\s*$/, '\n');
  if (semExports === raw) {
    throw new Error(
      'build.js: não encontrei a linha "module.exports = {...}" no final de ' +
      'contracts/guardrail.js. Abortando para não gerar workflows com um ' +
      'trecho de guardrail.js incompleto ou incompatível.'
    );
  }
  return semExports.trim();
}

/** Substitui o marcador por src, sem interpretar padrões especiais de regex/replace. */
function injetar(jsCode, src) {
  if (typeof jsCode !== 'string' || !jsCode.includes(MARKER)) return jsCode;
  return jsCode.split(MARKER).join(src);
}

function processarWorkflow(wf, guardrailSource) {
  let nosComMarcador = 0;
  for (const node of wf.nodes || []) {
    if (
      node.type === 'n8n-nodes-base.code' &&
      node.parameters &&
      typeof node.parameters.jsCode === 'string' &&
      node.parameters.jsCode.includes(MARKER)
    ) {
      node.parameters.jsCode = injetar(node.parameters.jsCode, guardrailSource);
      nosComMarcador += 1;
    }
  }
  return nosComMarcador;
}

// ---------------------------------------------------------------------------
// Variantes (T11)
// ---------------------------------------------------------------------------
const VARIANTES = {
  'wf2x_especialista.template.json': [
    { arquivo: 'wf20_manutencao.json', area: 'manutencao', id: 'wf-cp5-20-manutencao', nome: 'WF-20 Especialista: Manutenção', webhookId: 'cp5-especialista-manutencao-0001' },
    { arquivo: 'wf21_producao.json', area: 'producao', id: 'wf-cp5-21-producao', nome: 'WF-21 Especialista: Produção', webhookId: 'cp5-especialista-producao-0001' },
    { arquivo: 'wf22_energia.json', area: 'energia', id: 'wf-cp5-22-energia', nome: 'WF-22 Especialista: Energia', webhookId: 'cp5-especialista-energia-0001' },
  ],
};

function lerSystemPrompt(area) {
  const ler = (f) => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8').replace(/\r\n/g, '\n');
  const esp = ler(`${area}.md`);
  const base = ler('especialista_base.md');
  const espLimpo = esp.split('\n').filter((l) => !/^\s*<!--\s*concatenar:.*-->\s*$/.test(l)).join('\n').trim();
  const linhas = base.split('\n');
  const i = linhas.findIndex((l) => l.trim() === '---');
  if (i < 0) throw new Error('build.js: prompts/especialista_base.md sem separador "---"');
  const baseUtil = linhas.slice(i + 1).join('\n').trim();
  if (!espLimpo || !baseUtil) throw new Error(`build.js: prompt vazio para ${area}`);
  return espLimpo + '\n\n' + baseUtil;
}

function lerSchemaEspecialista() {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'especialista.schema.json'), 'utf8'));
  delete schema.$schema; // o parser do n8n (json-schema-to-zod) ignora, mas não precisa ir no prompt do LLM
  delete schema.$id;
  return JSON.stringify(schema, null, 2);
}

/** Percorre o objeto já parseado e troca marcadores só dentro de valores string. */
function substituirMarcadores(obj, mapa) {
  if (typeof obj === 'string') {
    let out = obj;
    for (const [k, v] of Object.entries(mapa)) out = out.split(k).join(v);
    return out;
  }
  if (Array.isArray(obj)) return obj.map((x) => substituirMarcadores(x, mapa));
  if (obj && typeof obj === 'object') {
    const r = {};
    for (const [k, v] of Object.entries(obj)) r[k] = substituirMarcadores(v, mapa);
    return r;
  }
  return obj;
}


// ---------------------------------------------------------------------------
// Marcadores globais (T12): __SUPERVISOR_PROMPT__ = prompts/supervisor.md (inteiro).
// Mesma técnica das variantes: troca só nos valores string do objeto parseado.
// Só lê o arquivo quando o template usa o marcador.
// ---------------------------------------------------------------------------
function substituirMarcadoresGlobais(wf) {
  const usa = JSON.stringify(wf).includes('__SUPERVISOR_PROMPT__');
  if (!usa) return wf;
  const prompt = fs.readFileSync(path.join(ROOT, 'prompts', 'supervisor.md'), 'utf8').replace(/\r\n/g, '\n').trim();
  if (!prompt) throw new Error('build.js: prompts/supervisor.md vazio');
  return substituirMarcadores(wf, { __SUPERVISOR_PROMPT__: prompt });
}

function main() {
  const guardrailSource = lerGuardrailSource();

  if (!fs.existsSync(TEMPLATES_DIR)) {
    console.error(`build.js: diretório de templates não existe: ${TEMPLATES_DIR}`);
    process.exit(1);
  }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const templates = fs
    .readdirSync(TEMPLATES_DIR)
    .filter((f) => f.endsWith('.template.json'))
    .sort();

  if (!templates.length) {
    console.log(`build.js: nenhum template em ${TEMPLATES_DIR} (*.template.json). Nada a gerar.`);
    return;
  }

  for (const file of templates) {
    const templatePath = path.join(TEMPLATES_DIR, file);
    let wf;
    try {
      wf = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (e) {
      throw new Error(`build.js: falha ao parsear ${file}: ${e.message}`);
    }

    const variantes = VARIANTES[file];
    const saidas = variantes
      ? variantes.map((v) => ({
          nome: v.arquivo,
          wf: substituirMarcadores(wf, {
            __AREA__: v.area,
            __AREA_UP__: v.area.toUpperCase(), // GROQ_MODEL_<AREA> (T11b)
            __WF_ID__: v.id,
            __WF_NOME__: v.nome,
            __WEBHOOK_ID__: v.webhookId,
            __SYSTEM_PROMPT__: lerSystemPrompt(v.area),
            __SCHEMA_ESPECIALISTA__: lerSchemaEspecialista(),
          }),
        }))
      : [{ nome: file.replace(/\.template\.json$/, '.json'), wf: substituirMarcadoresGlobais(wf) }];

    for (const saida of saidas) {
      const nosInjetados = processarWorkflow(saida.wf, guardrailSource);
      const outPath = path.join(OUTPUT_DIR, saida.nome);
      fs.writeFileSync(outPath, JSON.stringify(saida.wf, null, 2) + '\n', 'utf8');
      console.log(
        `Gerado: n8n/workflows/${saida.nome} (id=${saida.wf.id}, nós=${(saida.wf.nodes || []).length}, ` +
        `guardrail injetado em ${nosInjetados} nó(s) Code)`
      );
    }
  }
}

main();
