# Configurador `mongodb-readonly-mcp-configure`: diagnóstico e specs

> **Status geral: CONCLUÍDO** em 2026-11-22. As quatro fases foram aprovadas e implementadas na ordem do diagnóstico (versão 2.0.0). Veja [STATE.md](./STATE.md) e [VALIDACAO.md](./VALIDACAO.md).

## Documentos

| Ordem | Documento | Conteúdo | Status |
|---|---|---|---|
| 0 | [00-diagnostico.md](./00-diagnostico.md) | Fluxo atual de gravação, 10 pontos de atenção, gaps de conflito entre configurações (G1–G10) e reprodução | Referência |
| 1 | [01-spec-fase1-substituicao-e-visibilidade.md](./01-spec-fase1-substituicao-e-visibilidade.md) | Substituir por padrão, perguntar de novo no modo interativo, mostrar a configuração ativa, mensagens de origem | Concluído |
| 2 | [02-spec-fase2-perfis-isolamento-vinculo.md](./02-spec-fase2-perfis-isolamento-vinculo.md) | Perfis nomeados, isolamento do ambiente, vínculo por workspace e fingerprint | Concluído |
| 3 | [03-spec-fase3-endurecimento.md](./03-spec-fase3-endurecimento.md) | Arquivo inválido, permissões do diretório, `fsync`, erros específicos, lock, porta OIDC, backspace | Concluído |
| 4 | [04-spec-fase4-estrutural.md](./04-spec-fase4-estrutural.md) | Cofre de segredos do sistema operacional, teste de conexão antes de salvar | Concluído |
| — | [VALIDACAO.md](./VALIDACAO.md) | Comandos executados, resultados e cobertura por requisito | Atualizado |
| — | [STATE.md](./STATE.md) | Estado da implementação, arquivos alterados, limitações e rollback | Atualizado |

## Rastreabilidade

| Item do diagnóstico | Fase | Requisitos |
|---|---|---|
| Ponto 1: segredos em texto puro | 4 | REQ-4.1 a REQ-4.5 |
| Ponto 2: variáveis exportadas gravadas sem aviso | 2 | REQ-2.6, REQ-2.7 |
| Ponto 3: não dá para remover variáveis | 1 (substituição) e 3 (`--unset`, `--reset`) | REQ-1.1, REQ-3.1, REQ-3.2 |
| Ponto 4: opções opcionais nunca são perguntadas | 1 | REQ-1.5 |
| Ponto 5: arquivo inválido bloqueia a regravação | 3 | REQ-3.3 |
| Ponto 6: permissões do diretório | 3 | REQ-3.4 |
| Ponto 7: sem `fsync` | 3 | REQ-3.5 |
| Ponto 8: erros genéricos | 3 | REQ-3.6 |
| Ponto 9: conexão não testada antes de salvar | 4 | REQ-4.6 a REQ-4.8 |
| Ponto 10: backspace e limite de tamanho | 3 | REQ-3.9 |
| G1: mescla com o arquivo antigo | 1 | REQ-1.1, REQ-1.2 |
| G2: modo interativo não pergunta de novo | 1 | REQ-1.3 |
| G3: arquivo global único | 2 | REQ-2.1 a REQ-2.3 |
| G4: troca silenciosa de banco | 2 | REQ-2.9 a REQ-2.12 |
| G5: ambiente herdado se mistura ao arquivo | 1 (mensagem) e 2 (aviso) | REQ-1.6, REQ-2.8 |
| G6: configurador importa o ambiente mesmo com arquivo explícito | 2 | REQ-2.6 |
| G7: `--vscode`/`--copilot` não vinculam ao projeto | 2 | REQ-2.4, REQ-2.5 |
| G8: configuração ativa invisível | 1 | REQ-1.4, REQ-1.7 |
| G9: concorrência (lock e porta OIDC) | 3 | REQ-3.7, REQ-3.8 |
| G10: `~` e caminho absoluto digitado errado | 2 | REQ-2.3 |

## Processo de aprovação

1. Revise o diagnóstico e cada spec. As decisões (todas resolvidas conforme a recomendação) estão no fim de cada spec.
2. Aprove (ou ajuste) fase por fase. A fase 1 não depende das outras. A fase 2 usa o resumo seguro e o rastreamento de origem da fase 1. As fases 3 e 4 podem ser feitas depois da 1, e a 4 aproveita os perfis da fase 2.
3. Só depois da aprovação de uma fase o código dela será implementado, com testes em `test/` e a atualização do `README.md`.

## Regras comuns a todas as fases

- Nenhuma saída (stdout, stderr, mensagens de erro, logs) pode conter valores de `MONGODB_URI`, `MONGODB_PASSWORD`, userinfo da URI, tokens ou o JSON do arquivo. Só nomes de variáveis, caminhos, hosts sem credenciais, modo e nomes de bancos.
- Toda mudança de comportamento padrão precisa estar descrita em "Compatibilidade" e no `README.md`.
- A validação continua sendo feita por `loadConfiguration` antes de qualquer gravação.
- Comandos de validação: `npm run lint`, `npm run typecheck`, `npm test` e, quando houver MongoDB disponível, `npm run test:integration`.
