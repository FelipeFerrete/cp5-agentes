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

    const nosInjetados = processarWorkflow(wf, guardrailSource);
    const outName = file.replace(/\.template\.json$/, '.json');
    const outPath = path.join(OUTPUT_DIR, outName);
    fs.writeFileSync(outPath, JSON.stringify(wf, null, 2) + '\n', 'utf8');
    console.log(
      `Gerado: n8n/workflows/${outName} (id=${wf.id}, nós=${(wf.nodes || []).length}, ` +
      `guardrail injetado em ${nosInjetados} nó(s) Code)`
    );
  }
}

main();
