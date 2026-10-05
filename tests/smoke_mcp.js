#!/usr/bin/env node
/*
 * tests/smoke_mcp.js — Servidor MCP (WF-41)
 * =============================================================================
 * Fala o protocolo MCP (JSON-RPC 2.0 sobre HTTP "streamable") com o servidor
 * exposto pelo n8n em /mcp/cp5, como faria qualquer cliente MCP (Claude
 * Desktop, MCP Inspector, o nó MCP Client dos especialistas):
 *   1. initialize                → recebe o mcp-session-id
 *   2. notifications/initialized
 *   3. tools/list                → espera consultar_historico, status_maquina, avaliar_leitura
 *   4. tools/call consultar_historico (MOTOR_01, temperatura, 120 min)
 *   5. tools/call status_maquina (MOTOR_01)
 *   6. (--avaliar) tools/call avaliar_leitura com o payload do enunciado (~1 min, usa LLM)
 *
 * Uso: node tests/smoke_mcp.js [--base-url http://localhost:5678] [--avaliar]
 * Sai com 0 se tudo passar. Sem dependências além do Node 18+.
 * =============================================================================
 */

'use strict';

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const URL = `${arg('--base-url', 'http://localhost:5678')}/mcp/cp5`;
const AVALIAR = argv.includes('--avaliar');

let sessao = null;
let id = 0;

/** Uma chamada JSON-RPC; a resposta pode vir como JSON ou como evento SSE ("data: {...}"). */
async function rpc(method, params, notificacao = false) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (sessao) headers['mcp-session-id'] = sessao;
  const corpo = { jsonrpc: '2.0', method, params };
  if (!notificacao) corpo.id = ++id;
  const resp = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(corpo) });
  if (resp.headers.get('mcp-session-id')) sessao = resp.headers.get('mcp-session-id');
  const texto = await resp.text();
  if (notificacao) return null;
  const linha = texto.split('\n').find((l) => l.startsWith('data: '));
  const json = JSON.parse(linha ? linha.slice(6) : texto);
  if (json.error) throw new Error(`${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

/** O conteúdo de um tools/call vem como [{type:'text', text:'...'}]; tenta parsear o texto como JSON. */
function conteudo(result) {
  const t = (result.content || []).map((c) => c.text).join('');
  try { return JSON.parse(t); } catch (e) { return t; }
}

async function main() {
  const casos = [];
  const ok = (nome, cond, det) => { casos.push(cond); console.log(`${cond ? 'PASS' : 'FAIL'}  ${nome}${det ? '  ' + det : ''}`); };

  const ini = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke_mcp', version: '1' } });
  ok('initialize', !!ini.serverInfo, `servidor=${ini.serverInfo && ini.serverInfo.name} sessão=${sessao}`);
  await rpc('notifications/initialized', {}, true);

  const lista = await rpc('tools/list', {});
  const nomes = lista.tools.map((t) => t.name).sort();
  ok('tools/list', ['avaliar_leitura', 'consultar_historico', 'status_maquina'].every((n) => nomes.includes(n)), nomes.join(', '));

  const hist = conteudo(await rpc('tools/call', { name: 'consultar_historico', arguments: { id_maquina: 'MOTOR_01', grandeza: 'temperatura', janela_min: 120 } }));
  const h = Array.isArray(hist) ? hist[0] : hist;
  ok('tools/call consultar_historico', h && (h.ok === true || h.amostras !== undefined || JSON.stringify(h).includes('media')), JSON.stringify(h).slice(0, 160));

  const st = conteudo(await rpc('tools/call', { name: 'status_maquina', arguments: { id_maquina: 'MOTOR_01' } }));
  ok('tools/call status_maquina', JSON.stringify(st).includes('MOTOR_01'), JSON.stringify(st).slice(0, 160));

  if (AVALIAR) {
    const leitura = { id_maquina: 'MOTOR_01', temperatura: 86.5, vibracao: 8.2, tensao: 220, corrente: 18.5, fator_potencia: 0.62, taxa_producao: 42, taxa_producao_esperada: 60 };
    const av = conteudo(await rpc('tools/call', { name: 'avaliar_leitura', arguments: { leitura_json: JSON.stringify(leitura) } }));
    const d = Array.isArray(av) ? av[0] : av;
    ok('tools/call avaliar_leitura', d && d.situacao === 'ALERTA', d && d.relatorio ? '\n' + d.relatorio : JSON.stringify(d).slice(0, 200));
  }

  console.log(`\n${casos.filter(Boolean).length}/${casos.length} OK`);
  process.exit(casos.every(Boolean) ? 0 : 1);
}

main().catch((e) => { console.error('ERRO:', e.message); process.exit(2); });
