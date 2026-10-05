# Relatório de validação · 05/10/2026

Resumo: **todas as verificações determinísticas passam**, e o caminho com os agentes LLM funcionou de ponta a ponta depois de cinco correções feitas hoje. A validação completa com LLM (golden set × 3 rodadas) **não foi concluída**, porque a chave gratuita do Groq esgotou o limite diário de tokens no meio do dia. Este relatório registra o que foi medido, o que falhou e o que ficou de fora.

## 1. Testes determinísticos (sem LLM)

Rodados com o ambiente Docker do zero (volumes novos).

| Comando | Resultado |
|---|---|
| `node --test contracts/guardrail.test.js` | 18/18 |
| `node tests/smoke_pipeline.js` | 13/13 cenários (repetido depois de cada correção) |
| `node tests/smoke_acoes.js` | 22 verificações OK (NORMAL = 0 canais, ATENÇÃO = 1, CRÍTICO = 3, dado duvidoso sem Trello) |
| `node tests/smoke_tool_historico.js` | 5/5 casos |
| `node tests/smoke_mcp.js` | 4/4 (initialize, tools/list, consultar_historico, status_maquina) |

O `smoke_acoes.js` falhou na primeira execução (CRÍTICO gravou 1 canal em vez de 3). A causa estava no teste: o webhook de teste responde quando o primeiro canal termina e o script lia o `acoes_log` antes dos outros dois. O pipeline real grava os três (conferido no banco). O teste passou a esperar as linhas.

## 2. Execuções com os agentes LLM

Horários de Brasília.

| Horário | Cenário | Resultado | Observação |
|---|---|---|---|
| 13:44–13:49 | C01 × 3 | PASS nas 3 rodadas; LLM = NORMAL, situação NORMAL, nenhuma ação | 74 s, 71 s e 155 s. O especialista de Energia voltou sem parecer (defeitos 1 e 2) |
| 13:49 | C02 | Invariantes rígidas PASS; LLM = CRÍTICO; Telegram + e-mail + Trello | Manutenção e Energia sem parecer (defeitos 1 e 2) |
| 14:20 | C03 | **Todos os agentes responderam**: Manutenção NORMAL, Produção NORMAL, Energia CRÍTICO; LLM = CRÍTICO; Telegram + e-mail | 189 s, com novas tentativas por limite do Groq. Recomendação escrita pelo Supervisor: "Verificar e ajustar o banco de capacitores para corrigir o fator de potência, monitorando corrente e temperatura." |
| 14:24 | C04 | Situação ALERTA, Telegram + e-mail, pela regra | O Supervisor desistiu após 394 s por limite do Groq; a decisão saiu pelo guardrail, como projetado |
| 14:48 | C07 | Invariantes rígidas 12/12 PASS; LLM indisponível | Limite diário do `gpt-oss-120b` esgotado (199 075 de 200 000 tokens). Sem o LLM, a leitura de 76 °C fica no pré-alerta e a situação é NORMAL, que é o comportamento da regra fixa |
| 14:55 | Especialista Produção (C02) | PASS, CRÍTICO, 1 chamada de tool, 71 s, primeira tentativa | Depois do defeito 4 corrigido |

Nos casos em que o LLM falhou, nenhuma invariante rígida quebrou: a situação, os problemas e os canais saíram iguais aos da regra de referência. É o piso de severidade funcionando na prática.

## 3. Defeitos encontrados e corrigidos hoje

| # | Defeito | Efeito | Correção (commit) |
|---|---|---|---|
| 1 | Manutenção e Energia usavam o mesmo modelo e rodam em paralelo | Os dois disputavam 8 000 tokens/min e um deles voltava sem parecer | Energia passou para `gpt-oss-120b` e cada área espera um tempo diferente antes de tentar de novo (`e581884`) |
| 2 | A nova tentativa após 429 lia o prompt pelo item de entrada | Na segunda rodada o n8n não achava a saída do Wait e a tentativa falhava; todo 429 virava parecer nulo | O agente lê o prompt do nó de origem (`1645260`) |
| 3 | Agente com `onError = continueErrorOutput` dentro de um laço | Um segundo erro derrubava o roteamento do próprio n8n ("Expected output #0 from node Esperar 429") | A falha sai pela saída normal e um `If` decide a nova tentativa (`fa82e88`) |
| 4 | `qwen` pedia 4 096 tokens de saída | O plano gratuito aceita 1 000 por minuto nesse modelo; o pedido era recusado sem chance de nova tentativa | Saída limitada a 1 000 tokens quando o modelo é `qwen` (`ae91aca`) |
| 5 | Runner de validação usava `fetch` | O Node desiste após 300 s; ao desconectar, o webhook ficou sem destinatário e o n8n travou a 100 % de CPU até ser reiniciado | Runner usa `http` com 15 min de espera (`2d77bcd`) |

## 4. O que não foi provado

- **Golden set completo com LLM em 3 rodadas.** Precisa de uma chave do Groq com cota diária cheia. Comando: `node tests/run_validation.js --rodadas 3 --intervalo 60`.
- **Escalada por tendência (C07) com o LLM.** Em versões anteriores o especialista de Manutenção escalou citando a alta de 19,6 % em 2 h, mas isso não foi medido de novo hoje por falta de cota.

## 5. Limites do plano gratuito do Groq vistos hoje

| Modelo | Tokens por minuto | Tokens por dia | Saída por minuto |
|---|---|---|---|
| `openai/gpt-oss-120b` | 8 000 | 200 000 | — |
| `openai/gpt-oss-20b` | 8 000 | 200 000 | — |
| `qwen/qwen3.8-27b` | 7 000 (entrada) | não atingido | 1 000 |

Os testes do dia esgotaram o limite diário dos dois `gpt-oss` em umas 10 avaliações com novas tentativas. Para uma demonstração, use uma chave com a cota cheia e espere 1 a 2 minutos entre um cenário e outro.

## 6. Envio real (`DRY_RUN=false`)

Às 15:00, com `?llm=0` (os canais não dependem do LLM), o C11 e o C03 foram enviados de verdade. Linhas gravadas em `acoes_log`:

| Cenário | Decisão | Canal | dry_run | sucesso |
|---|---|---|---|---|
| C03 (FP 0,65) | 70 | Telegram | 0 | 1 |
| C03 (FP 0,65) | 70 | E-mail | 0 | 1 |
| C11 (85 °C) | 71 | Telegram | 0 | 1 |
| C11 (85 °C) | 71 | Trello | 0 | 1 |

Os prints da mensagem no Telegram, do e-mail e do card no Trello entram nesta pasta junto com o vídeo. Depois do teste, `DRY_RUN` voltou para `true`.
