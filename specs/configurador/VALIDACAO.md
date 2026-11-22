# Validação da implementação: configurador 2.0.0

> **Resultado: APROVADO.** Todos os comandos de validação passaram em 2026-11-22.
> Ambiente: WSL2 (Linux), Node 24.11.0, Docker 29 (MongoDB `mongo:8.0` nos testes de integração).
> Specs: [01](./01-spec-fase1-substituicao-e-visibilidade.md), [02](./02-spec-fase2-perfis-isolamento-vinculo.md), [03](./03-spec-fase3-endurecimento.md), [04](./04-spec-fase4-estrutural.md). Estado: [STATE.md](./STATE.md).

## 1. Linha de base (antes da implementação)

| Comando | Resultado |
|---|---|
| `npm run lint` | OK |
| `npm run typecheck` | OK |
| `npm test` | 35 testes, 35 aprovados |

## 2. Resultado final

| Comando | Resultado |
|---|---|
| `npm run lint` | OK, sem avisos |
| `npm run typecheck` | OK |
| `npm test` (inclui `npm run build`) | 48 testes em 10 suítes: 48 aprovados, 0 falhas, 0 ignorados (~14,6 s) |
| `npm run test:integration` | 2 testes: 2 aprovados (~11,8 s) |
| `npm pack --dry-run` | `mongodb-readonly-mcp-2.0.0.tgz`, 22 arquivos, incluindo os novos módulos de `dist/infrastructure/` e `dist/interfaces/cli/verify-connection.js` |

Novos testes: 13, sendo 7 em `test/private-storage.test.ts` e 6 em `test/configurator.test.ts`. Três testes existentes foram ajustados ao novo comportamento:

| Teste | Ajuste | Motivo |
|---|---|---|
| `test/configuration-store.test.ts` (importação não interativa) | `--save` passou a `--save --from-env --secret-store=file`; a mensagem esperada passou a ser "não foi verificada"; `XDG_CONFIG_HOME` passou a ficar no diretório temporário do teste | REQ-2.7 (importação explícita) e REQ-4.1 (cofre). O teste não deve depender do chaveiro real da máquina. |
| `test/integration/mongodb.test.ts` (MongoDB sem autenticação) | `--save` passou a `--save --from-env --secret-store=file` | REQ-2.7 |
| `test/integration/mongodb.test.ts` (MongoDB sem autenticação) | A saída de `--check` passou de `/arquivo privado/` para `/Origem: arquivo: MONGODB_URI/` | O `--check` agora mostra o resumo seguro com a origem de cada variável (REQ-1.4, REQ-2.12) |

## 3. Falhas encontradas e corrigidas durante a validação

| Falha | Causa | Correção |
|---|---|---|
| Teste do cofre libsecret não encontrava o segredo | `runTool` iniciava o processo do cofre sem o ambiente recebido pelo `LibsecretStore` | `runTool` recebe `env`, e o `LibsecretStore` repassa `this.env` em todas as chamadas |
| Teste da porta OIDC ocupada recebia a mensagem genérica | O `catch` externo de `createOidcHumanCallback` trocava qualquer erro por um `OidcError` genérico | O `OidcError` original é repassado; outros erros continuam genéricos, para não expor detalhes do provedor |
| Integração: `--save` recusado | Nova regra REQ-2.7 | Teste ajustado (seção 2) |
| Integração: texto do `--check` | Nova saída do resumo seguro | Teste ajustado (seção 2) |
| Teste de importação deixava `fingerprint.key` em `/tmp/mongodb-mcp-missing-*` | Ao salvar, o configurador cria a chave de fingerprint no diretório da aplicação (comportamento esperado; o servidor não cria). O teste usava um XDG aleatório que não era removido | O teste usa `XDG_CONFIG_HOME` dentro do próprio diretório temporário. Na nova execução, não ficaram resíduos em `/tmp` |
| Mensagem após `--check --force` com falha dizia "ainda não foi testada" | Texto impreciso: a conexão foi testada e falhou | O texto passou a ser "A conexão não foi verificada; execute o configurador com --check para testá-la." |

## 4. Cobertura por requisito

Legenda: **A** = teste automatizado, **M** = verificação manual registrada abaixo, **R** = revisão de código (sem teste automatizado).

| Requisito | Evidência | Tipo |
|---|---|---|
| REQ-1.1 Substituir por padrão | configurator: "keeps two instances … from mixing values (A then B)" | A |
| REQ-1.2 `--update` | configurator: "updates, unsets, resets …" (`--update` sem arquivo falha; `--update --from-env` altera só o informado) | A |
| REQ-1.3 Perguntar de novo no interativo | `writeFlow`: mostra o resumo da configuração salva e pergunta "Usar a configuração salva como base?" | R (exige TTY) |
| REQ-1.4 Resumo seguro | private-storage: "summarizes a configuration without URI, credentials or client IDs"; integração: saída do `--check` | A |
| REQ-1.5 Restrições opcionais | `collectOptionalRestrictions` em `setup.ts` | R (exige TTY) |
| REQ-1.6 Mensagem com a origem | `explainConfigurationError` com `sources` (cita variáveis do ambiente × arquivo, `--update` e `--unset`) | R |
| REQ-1.7 Configuração ativa visível | configurator (vínculo): stderr do servidor "Configuração carregada de … (fonte …) … fingerprint" | A |
| REQ-2.1 Perfis no configurador | configurator: perfis `a` e `b`, `--list-profiles`; nome inválido rejeitado | A |
| REQ-2.2 Ordem de resolução do servidor | private-storage: "keeps profiles and the default file apart …"; CONFIG + PROFILE juntos geram erro | A |
| REQ-2.3 Caminhos explícitos (`~`, aviso) | `expandHome`, aviso de arquivo ausente e confirmação "Criar?" | A (expansão) / R (prompt) |
| REQ-2.4 Vínculo de workspace | configurator: "binds a workspace to a profile …"; private-storage: caminho canônico | A |
| REQ-2.5 Launchers com perfil | `clientEnvironment` com `MONGODB_MCP_PROFILE`/`WORKSPACE`; `bind` automático com `--profile --vscode/--copilot` | R (o launcher real não é aberto nos testes) |
| REQ-2.6 Isolamento do ambiente | configurator: "Variáveis do ambiente ignoradas" com perfil sem `--from-env` | A |
| REQ-2.7 Exportadas no arquivo padrão | configurator: "refuses to silently merge exported variables …" | A |
| REQ-2.8 Aviso de sobreposição no servidor | `loadFromSource` avisa as variáveis do arquivo sobrescritas pelo ambiente | R |
| REQ-2.9 Fingerprint | private-storage: "derives a keyed fingerprint …" | A |
| REQ-2.10 Verificação no servidor | configurator: perfil alterado → "mudou desde o vínculo deste workspace … --profile a --bind" | A |
| REQ-2.11 Fonte fixa durante o processo | `main.ts`: a fonte é resolvida uma vez (promise em cache) | R |
| REQ-2.12 `--check` com fonte e vínculo | configurator: "Vínculo do workspace: divergente" | A |
| REQ-3.1 `--unset` | configurator: remoção de `MONGODB_QUERY_TIMEOUT_MS`; `--unset MONGODB_URI` invalida e nada é salvo; `--unset PATH` é rejeitado | A |
| REQ-3.2 `--reset` | configurator: reset de arquivo inválido e de perfil vinculado (aviso de vínculos restantes) | A |
| REQ-3.3 Arquivo inválido | private-storage: "classifies rejected files …"; configurator: `--update` em JSON inválido sugere `--reset` | A |
| REQ-3.4 Permissões do diretório | private-storage: "writes atomically with 0600, fixes application directories and refuses unsafe foreign ones" | A |
| REQ-3.5 Durabilidade (`fsync`) | `writePrivateFile` em `private-file.ts` (temporário 0600, fsync, rename, fsync do diretório) | R |
| REQ-3.6 Erros específicos | private-storage: "maps file system errors to actionable messages" | A |
| REQ-3.7 Lock de gravação | private-storage: "serializes concurrent writers, times out and recovers stale locks …" | A |
| REQ-3.8 Porta OIDC | configurator: "explains a callback port already used by another instance" | A |
| REQ-3.9 Backspace e limite | `askSecret` remove por code point e limita a 8.192 | R (exige TTY) |
| REQ-4.1 Segredos no cofre | configurator: "stores secrets in the system keyring through stdin only" (o segredo não aparece em argumentos nem no arquivo) | A |
| REQ-4.2 Backends | libsecret simulado (A); libsecret real e DPAPI real (M) | A + M |
| REQ-4.3 Formato versão 2 | configurator (cofre): arquivo com `version: 2` e só referências; o formato 1 continua lido | A |
| REQ-4.4 Leitura no servidor | resolução das referências no carregamento (cofre simulado) | A |
| REQ-4.5 ACL no Windows | `restrictWindowsAcl` (`icacls`) | R (não testado em Windows nativo) |
| REQ-4.6 Verificação reutilizável | `verify-connection.ts`, usado por `--check` (integração) | A |
| REQ-4.7 Teste antes de salvar / `--force` | Verificação manual 5.1 | M |
| REQ-4.8 OIDC no teste | Exige TTY e navegador; sem TTY, falha com mensagem | R |

## 5. Verificações manuais

### 5.1 Teste antes de salvar (REQ-4.7)

Com `XDG_CONFIG_HOME` temporário e `MONGODB_URI` apontando para `127.0.0.1:1` (sem servidor):

| Comando | Resultado |
|---|---|
| `configure --profile p --save --from-env --check` | Código 1: "Falha ao verificar MongoDB… Nada foi salvo; use --force para salvar mesmo assim." O diretório `profiles/` não foi criado. |
| `configure --profile p --save --from-env --check --force` | Código 0: resumo exibido, `profiles/p.json` criado com `-rw-------` e diretório `drwx------`, fingerprint informado |

### 5.2 Cofres reais no WSL (REQ-4.2)

| Cofre | Verificação | Resultado |
|---|---|---|
| libsecret (`secret-tool`) | `store`/`lookup`/`clear` com o valor `abc` | `lookup` devolve exatamente `abc`, sem quebra de linha final; a implementação, que não usa `trim`, está correta |
| DPAPI (`powershell.exe` do Windows via WSL, `new DpapiStore('powershell.exe', true)`) | `set` e `get` de `valor-ção-123 "aspas" $x` | Texto cifrado hexadecimal (556 caracteres); valor recuperado idêntico (UTF-8, aspas e `$` preservados) |

## 6. Não validado

| Item | Motivo | Como validar |
|---|---|---|
| Keychain do macOS (`security`) | Sem macOS disponível | `--secret-store=keyring` em um Mac; conferir com `security find-generic-password -s mongodb-readonly-mcp` |
| ACL `icacls` e DPAPI em Windows nativo | Só verificado via WSL | No Windows: `--save`, depois `icacls %APPDATA%\mongodb-readonly-mcp\config.json` (deve mostrar só o usuário atual) |
| Fluxos interativos (REQ-1.3, 1.5, 2.3 prompt, 3.9) | Exigem TTY real | Executar `mongodb-readonly-mcp-configure` no terminal e seguir o roteiro da spec 01, seção 5 |
| Abertura real do VS Code/Copilot com perfil | Os testes usam cliente simulado | `--profile x --vscode` e conferir o log "fonte vínculo do workspace (perfil x)" no painel MCP |
| Login OIDC real | Sem provedor real | `MONGODB_AUTH_MODE=oidc` com o provedor corporativo |
