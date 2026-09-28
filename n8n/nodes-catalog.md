# Catálogo de nós n8n — CP5 (n8n 2.40.7)

> Ticket T02. Objetivo: eliminar o risco de escrever workflows n8n em JSON à mão
> com `type`/`typeVersion`/nomes de parâmetro errados. Todo ticket que grave um
> `n8n/workflows/*.json` deve copiar os trechos daqui, não inventar campos.

## 1. Método de extração (como este catálogo foi gerado)

1. `docker exec cp5_n8n n8n export:nodes --output=/tmp/nodes.json` — comando
   **oficial da CLI do n8n 2.x** (`n8n export:nodes`) que serializa a
   `NodeTypes` registry inteira (918 tipos nesta instância, incluindo
   `n8n-nodes-base` e `@n8n/n8n-nodes-langchain`) para JSON: `name` (o `type`
   exato), `version`/`typeVersion`(s) suportadas, `properties` (com
   `displayOptions`, `default`, `options`), `credentials`, `inputs`/`outputs`.
   Isso é **melhor fonte de verdade que `/types/nodes.json` por HTTP**: esse
   endpoint não existe mais/não é exposto publicamente no 2.40 (a UI carrega
   os tipos por uma rota autenticada). O CLI não exige login.
2. O JSON exportado (17,7 MB) foi copiado para o host (`docker cp`) e
   filtrado com Python para os ~28 node types pedidos, pegando sempre a maior
   `typeVersion` disponível.
3. Para os poucos detalhes que a `NodeTypeDescription` estática não revela
   (formato exato de tipos de parâmetro "novos" como `resourceLocator`,
   `assignmentCollection`, `workflowSelector`, e os campos de cada tipo de
   **credencial**), o código-fonte dos nós foi lido diretamente dentro do
   container, em
   `/usr/local/lib/node_modules/n8n/node_modules/.pnpm/n8n-nodes-base@.../dist/...`
   (pacote `n8n-nodes-base`) e
   `.../@n8n+n8n-nodes-langchain@.../dist/...` (pacote `@n8n/n8n-nodes-langchain`).
4. Cada armadilha documentada abaixo (formato do Set v3.4, `workflowId` do
   Execute Workflow, `table` do MySQL, comportamento de `publish:workflow`)
   foi **validada empiricamente**: workflow importado via CLI, publicado,
   `docker restart cp5_n8n`, e testado com `curl` real contra o webhook. Os
   três workflows de teste ficaram em `n8n/workflows/wf_smoke*.json` (os dois
   exigidos pelo ticket) e um workflow descartável `wf-test-set-0001` (só para
   validar o nó Set; permanece importado mas **inativo/despublicado** na
   instância — não há comando CLI de `delete:workflow` no n8n 2.40, só
   `unpublish:workflow`).

## 2. Armadilhas da versão 2.x (leia antes de escrever qualquer workflow)

1. **`import:workflow --activeState=fromJson` não funciona fora do modo
   queue/multi-main.** Em modo single-instance (o nosso), o comando falha
   com `"can only be used when n8n is running in queue or multi-main mode"`.
   Toda importação cai para `--activeState=false` (tudo inativo), **mesmo que
   o JSON tenha `"active": true`**.
2. **Ativar um workflow é um comando separado: `n8n publish:workflow --id=<id>`.**
   Só publica a versão atual do workflow no banco.
3. **Publicar não é o suficiente com o processo já rodando.** O próprio CLI
   avisa: *"Changes will not take effect if n8n is running. Please restart
   n8n..."*. Confirmado empiricamente: o webhook só respondeu (deixou de dar
   404) depois de um `docker restart cp5_n8n`. **Todo ticket que ativar um
   trigger (Webhook, MQTT Trigger, Execute Workflow Trigger não conta pois
   não é webhook) precisa terminar com um restart do container `cp5_n8n`.**
   Isso não derruba nem recria volumes (`docker restart` ≠ `down`), então é
   seguro em relação à restrição de não afetar os outros subagentes — mas
   interrompe brevemente qualquer execução em andamento no próprio n8n.
4. **Não existe `n8n delete:workflow` no 2.40.** Só há `unpublish:workflow`
   (desativa) e `import:entities`/`export:entities` para operações de baixo
   nível. Workflows de teste descartáveis ficam no banco, só inativos.
5. **`n8n execute --id=<id>` não funciona com o servidor já rodando no mesmo
   container**: ele tenta subir um Task Broker próprio na porta 5679 e
   colide com a instância já ativa (`"Task Broker's port 5679 is already in
   use"`). Para provar um workflow sem UI, prefira **um Webhook** (curl) a um
   Manual Trigger + `execute`. (`execute-batch`/`execute` só servem se você
   parar o `cp5_n8n` antes, o que este ticket evitou por causa da regra de
   não derrubar containers.)
6. **Owner/usuário:** a instância nunca teve login feito na UI, não existe
   usuário owner algum, e mesmo assim `import:workflow`, `import:credentials`
   e os webhooks (produção) funcionam sem `--userId`/`--projectId` e sem
   nenhum usuário logado. **Não foi necessário criar owner via CLI para os
   webhooks funcionarem.** (Só seria necessário logar na UI se algum ticket
   futuro precisasse abrir o editor visual.)
7. **`$env.DRY_RUN` chega como string `"true"`/`"false"`, não boolean.**
   Código que decide `if ($env.DRY_RUN)` sempre entra no `if` (string não
   vazia é truthy). Use `$env.DRY_RUN === 'true'`.
8. **`N8N_RESTRICT_FILE_ACCESS_TO=/files`** (setado no compose) — o nó
   *Read/Write Files from Disk* só pode ler/escrever dentro de `/files/...`
   dentro do container (que é onde `config/`, `tests/`, `contracts/`,
   `prompts/`, `docs/evidencias/` estão montados, ver `infra/docker-compose.yml`).
   Caminhos fora disso são rejeitados.
9. **Credenciais existem só com um tipo por vez**: `n8n-nodes-base.mySqlTool`
   (a versão *Tool* do nó MySQL para uso por Agentes) **não vive no pacote
   `@n8n/n8n-nodes-langchain`** como o plano sugeria — o `type` correto é
   `n8n-nodes-base.mySqlTool` (mesmo pacote do nó MySQL "normal").
10. **`import:credentials` aceita dado em texto puro no JSON de entrada** (o
    CLI criptografa ao importar); confirmado importando
    `n8n/credentials/mysql_cp5.json` com senha em texto puro e depois
    reexportando com `export:credentials` (sem `--decrypted`) — o `id`
    informado no JSON (`cred-mysql-cp5`) foi preservado, o que permite
    referenciar essa credencial por id fixo em qualquer workflow (`"credentials":
    {"mySql": {"id": "cred-mysql-cp5", "name": "MySQL CP5"}}`), do jeito que
    `wf_smoke_mysql.json` faz.
11. **Groq (`lmChatGroq`) não lista modelos estaticamente**: o campo `model`
    é `type: options` carregado dinamicamente (`GET /models` na API da Groq,
    via credencial). Para escrever o JSON à mão, basta colocar a **string do
    modelo diretamente** (ex.: `"model": "llama-3.3-70b-versatile"` ou uma
    expressão `"={{ $env.GROQ_MODEL_SUPERVISOR }}"`); o n8n não valida contra
    a lista ao importar, só ao abrir na UI.
12. **`n8n-nodes-base.set` (Edit Fields) mudou de formato na v3.3+**: de
    `fields` (fixedCollection clássico) para `assignments`
    (`assignmentCollection`). Use sempre a v3.4 (mais alta com `assignments`)
    — ver §3.9. Validado ao vivo com um webhook de teste.
13. **`n8n-nodes-base.executeWorkflow` (Execute Workflow) mudou `workflowId`
    de `string` (v1) para um tipo de UI `workflowSelector` (v1.1+)**. O
    código-fonte (`GenericFunctions.js` do node) só lê
    `const { value } = this.getNodeParameter('workflowId', i, {})` — ou seja,
    **o único campo obrigatório no JSON é `value`** (o ID do workflow-alvo);
    `mode`/`cachedResultName` são cosméticos da UI e podem ser omitidos. Isso
    vale também para `workflowId` do `toolWorkflow` (mesmo tipo de campo).
14. **`toolWorkflow` (Call n8n Workflow Tool) muda de comportamento em
    `typeVersion` 2.2+**: até 2.1 o nome da tool vem do parâmetro `name`; a
    partir de 2.2 o parâmetro `name` some da UI e o nome da tool passa a ser
    derivado automaticamente do **nome do nó** (`nodeNameToToolName`). Ou
    seja, em 2.2+ o nome do nó no canvas *é* o nome da tool que o LLM vê —
    nomeie o nó com cuidado (ex.: `Consultar_Historico`, sem espaços/acentos
    é mais seguro para uso por tool-calling).
15. **`executeWorkflowTrigger` com `inputSource: "workflowInputs"` (achado
    T09, para sub-workflows que o `toolWorkflow` deve expor como tool com
    PARÂMETROS NOMEADOS, não um único `payload` string) — lido do
    `NodeTypeDescription` real do pacote (`n8n-nodes-base`), não só do
    código-fonte do executor:**
    ```
    "type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1.2
    "parameters": {
      "inputSource": "workflowInputs",
      "workflowInputs": {
        "values": [
          { "name": "id_maquina", "type": "string" },
          { "name": "grandeza", "type": "string" },
          { "name": "janela_min", "type": "number" }
        ]
      }
    }
    ```
    `type` de cada campo ∈ `any|string|number|boolean|array|object` (mesma
    lista do `assignmentCollection` do Set). Não existe campo de "valor
    padrão" aqui — quem chama (`toolWorkflow`) sempre manda os 3 campos; um
    default (ex. `janela_min = 120` quando ausente) precisa ser aplicado no
    primeiro nó Code do sub-workflow, não na declaração do Trigger. Com esse
    modo, o Trigger entrega os campos **diretamente no topo do `$json`**
    (`$json.id_maquina`, `$json.grandeza`, `$json.janela_min`), sem
    wrapper — diferente do modo `passthrough` (usado no WF-10), que só faz
    sentido para 1 payload livre.
    No lado do `toolWorkflow` que chama esse sub-workflow, `workflowInputs`
    (tipo `resourceMapper`) aceita quantos campos nomeados o sub-workflow
    declarar, um `$fromAI(...)` por campo (extensão do exemplo de 1 campo já
    documentado em §3.23):
    ```
    "workflowInputs": {
      "mappingMode": "defineBelow",
      "value": {
        "id_maquina": "={{ $fromAI('id_maquina', 'ID da máquina, ex. MOTOR_01', 'string') }}",
        "grandeza": "={{ $fromAI('grandeza', 'temperatura|vibracao|corrente|taxa_producao|fator_potencia|eficiencia', 'string') }}",
        "janela_min": "={{ $fromAI('janela_min', 'Janela em minutos (padrão 120)', 'number') }}"
      }
    }
    ```
    **Validado ao vivo (T09):** `wf40_tool_historico.json` importado, publicado
    e chamado via o webhook de teste do próprio workflow (mesmo caminho de
    código que o Trigger) — ver `tests/smoke_tool_historico.js`.
16. **`respondToWebhook` (typeVersion ≥ 1.1) só valida a PRESENÇA ESTÁTICA de
    um nó Webhook/Form Trigger/Chat Trigger/Wait em algum lugar ANCESTRAL do
    grafo (`getParentNodes`), não se a execução ATUAL veio de um webhook**
    (lido em `RespondToWebhook.node.js::execute`, dentro do container). Ou
    seja, um workflow com dois pontos de entrada (ex.: `executeWorkflowTrigger`
    para uso real como tool + `webhook` só para teste, caso de
    `wf40_tool_historico.json`) **não pode ligar os dois caminhos direto num
    nó `respondToWebhook` compartilhado**: se a execução atual veio do
    Trigger (não do Webhook), o nó ainda assim tenta `this.sendResponse(...)`
    contra uma resposta HTTP que não existe, o que provavelmente quebra a
    execução da tool (não testado até falhar de propósito — o risco foi
    evitado por desenho). **Correção usada em `wf40_tool_historico.json`:**
    carregar uma flag (`via_webhook: true|false`) desde o nó adaptador de
    cada entrada, e só rotear para `respondToWebhook` com um nó `If` checando
    essa flag; o caminho `false` (Trigger) termina num Code node comum
    (`return [{ json: resultado }];`), nunca tocando `respondToWebhook`.
17. **Nó MySQL (`typeVersion 2.5`) aceita o MESMO placeholder `$N` reaproveitado
    em mais de uma posição da query** (ex.: `$1` usado tanto no `SELECT` de
    exibição quanto, via `$5`, repetido dentro do `WHERE`) — confirmado lendo
    `MySql/v2/helpers/utils.js::extractValuesFromMatches`/`processParameterReplacements`:
    os valores de bind são extraídos ordenando por **número** do placeholder
    (`$1, $2, $3...`), não pela ordem de ocorrência no texto, então a query
    só funciona de forma previsível se `$1, $2, ..., $N` aparecerem em ORDEM
    CRESCENTE no texto (mesmo que `$N` se repita); usado em
    `wf40_tool_historico.json` para reaproveitar `id_maquina`, `grandeza` e
    `janela_min` (cada um citado 2x na query) sem duplicar parâmetros fora de
    ordem.

## 3. Nós — `type` exato, `typeVersion` máxima e parâmetros principais

Cada bloco abaixo é o trecho mínimo de `parameters` (+ `credentials` quando
aplicável) para colar dentro de um nó em `n8n/workflows/*.json`. Sempre
incluir `"id"` (uuid), `"name"`, `"type"`, `"typeVersion"`, `"position"`.

### 3.1 MQTT Trigger
```
"type": "n8n-nodes-base.mqttTrigger", "typeVersion": 1
"parameters": {
  "topics": "fabrica/+/sensores",
  "options": { "jsonParseBody": true, "onlyMessage": false, "parallelProcessing": true }
}
"credentials": { "mqtt": { "id": "<cred-id>", "name": "Mosquitto CP5" } }
```
Credencial `mqtt`: `protocol` (mqtt/mqtts/ws, default `mqtt`), `host`, `port`
(default 1883), `username`, `password`, `clean` (bool), `clientId`, `ssl`
(bool). Para o broker deste projeto: `host="mosquitto"`, `port=1883`,
`username`/`password` = `MQTT_USER`/`MQTT_PASSWORD` do `infra/.env`.

**ARMADILHA (T07, achado empírico): `clientId` fixo quebra 2+ MQTT Trigger no
mesmo workflow.** `GenericFunctions.js::createClient` usa
`clientId: clientId || \`mqttjs_\${randomString(8)}\`` — ou seja, um
`clientId` não-vazio na credencial é usado **literalmente**. Se dois nós MQTT
Trigger (ex.: um assinando `fabrica/+/sensores`, outro `fabrica/+/status`)
usam a MESMA credencial com `clientId` fixo, os dois processos MQTT abrem
conexões separadas com o MESMO clientId — o protocolo MQTT manda o broker
**derrubar a conexão anterior** sempre que um novo CONNECT chega com o mesmo
clientId (ver RFC/spec do MQTT: "MUST disconnect the existing client"). Na
prática isso vira um loop de reconexão: um dos triggers nunca fica
estável e para de disparar (confirmado rodando `wf00_ingest.json` real — o
trigger de `sensores` nunca disparava, enquanto o de `status` disparava a
cada ~2s reconectando sem parar, porque um processo externo publicava
`status` continuamente). **Correção: deixar `clientId: ""` (vazio) na
credencial** — cada chamada de `createClient()` gera um `mqttjs_<random>`
próprio automaticamente, então múltiplos nós MQTT Trigger (mesma credencial
ou não) nunca colidem.

### 3.2 Webhook
```
"type": "n8n-nodes-base.webhook", "typeVersion": 2.1
"parameters": {
  "httpMethod": "POST",
  "path": "cp5/avaliar",
  "responseMode": "responseNode",
  "options": {}
}
"webhookId": "<uuid-qualquer-estavel>"
```
- `responseMode`: `"responseNode"` (usar nó Respond to Webhook — é o padrão
  deste projeto), `"lastNode"` (responde com a saída do último nó
  automaticamente) ou `"onReceived"` (responde na hora, sem esperar o fluxo).
- **Teste vs produção:** o n8n 2.x mantém a mesma distinção de sempre — a URL
  `http://localhost:5678/webhook/<path>` só responde quando o workflow está
  **publicado e ativo** (ver armadilha #2/#3); `http://localhost:5678/webhook-test/<path>`
  só funciona enquanto o workflow está aberto no editor com "Listen for test
  event" ativo (não se aplica ao fluxo 100% CLI deste projeto).
- Body chega em `$json.body`, headers em `$json.headers`, querystring em
  `$json.query`.

### 3.3 Respond to Webhook
```
"type": "n8n-nodes-base.respondToWebhook", "typeVersion": 1.4
"parameters": {
  "respondWith": "json",
  "responseBody": "={{ $json }}",
  "options": {}
}
```
`respondWith` também aceita `text`, `binary`, `redirect`, `noData`,
`allIncomingItems`, `firstIncomingItem` (default), `jwt`. Para status custom:
`options.responseCode` (number, default 200).

### 3.4 Code
```
"type": "n8n-nodes-base.code", "typeVersion": 2
"parameters": {
  "mode": "runOnceForAllItems",   // ou "runOnceForEachItem"
  "language": "javaScript",       // v2 também aceita "pythonNative"
  "jsCode": "const item = $input.first().json;\nreturn [{ json: { ok: true } }];"
}
```
- Modo **each item**: usar `mode: "runOnceForEachItem"`; dentro do código,
  `$json` refere-se ao item atual e o `return` deve ser **um único objeto**
  (não array): `return { json: { ... } };`.
- Modo **all items**: `$input.all()` (array de itens) ou `$input.first()`;
  o `return` deve ser **um array** de `{ json: {...} }`.
- `$env.<VAR>` funciona porque o compose seta
  `N8N_BLOCK_ENV_ACCESS_IN_NODE: "false"`. Lembrar que todo valor de `$env`
  é string (armadilha #7).

### 3.5 Execute Workflow (chamar sub-workflow)
```
"type": "n8n-nodes-base.executeWorkflow", "typeVersion": 1.3
"parameters": {
  "source": "database",
  "workflowId": { "value": "wf-10-pipeline" },
  "mode": "once",
  "options": { "waitForSubWorkflow": true }
}
```
- `workflowId.value` = **id do workflow-alvo** (string; o único campo lido
  pelo executor — ver armadilha #13).
- `mode`: `"once"` (todos os itens de entrada vão numa única execução do
  sub-workflow) ou `"each"` (uma execução por item — marcado como
  "deprecated" na UI do 2.40, preferir `"once"` + Split In Batches se
  precisar granularidade).
- Passagem de dados: com `source: "database"` e `workflowId` setado, o n8n
  também aceita `workflowInputs` (tipo `resourceMapper`) para mapear campos
  de entrada explicitamente; **na prática mais simples e robusta para JSON
  escrito à mão é deixar `workflowInputs` de fora** e no sub-workflow (Execute
  Workflow Trigger) usar `inputSource: "passthrough"` (ver 3.6) — todos os
  itens de entrada (com `json` completo) chegam como estão, sem precisar
  declarar schema.

### 3.6 Execute Workflow Trigger ("When Executed by Another Workflow")
```
"type": "n8n-nodes-base.executeWorkflowTrigger", "typeVersion": 1.2
"parameters": {
  "inputSource": "passthrough"
}
```
- `inputSource`: `"passthrough"` = aceita todos os dados de entrada como
  vierem (**modo pedido no ticket**, sem precisar declarar schema);
  `"workflowInputs"` = declarar uma lista tipada de campos
  (`workflowInputs.values[]` = `{name, type}`, `type` ∈
  `any|string|number|boolean|array|object`); `"jsonExample"` = colar um JSON
  de exemplo e o n8n infere o schema.

### 3.7 Switch (regras por valor string)
```
"type": "n8n-nodes-base.switch", "typeVersion": 3.4
"parameters": {
  "mode": "rules",
  "rules": {
    "values": [
      {
        "conditions": {
          "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "combinator": "and",
          "conditions": [
            { "leftValue": "={{ $json.status_final }}", "rightValue": "NORMAL",
              "operator": { "type": "string", "operation": "equals" } }
          ]
        },
        "outputKey": "NORMAL"
      },
      {
        "conditions": { "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "combinator": "and",
          "conditions": [ { "leftValue": "={{ $json.status_final }}", "rightValue": "ATENCAO",
              "operator": { "type": "string", "operation": "equals" } } ] },
        "outputKey": "ATENCAO"
      },
      {
        "conditions": { "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
          "combinator": "and",
          "conditions": [ { "leftValue": "={{ $json.status_final }}", "rightValue": "CRITICO",
              "operator": { "type": "string", "operation": "equals" } } ] },
        "outputKey": "CRITICO"
      }
    ]
  },
  "options": { "fallbackOutput": "none" }
}
```
Cada item de `rules.values` vira uma saída nomeada (`outputKey`); em
`connections`, referenciar o índice da saída na mesma ordem declarada (0, 1,
2...) — `outputKey` é só o rótulo mostrado na UI/relatórios. `renameOutput`
deve ser `true` para o `outputKey` valer (senão a saída usa o índice).

### 3.8 If
```
"type": "n8n-nodes-base.if", "typeVersion": 2.3
"parameters": {
  "conditions": {
    "options": { "caseSensitive": true, "leftValue": "", "typeValidation": "strict" },
    "combinator": "and",
    "conditions": [
      { "leftValue": "={{ $json.requer_humano }}", "rightValue": true,
        "operator": { "type": "boolean", "operation": "true" } }
    ]
  },
  "options": {}
}
```
Duas saídas fixas: `main[0]` = true, `main[1]` = false.

### 3.9 Merge
```
"type": "n8n-nodes-base.merge", "typeVersion": 3.2
"parameters": { "mode": "append", "numberInputs": 2 }
```
`mode`: `append` (concatena), `combine` (com `combineBy`:
`combineByFields|combineByPosition|combineAll`), `combineBySql` (roda SQL
tipo "SELECT * FROM input1 JOIN input2 ..."), `chooseBranch` (passa direto um
dos inputs, útil para "esperar os 3 especialistas e seguir com qualquer
um dos outputs").

### 3.10 Set / Edit Fields
```
"type": "n8n-nodes-base.set", "typeVersion": 3.4
"parameters": {
  "mode": "manual",
  "assignments": {
    "assignments": [
      { "id": "a1", "name": "status", "value": "={{ $json.body.temperatura > 80 ? 'CRITICO' : 'NORMAL' }}", "type": "string" },
      { "id": "a2", "name": "temperatura", "value": "={{ $json.body.temperatura }}", "type": "number" }
    ]
  },
  "options": {}
}
```
**Validado ao vivo** (webhook `test-set`, ver §5). `type` de cada assignment
∈ `string|number|boolean|array|object`. Alternativa `mode: "raw"` +
`jsonOutput` (string JSON) para setar tudo de uma vez.

### 3.11 Wait
```
"type": "n8n-nodes-base.wait", "typeVersion": 1.1
"parameters": { "resume": "timeInterval", "amount": 2, "unit": "seconds" }
```
`resume`: `timeInterval` (usar `amount`+`unit`), `specificTime`
(`dateTime`), `webhook`, `form`.

### 3.12 HTTP Request
```
"type": "n8n-nodes-base.httpRequest", "typeVersion": 4.5
"parameters": {
  "method": "GET",
  "url": "https://api.openweathermap.org/data/2.5/weather",
  "sendQuery": true,
  "queryParameters": { "parameters": [ { "name": "q", "value": "Sao Paulo,BR" } ] },
  "options": {}
}
```
Auth: `authentication`: `none` (default) | `genericCredentialType` |
`predefinedCredentialType` (usa um tipo de credencial já cadastrado, ex.
`httpHeaderAuth`).

### 3.13 MySQL
```
"type": "n8n-nodes-base.mySql", "typeVersion": 2.5
"credentials": { "mySql": { "id": "cred-mysql-cp5", "name": "MySQL CP5" } }
```
**executeQuery com parâmetros (`queryReplacement`)**
```
"parameters": {
  "operation": "executeQuery",
  "query": "SELECT * FROM leituras WHERE id_maquina = $1 AND created_at >= $2 ORDER BY created_at DESC LIMIT $3",
  "options": {
    "queryReplacement": "={{ [$json.id_maquina, $json.desde, $json.limite] }}"
  }
}
```
`queryReplacement` é uma **expressão que deve resolver para um array**, na
mesma ordem dos placeholders da query (proteção contra SQL injection).

**ERRATA (T06/T07, achado empírico — a versão original deste catálogo estava
errada aqui):** para `typeVersion >= 2.5` (a versão usada neste projeto), os
placeholders da query **têm que ser `$1`, `$2`, `$3`...`, não `?`**. O código
do nó (`n8n-nodes-base/dist/nodes/MySql/v2/helpers/utils.js::prepareSafeQuery`)
só reconhece o padrão `\$(\d+)`; um `?` literal passa direto para o driver
sem virar parâmetro ligado e quebra em runtime com `You have an error in your
SQL syntax ... near '?'` (confirmado rodando `wf10_pipeline.json` real contra
o MySQL do compose — nó "Buscar Nominais"). A forma `?` só é válida na versão
**legada** do nó (`typeVersion < 2.5`, função `prepareQueryLegacy`). Sempre
use `$1`/`$2`/... com `typeVersion: 2.5`.

**insert**
```
"parameters": {
  "operation": "insert",
  "table": { "__rl": true, "mode": "name", "value": "leituras" },
  "dataMode": "autoMapInputData",
  "options": { "replaceEmptyStrings": false }
}
```
- `table` é `resourceLocator`: escrever à mão sempre com
  `"mode": "name", "value": "<tabela>"` (o modo `"list"` depende de uma
  chamada `searchTables` ao vivo pela UI, não funciona bem em JSON estático).
- `dataMode: "autoMapInputData"` mapeia colunas = chaves do `json` de
  entrada (nomes precisam bater); `"defineBelow"` usa `valuesToSend.values[]`
  = `{column, value}` explícitos.
- Nó *usableAsTool*: `true` — o mesmo `n8n-nodes-base.mySql` pode ser ligado
  numa conexão `ai_tool` (n8n oferece "Use as Tool" na UI); porém a forma
  **dedicada** para Tool é a próxima (mySqlTool).

### 3.14 MySQL Tool (para uso por Agentes)
**Atenção:** o `type` correto é `n8n-nodes-base.mySqlTool` — **não** vive em
`@n8n/n8n-nodes-langchain` como o plano original supunha (armadilha #9).
```
"type": "n8n-nodes-base.mySqlTool", "typeVersion": 2.5
"parameters": {
  "descriptionType": "manual",
  "toolDescription": "Consulta o histórico de leituras de uma máquina (média, desvio padrão, tendência).",
  "operation": "executeQuery",
  "query": "SELECT * FROM v_tendencia_2h WHERE id_maquina = ?",
  "options": { "queryReplacement": "={{ [$fromAI('id_maquina', 'ID da máquina, ex. MOTOR_01', 'string')] }}" }
}
"credentials": { "mySql": { "id": "cred-mysql-cp5", "name": "MySQL CP5" } }
```
`inputs: []`, `outputs: ['ai_tool']` — conectar na entrada `Tool` do nó AI
Agent. `$fromAI(key, description, type)` deixa o próprio LLM decidir o valor
do parâmetro a cada chamada.

### 3.15 Code Tool
```
"type": "@n8n/n8n-nodes-langchain.toolCode", "typeVersion": 1.3
"parameters": {
  "name": "calcular_estatisticas",
  "description": "Recebe uma série numérica e retorna média, desvio padrão e variação percentual.",
  "language": "javaScript",
  "jsCode": "const valores = JSON.parse(query);\nconst media = valores.reduce((a,b)=>a+b,0)/valores.length;\nreturn JSON.stringify({ media });",
  "specifyInputSchema": false
}
```
Sem `specifyInputSchema`, a tool recebe uma única string `query`
(`$fromAI` implícito). Com `specifyInputSchema: true` +
`schemaType: "manual"` + `inputSchema` (JSON Schema), a função recebe um
objeto com campos nomeados em vez de uma string.

### 3.16 Read/Write Files from Disk
```
"type": "n8n-nodes-base.readWriteFile", "typeVersion": 1.1
"parameters": {
  "operation": "write",
  "fileName": "/files/docs/evidencias/relatorio_validacao.md",
  "dataPropertyName": "data",
  "options": { "append": false }
}
```
Lembrar da armadilha #8: caminho tem que começar com `/files/...`
(`N8N_RESTRICT_FILE_ACCESS_TO=/files`), que é onde o compose montou
`../config`, `../tests`, `../contracts`, `../prompts`, `../docs/evidencias`.

### 3.17 Manual Trigger
```
"type": "n8n-nodes-base.manualTrigger", "typeVersion": 1
"parameters": {}
```

### 3.18 Split In Batches / Loop Over Items
```
"type": "n8n-nodes-base.splitInBatches", "typeVersion": 3
"parameters": { "batchSize": 1, "options": {} }
```
Duas saídas: `main[0]` = "done" (quando termina todos os lotes), `main[1]` =
"loop" (itens do lote atual — ligar de volta ao topo do laço).

### 3.19 AI Agent
```
"type": "@n8n/n8n-nodes-langchain.agent", "typeVersion": 3.1
"parameters": {
  "promptType": "define",
  "text": "={{ JSON.stringify($json) }}",
  "hasOutputParser": true,
  "options": {
    "systemMessage": "Você é o especialista de Manutenção... (prompt completo do T10)",
    "maxIterations": 8,
    "returnIntermediateSteps": true
  }
}
```
- **System message**: `options.systemMessage` (string; default
  `"You are a helpful assistant"` — sempre sobrescrever).
- **Prompt (define below)**: `promptType: "define"` + `text` (a mensagem do
  usuário/entrada do agente; pode ser uma expressão). `promptType: "auto"`
  usa `$json.chatInput` automaticamente (útil só em chat trigger).
- **Output parser**: `hasOutputParser: true` habilita a entrada de conexão
  `ai_outputParser` (senão ela nem aparece).
- **Intermediate steps**: `options.returnIntermediateSteps: true` inclui no
  JSON de saída o array de passos (tool calls) que o agente fez — é a
  evidência pedida no plano ("visível em intermediateSteps") de que o
  supervisor realmente chamou os 3 especialistas.
- **maxIterations**: `options.maxIterations` (default 10).
- **Conexões** (campo `connections` do workflow, não `parameters`): o Agent
  tem entradas especiais além de `main`:
  - `ai_languageModel` (obrigatória, só 1) ← nó de Chat Model (ex.: Groq).
  - `ai_memory` (opcional, só 1) ← nó de Memory.
  - `ai_tool` (opcional, N) ← nós Tool (toolWorkflow, mySqlTool, toolCode,
    httpRequest "usableAsTool").
  - `ai_outputParser` (só aparece com `hasOutputParser: true`, só 1) ← nó
    outputParserStructured/outputParserAutofixing.
  Exemplo de bloco `connections` ligando um Chat Model ao Agent:
  ```
  "Groq Chat Model": { "ai_languageModel": [[ { "node": "AI Agent", "type": "ai_languageModel", "index": 0 } ]] }
  ```

### 3.20 Groq Chat Model
```
"type": "@n8n/n8n-nodes-langchain.lmChatGroq", "typeVersion": 1
"parameters": {
  "model": "={{ $env.GROQ_MODEL_SUPERVISOR }}",
  "options": { "temperature": 0.2, "maxTokensToSample": 2048 }
}
"credentials": { "groqApi": { "id": "<cred-id>", "name": "Groq" } }
```
Note o nome do campo de tokens: **`maxTokensToSample`** (não `maxTokens`).
Credencial `groqApi`: campo único `apiKey`.

### 3.21 Structured Output Parser
**Schema por exemplo (fromJson, mais simples):**
```
"type": "@n8n/n8n-nodes-langchain.outputParserStructured", "typeVersion": 1.3
"parameters": {
  "schemaType": "fromJson",
  "jsonSchemaExample": "{\n  \"status\": \"NORMAL\",\n  \"achados\": [\"string\"],\n  \"confianca\": 0.9\n}"
}
```
**Schema manual (JSON Schema completo, recomendado para os schemas do
`contracts/especialista.schema.json` do T03):**
```
"parameters": {
  "schemaType": "manual",
  "inputSchema": "={{ $('Set Contract').first().json.schemaJson }}"
}
```
(ou colar o JSON Schema literal na string `inputSchema`). `autoFix: true` +
conexão `ai_languageModel` reprocessa a saída malformada com o LLM antes de
falhar — dá para usar em vez do nó separado abaixo.

### 3.22 Auto-fixing Output Parser
Existe (`@n8n/n8n-nodes-langchain.outputParserAutofixing`, v1). É um nó
"wrapper": recebe conexão `ai_languageModel` (o LLM que vai tentar corrigir)
e `ai_outputParser` (o parser real, ex. o Structured acima), e se conecta ao
Agent como `ai_outputParser`.
```
"type": "@n8n/n8n-nodes-langchain.outputParserAutofixing", "typeVersion": 1
"parameters": { "options": {} }
```

### 3.23 Tool "Call n8n Workflow" (toolWorkflow)
```
"type": "@n8n/n8n-nodes-langchain.toolWorkflow", "typeVersion": 2.1
"parameters": {
  "name": "consultar_manutencao",
  "description": "Chama o especialista de Manutenção (WF-20) com os dados normalizados da leitura atual e retorna o diagnóstico estruturado.",
  "source": "database",
  "workflowId": { "value": "wf-20-manutencao" },
  "workflowInputs": {
    "mappingMode": "defineBelow",
    "value": {
      "payload": "={{ $fromAI('payload', 'JSON com a leitura normalizada da máquina', 'string') }}"
    }
  }
}
```
- `workflowId.value` = id do sub-workflow alvo (armadilha #13).
- `description` é o que o LLM supervisor lê para decidir **quando** chamar
  essa tool — escrever pensando nisso (R7 do plano).
- **`$fromAI(key, description, type)`** dentro de `workflowInputs.value.<campo>`
  é como se delega ao LLM decidir o valor daquele campo a cada chamada
  (usado tanto aqui quanto em Tools SQL/Code).
- Em `typeVersion 2.2+` o campo `name` desaparece e o nome da tool passa a
  ser derivado do **nome do nó** (armadilha #14) — se for usar 2.2, nomeie o
  nó exatamente como o nome de tool desejado.
- No sub-workflow chamado, usar Execute Workflow Trigger com
  `inputSource: "passthrough"` para receber `payload` sem precisar declarar
  schema (ver 3.6).

## 4. Credenciais — tipos e campos exatos

| Nó | `type` da credencial | Campos (nome exato) |
|---|---|---|
| MQTT Trigger | `mqtt` | `protocol`, `host`, `port`, `username`, `password`, `clean`, `clientId`, `ssl` |
| MySQL / MySQL Tool | `mySql` | `host`, `database`, `user`, `password`, `port`, `connectTimeout`, `ssl` (+ campos de SSH tunnel, não usados aqui) |
| Send Email (SMTP) | `smtp` | `user`, `password`, `host`, `port`, `secure` (bool), `disableStartTls`, `hostName` |
| Gmail | `gmailOAuth2` (OAuth2) ou `googleApi` (service account) | fora do escopo deste projeto (decisão §8.3 do plano: usar SMTP, não Gmail OAuth) |
| Telegram | `telegramApi` | `accessToken`, `baseUrl` (opcional) |
| Trello | `trelloApi` (API Key) ou `trelloOAuth1Api` | `apiKey`, `apiToken`, `oauthSecret` |
| Groq Chat Model | `groqApi` | `apiKey` |
| Webhook (auth opcional) | `httpBasicAuth` / `httpHeaderAuth` / `jwtAuth` | — (não usado nos smokes; produção sem auth por trás do compose local) |

## 5. CLI: import, ativação e credenciais (comandos que funcionaram)

```bash
# Importar um workflow (upsert por "id" do JSON)
docker cp meu_workflow.json cp5_n8n:/tmp/import/meu_workflow.json
docker exec cp5_n8n n8n import:workflow --input=/tmp/import/meu_workflow.json

# Ativar (workflow precisa ter "id" fixo)
docker exec cp5_n8n n8n publish:workflow --id=<id-do-workflow>

# OBRIGATÓRIO depois de publicar (ver armadilha #3):
docker restart cp5_n8n

# Desativar
docker exec cp5_n8n n8n unpublish:workflow --id=<id-do-workflow>

# Listar workflows / só ativos
docker exec cp5_n8n n8n list:workflow
docker exec cp5_n8n n8n list:workflow --active=true

# Importar credencial (dado em texto puro no arquivo local; CLI criptografa)
docker cp minha_credencial.json cp5_n8n:/tmp/import/minha_credencial.json
docker exec cp5_n8n n8n import:credentials --input=/tmp/import/minha_credencial.json
```

No Windows + Git Bash, prefixar os `docker exec ...` (destino contém
`/tmp/...`) com `MSYS_NO_PATHCONV=1`; para `docker cp <origem-local> ...`,
usar o caminho de origem em formato Windows (`C:\...`) — combinar as duas
coisas com caminho local em `/c/...` **quebra** (`docker cp` interpreta
errado e gera algo como `GetFileAttributesEx C:\c: ...`). O script
`n8n/import.sh` já resolve isso convertendo a origem com `cygpath -w`.

Formato de credencial para import (exemplo MySQL, ver
`n8n/credentials/mysql_cp5.json.example`):
```json
[
  {
    "id": "cred-mysql-cp5",
    "name": "MySQL CP5",
    "type": "mySql",
    "data": {
      "host": "mysql",
      "database": "fabrica_iot",
      "user": "cp5_app",
      "password": "<MYSQL_PASSWORD do infra/.env>",
      "port": 3306,
      "ssl": false
    }
  }
]
```
O `id` informado é preservado (confirmado reexportando com
`n8n export:credentials --id=cred-mysql-cp5 -o /tmp/x.json`), então qualquer
workflow pode referenciar essa credencial por esse id fixo, sem precisar
descobrir o id gerado.

**Owner/usuário:** não foi preciso criar nenhum usuário via CLI nem UI. A
instância nunca recebeu login e, mesmo assim, workflows importados via CLI,
credenciais importadas via CLI e chamadas ao webhook de produção
funcionaram normalmente. Só seria necessário logar na UI (`http://localhost:5678`,
primeiro acesso pede para criar o owner) se algum ticket futuro precisar
abrir/editar workflows visualmente.

## 6. Prova prática (T02) — evidência literal

### 6.1 `wf_smoke.json` (Webhook → Code → Respond to Webhook)
Arquivo: `n8n/workflows/wf_smoke.json` (id `wf-smoke-0001`).
Importado e publicado via `n8n/import.sh`, depois `docker restart cp5_n8n`.

Comando e saída real:
```
$ curl -s -X POST http://localhost:5678/webhook/smoke -H 'Content-Type: application/json' -d '{"a":1}'
{"ok":true,"recebido":{"a":1},"dry_run":"true"}
```
(HTTP 200, confirmado com `-w "%{http_code}"`.) Note `dry_run` como string
`"true"` — ver armadilha #7.

### 6.2 Credencial MySQL via CLI
```
$ docker exec cp5_n8n n8n import:credentials --input=/tmp/import/mysql_cp5.json
Successfully imported 1 credential.
```
ID da credencial: **`cred-mysql-cp5`** (nome exibido: "MySQL CP5"), definido
no próprio JSON de import e preservado pelo n8n.

### 6.3 `wf_smoke_mysql.json` (Manual Trigger + Webhook → MySQL → Respond to Webhook)
Arquivo: `n8n/workflows/wf_smoke_mysql.json` (id `wf-smoke-0002`). Query:
`SELECT 1 AS ok, @@time_zone AS tz` usando a credencial `cred-mysql-cp5`.

```
$ curl -s http://localhost:5678/webhook/smoke-mysql
{"ok":1,"tz":"-03:00"}
```
`tz = -03:00` bate com `--default-time-zone=-03:00` do serviço `mysql` no
compose — confirma que o nó conectou no MySQL certo (não num MySQL default).

### 6.4 Validação extra do nó Set (não exigida, feita por causa do risco alto)
Workflow descartável `wf-test-set-0001` (Webhook → Edit Fields → Respond to
Webhook), despublicado ao final (`n8n unpublish:workflow --id=wf-test-set-0001`
+ restart), mas ainda listado (inativo) porque não há `delete:workflow`:
```
$ curl -s -X POST http://localhost:5678/webhook/test-set -H 'Content-Type: application/json' -d '{"temperatura": 86.5}'
{"status":"CRITICO","temperatura":86.5}
```
Confirma o formato `assignments.assignments[]` de §3.10 e que `type:"number"`
converte de fato (temperatura voltou como número, não string).

### 6.5 Estado final confirmado
```
$ docker exec cp5_n8n n8n list:workflow
wf-smoke-0001|WF-SMOKE Webhook
wf-smoke-0002|WF-SMOKE MySQL
wf-test-set-0001|TEST Set Node

$ docker exec cp5_n8n n8n list:workflow --active=true
wf-smoke-0001|WF-SMOKE Webhook
wf-smoke-0002|WF-SMOKE MySQL

$ docker ps --format "table {{.Names}}\t{{.Status}}"
cp5_n8n         Up ... (healthy)
cp5_mosquitto   Up ... (healthy)
cp5_mysql       Up ... (healthy)
```
Os containers `cp5_mosquitto` e `cp5_mysql` não foram parados nem recriados
em nenhum momento deste ticket (só `cp5_n8n` foi reiniciado, o que é
obrigatório para ativar publicações — armadilha #3).
