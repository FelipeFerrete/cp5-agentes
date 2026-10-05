/*
 * gerar_esperados.js — T05
 *
 * Lê simulator/cenarios.json, executa a lógica de referência do guardrail
 * (contracts/guardrail.js: validar + guardrail + consolidar) para cada
 * cenário com os nominais declarados em `maquinas_nominais`, e grava de
 * volta um bloco `esperado` por cenário com:
 *   status_guardrail, status_final_min, situacao, problemas, acoes, requer_humano, sensor_fault
 *
 * `status_final_min` é o status_final calculado com status_llm = null
 * (consolidar filtra null e usa só o piso do guardrail) — é um "mínimo"
 * porque o LLM real só pode ESCALAR esse status, nunca rebaixá-lo (regra
 * do piso de severidade, §4 do plano).
 *
 * Não escreve `status_llm_esperado`: esse campo é adicionado manualmente
 * (ver bloco MANUAL abaixo) porque é comportamento esperado do LLM, não
 * do guardrail determinístico.
 *
 * Uso: node simulator/gerar_esperados.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { validar, guardrail, consolidar } = require(path.join(ROOT, 'contracts', 'guardrail.js'));
const limiares = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'limiares.json'), 'utf8'));

const CENARIOS_PATH = path.join(__dirname, 'cenarios.json');
const data = JSON.parse(fs.readFileSync(CENARIOS_PATH, 'utf8'));

// status_llm_esperado: comportamento esperado do LLM (não do guardrail),
// preenchido manualmente para os cenários onde o enunciado exige escalada
// ou concordância explícita do LLM com o piso (§7.1, §7.2 do plano).
const STATUS_LLM_ESPERADO_MANUAL = {
  C02: 'CRITICO', // slide 15: crítico óbvio em manutenção e energia
  C03: 'CRITICO', // FP 0,65 < 0,70: condição de alerta do enunciado
  C04: 'CRITICO', // produção 70 % < 80 %: condição de alerta do enunciado
  C07: 'CRITICO', // tendência +15%/2h autoriza o LLM a escalar ATENCAO -> CRITICO
};

function nominaisDe(idMaquina) {
  const m = data.maquinas_nominais[idMaquina];
  return m ? { tensao_nominal: m.tensao_nominal, corrente_nominal: m.corrente_nominal } : null;
}

for (const cenario of data.cenarios) {
  const nominais = nominaisDe(cenario.payload.id_maquina);
  const leitura = validar(cenario.payload, limiares, nominais);
  leitura.guardrail = guardrail(leitura, limiares);
  const consolidado = consolidar(leitura, null, limiares, false);

  const esperado = {
    status_guardrail: leitura.guardrail.status,
    status_final_min: consolidado.status_final,
    situacao: consolidado.situacao,
    problemas: consolidado.problemas.map((p) => p.descricao),
    acoes: consolidado.acoes_previstas,
    requer_humano: consolidado.requer_humano,
    sensor_fault: leitura.guardrail.sensor_fault,
  };

  if (STATUS_LLM_ESPERADO_MANUAL[cenario.id]) {
    esperado.status_llm_esperado = STATUS_LLM_ESPERADO_MANUAL[cenario.id];
  }

  cenario.esperado = esperado;
}

fs.writeFileSync(CENARIOS_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');

// Log legível para conferência manual
console.log('Bloco `esperado` gravado em', path.relative(ROOT, CENARIOS_PATH));
for (const c of data.cenarios) {
  console.log(
    `${c.id.padEnd(5)} guardrail=${c.esperado.status_guardrail.padEnd(8)} ` +
    `final_min=${c.esperado.status_final_min.padEnd(8)} ` +
    `situacao=${c.esperado.situacao.padEnd(7)} ` +
    `requer_humano=${String(c.esperado.requer_humano).padEnd(5)} ` +
    `sensor_fault=${String(c.esperado.sensor_fault).padEnd(5)} ` +
    `acoes=[${c.esperado.acoes.join(',')}]` +
    (c.esperado.status_llm_esperado ? ` status_llm_esperado=${c.esperado.status_llm_esperado}` : '')
  );
}
