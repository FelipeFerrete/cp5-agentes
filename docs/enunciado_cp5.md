CP5 - Agentes de IA
Due today at 11:59 PM
•
Multiple submissions allowed
Instructions
Monitoramento Inteligente de uma Máquina Industrial
Uma indústria deseja desenvolver um sistema de monitoramento inteligente de máquinas. O sistema deverá receber dados de sensores e identificar possíveis situações de anormalidade no funcionamento de um motor.

Os dados poderão ser simulados utilizando MQTT, seguindo uma estrutura semelhante à apresentada em aula.

Dados recebidos
O sistema deverá trabalhar com os seguintes dados:

id_maquina

temperatura

vibracao

tensao

corrente

fator_potencia

taxa_producao

taxa_producao_esperada

Exemplo de mensagem recebida:

{   "id_maquina": "MOTOR_01",   "temperatura": 86.5,   "vibracao": 8.2,   "tensao": 220,   "corrente": 18.5,   "fator_potencia": 0.62,   "taxa_producao": 42,   "taxa_producao_esperada": 60 }
Tarefas
1. Recepção dos dados
Implemente a comunicação utilizando MQTT para receber os dados da máquina.

O sistema deverá ser capaz de receber uma mensagem contendo os dados dos sensores.

2. Análise dos dados
Após receber os dados, o sistema deverá verificar as condições da máquina.

Considere a máquina em situação de alerta quando pelo menos uma das condições abaixo ocorrer:

Temperatura maior que 80 °C;

Vibração maior que 7;

Fator de potência menor que 0,70;

Taxa de produção inferior a 80% da taxa esperada.

3. Classificação da máquina
O programa deverá classificar a situação da máquina como:

NORMAL – nenhuma condição de alerta foi identificada;

ALERTA – uma ou mais condições de alerta foram identificadas.

4. Identificação dos problemas
Além de informar se a máquina está normal ou em alerta, o sistema deverá informar quais condições foram identificadas.

Exemplo:

Máquina: MOTOR_01 Situação: ALERTA Problemas identificados: - Temperatura elevada - Vibração elevada - Fator de potência baixo - Produção abaixo do esperado
5. Agente de decisão
Implemente uma lógica de decisão que represente um agente inteligente.

O agente deverá:

Receber os dados;

Analisar as condições;

Identificar possíveis problemas;

Classificar a situação;

Apresentar uma recomendação.

Exemplo:

RECOMENDAÇÃO: Realizar inspeção do motor e verificar as condições de funcionamento.
6. Testes
Realize pelo menos 3 testes diferentes, alterando os valores recebidos pelos sensores.

Os testes devem apresentar:

Uma situação NORMAL;

Uma situação de ALERTA por temperatura/vibração; (ENVIAR MSG no Telegram)

Uma situação de ALERTA por produção/fator de potência. (Enviar MSG no Telegram e no Email).

OBS: Utilizar o Servidor MCP

7. Entrega
O aluno deverá apresentar:

Video com o Funcionamento do Sistema ou Demonstrar ao Vivo