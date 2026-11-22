# STATE: implementação do configurador

> **Estado: CONCLUÍDO.** Versão **2.0.0**. Última atualização: 2026-11-22.
> Ordem seguida: a de [00-diagnostico.md](./00-diagnostico.md#4-ordem-de-implementação-aprovada-e-concluída) (fase 1 → 2 → 3 → 4). Resultado dos testes em [VALIDACAO.md](./VALIDACAO.md).

## 1. Resumo por fase

| Fase | Spec | Status | Requisitos |
|---|---|---|---|
| 1. Substituição e visibilidade | [01](./01-spec-fase1-substituicao-e-visibilidade.md) | Concluído | REQ-1.1 a REQ-1.7 |
| 2. Perfis, isolamento e vínculo | [02](./02-spec-fase2-perfis-isolamento-vinculo.md) | Concluído | REQ-2.1 a REQ-2.12 |
| 3. Endurecimento | [03](./03-spec-fase3-endurecimento.md) | Concluído | REQ-3.1 a REQ-3.9 |
| 4. Cofre e teste antes de salvar | [04](./04-spec-fase4-estrutural.md) | Concluído | REQ-4.1 a REQ-4.8 |

## 2. Pontos de atenção e gaps

| Item | Situação | Onde foi tratado |
|---|---|---|
| Ponto 1: segredos em texto | Resolvido. Cofre do SO (libsecret, Keychain, DPAPI) com fallback em texto `0600` somente com confirmação ou `--secret-store=file` | `secret-store.ts`, `configure.ts` |
| Ponto 2: exportadas gravadas sem aviso | Resolvido. Pergunta no modo interativo; `--save` exige `--from-env`/`--ignore-env` | `configure.ts` (`writeFlow`) |
| Ponto 3: remover variáveis | Resolvido. Substituição por padrão, `--unset` e `--reset` | `configure.ts` |
| Ponto 4: opções nunca perguntadas | Resolvido. Etapa opcional de restrições | `setup.ts` (`collectOptionalRestrictions`) |
| Ponto 5: arquivo inválido bloqueia | Resolvido. Classificação e substituição com confirmação; `--reset` | `private-file.ts`, `configuration-store.ts` |
| Ponto 6: permissões do diretório | Resolvido. Corrige o diretório da aplicação e recusa diretórios externos inseguros | `private-file.ts` (`ensurePrivateDirectory`) |
| Ponto 7: sem `fsync` | Resolvido | `private-file.ts` (`writePrivateFile`) |
| Ponto 8: erros genéricos | Resolvido | `private-file.ts` (`describeIoError`) |
| Ponto 9: conexão não testada antes de salvar | Resolvido. Pergunta padrão `S`; `--check`/`--force` com `--save` | `verify-connection.ts`, `configure.ts` |
| Ponto 10: backspace e limite | Resolvido. Remoção por code point; limite de 8.192 | `configure.ts` (`askSecret`) |
| G1: mescla com o arquivo antigo | Resolvido (substituição por padrão; `--update` explícito) | `configure.ts` |
| G2: interativo não pergunta de novo | Resolvido | `configure.ts` |
| G3: arquivo global único | Resolvido (perfis) | `configuration-store.ts` |
| G4: troca silenciosa de banco | Resolvido (vínculo com fingerprint HMAC) | `fingerprint.ts`, `workspace-binding.ts`, `configuration-source.ts` |
| G5: ambiente herdado se mistura | Resolvido. Fontes explícitas são exclusivas; o arquivo padrão avisa as sobreposições | `configuration-source.ts` |
| G6: configurador importa ambiente com arquivo explícito | Resolvido | `configure.ts` |
| G7: launchers não vinculam ao projeto | Resolvido. `--profile` com `--vscode`/`--copilot` faz o vínculo e repassa perfil e workspace | `configure.ts`, `setup.ts` |
| G8: configuração ativa invisível | Resolvido (log no stderr do servidor, `--check`, `--list-profiles`) | `main.ts`, `configure.ts` |
| G9: concorrência | Resolvido. Lock com timeout de 5 s e recuperação de lock órfão; mensagem própria para porta OIDC ocupada | `file-lock.ts`, `oidc.ts` |
| G10: `~` e caminho errado | Resolvido. Expansão de `~`, confirmação para criar e aviso de caminho fora do diretório | `configuration-store.ts`, `configure.ts` |

## 3. Decisões aplicadas

Todas seguiram a recomendação da spec.

| ID | Decisão |
|---|---|
| D1.1 | Versão `2.0.0` |
| D1.2 | Consentimento após a coleta, com o resumo do que será salvo |
| D1.3 | Usuário SCRAM exibido só como `definido` |
| D1.4 | Caminho e hosts somente no stderr, não nas respostas das tools |
| D2.1 | Vínculos em `<diretório da aplicação>/bindings/` (nada no repositório) |
| D2.2 | Fingerprint sobre as variáveis brutas |
| D2.3 | `--from-env` obrigatório para importar em destino explícito |
| D2.4 | Workspace sem vínculo usa o arquivo padrão, com aviso |
| D2.5 | `--bind` automático com `--profile` + `--vscode`/`--copilot` |
| D3.1 | O diretório da aplicação é corrigido automaticamente para `0700` |
| D3.2 | Diretórios externos com escrita por grupo/outros são recusados |
| D3.3 | `--reset` não apaga vínculos; ele lista os workspaces ainda vinculados |
| D3.4 | Timeout de 5 s para o lock (lock órfão após 30 s) |
| D4.1 | Partes A e B implementadas juntas, conforme a aprovação; a parte A foi validada no WSL |
| D4.2 | Formato versão 2 aninhado (`version`, `variables`, `secrets`) |
| D4.3 | `auto` sem cofre: pergunta no interativo; falha no `--save` sem `--secret-store=file` |
| D4.4 | "Testar a conexão antes de salvar?" com padrão `S` |

## 4. Arquivos

### Criados

| Arquivo | Conteúdo |
|---|---|
| `src/infrastructure/private-file.ts` | Leitura, gravação atômica e durável, permissões, ACL no Windows, classificação de arquivos inválidos e mensagens de erro de E/S |
| `src/infrastructure/file-lock.ts` | `withFileLock`: lock exclusivo com timeout e recuperação de lock órfão |
| `src/infrastructure/fingerprint.ts` | Chave local `fingerprint.key` e fingerprint HMAC-SHA-256 |
| `src/infrastructure/workspace-binding.ts` | Vínculos workspace → perfil em `bindings/` |
| `src/infrastructure/secret-store.ts` | Cofres libsecret, Keychain e DPAPI via CLI do SO, com segredo sempre por stdin |
| `src/infrastructure/configuration-source.ts` | Resolução da fonte do servidor e carregamento com verificação de fingerprint |
| `src/interfaces/cli/verify-connection.ts` | Verificação de conexão reutilizada por `--check` e pelo teste antes de salvar |
| `test/private-storage.test.ts` | 7 testes de armazenamento, lock, fingerprint e fontes |
| `test/configurator.test.ts` | 6 testes de CLI e servidor: perfis, isolamento, vínculo, cofre e porta OIDC |
| `specs/configurador/VALIDACAO.md`, `specs/configurador/STATE.md` | Este registro |

### Alterados

| Arquivo | Mudança |
|---|---|
| `src/infrastructure/configuration-store.ts` | Reescrito: perfis, destinos, formato versão 2, resolução com origens, resumo seguro e serialização |
| `src/interfaces/cli/configure.ts` | Reescrito: novas opções e fluxos de gravação, check, bind, unbind, reset e list |
| `src/interfaces/cli/setup.ts` | Ambiente do cliente com perfil e workspace; restrições opcionais; descrições |
| `src/main.ts` | Fonte resolvida uma vez; log da configuração carregada; erros com a origem |
| `src/infrastructure/oidc.ts` | `findOidcError`, mensagem para `EADDRINUSE`; o `OidcError` específico é preservado |
| `src/interfaces/mcp/server.ts` | `findOidcError` e versão `2.0.0` |
| `test/configuration-store.test.ts`, `test/integration/mongodb.test.ts` | Ajustes de flags e de mensagens (detalhes em VALIDACAO.md) |
| `README.md` | Instalação, variáveis, opções do configurador, arquivo privado e precedência, perfis e vínculo, solução de problemas, várias conexões, mudanças da 2.0.0 e versões nos exemplos de `.tgz` |
| `package.json`, `package-lock.json` | Versão `2.0.0` |
| `specs/configurador/*.md` | Status "Concluído" e decisões marcadas como resolvidas |

### Complemento: ícone e tutorial

| Arquivo | Mudança |
|---|---|
| `assets/icon.png`, `assets/icon-64.png`, `assets/icon-128.png` | Ícone do servidor: folha MongoDB sobre banco de dados, fundo transparente |
| `src/interfaces/mcp/branding.ts` | `serverInfo` com `title`, `description` e `icons` (PNG 64 e 128 em `data:` URI; sem os arquivos, o servidor sobe sem ícone) |
| `src/interfaces/mcp/server.ts` | Usa `serverInfo()` |
| `test/stdio.test.ts`, `test/helpers/stdio.ts` | `initialize` retorna o resultado; o teste valida título e ícones aceitos pelo VS Code |
| `package.json` | `files` inclui os dois PNGs |
| `docs/TUTORIAL-INICIANTES.md`, `README.md` | Tutorial passo a passo e link; nota sobre o ícone |
| `src/interfaces/mcp/log.ts` | `McpLog`: mensagens não fatais via `notifications/message` (info/warning), com fila até o `initialized`; stderr só para erros |
| `src/main.ts`, `src/interfaces/mcp/server.ts` | Capability `logging`; "Configuração carregada" em `info`, avisos em `warning`; ícone 64 px em cada tool do `tools/list` |
| `test/helpers/stdio.ts`, `test/configurator.test.ts`, `test/stdio.test.ts` | Coleta de logs MCP; mensagem de carga em `info` e fora do stderr; ícone em cada tool |

Validação: lint, typecheck, `npm test` 48/48 e `npm run test:integration` 2/2; servidor instalado com stderr vazio na inicialização, log `info` e 6 tools com ícone (`tools/list` ≈ 39 KB); `npm pack --dry-run` inclui `assets/icon-64.png` e `assets/icon-128.png`.

Limitação verificada no código do VS Code (`mcpManagementService.ts`, `getLocalServerInfo`): a lista **MCP Servers - Installed** usa somente o ícone da galeria (`manifest.json` gravado na instalação pela galeria). O `serverInfo.icons` aparece no seletor de ferramentas do chat (`chatToolPicker.ts`).

## 5. Mudanças incompatíveis (2.0.0)

1. `--save` no arquivo padrão com variáveis `MONGODB_*` no ambiente falha sem `--from-env` ou `--ignore-env`.
2. Destinos explícitos (perfil ou `MONGODB_MCP_CONFIG`) ignoram o ambiente no configurador, a menos que se use `--from-env`.
3. Sem `--update`, o arquivo é substituído e não mesclado.
4. Segredos vão para o cofre quando disponível. Com segredos e sem cofre, `--save` exige `--secret-store=file`.
5. `MONGODB_MCP_CONFIG` e `MONGODB_MCP_PROFILE` juntos geram erro.

Arquivos no formato antigo (objeto plano) continuam sendo lidos sem migração.

## 6. Limitações conhecidas

- **Keychain do macOS e Windows nativo não foram testados**; o DPAPI foi validado via WSL. Veja VALIDACAO.md, seção 6.
- **Lock otimista:** a coleta interativa acontece fora do lock. Na gravação, o estado do arquivo é comparado sob o lock, e uma alteração concorrente aborta com mensagem, sem sobrescrever.
- **Fluxos interativos** (TTY) foram verificados por revisão de código, não por testes automatizados.
- **Fingerprint sobre variáveis brutas:** com segredos no cofre, o fingerprint usa os valores resolvidos. Mudar só a forma (por exemplo, explicitar `MONGODB_ONLY_READ=true`) exige um novo `--bind`.
- Desinstalar o pacote **não** remove arquivos nem segredos do cofre; use `--reset` antes.

## 7. Backup e rollback

O projeto não é um repositório git. Antes da implementação, foi feito backup em:

```
/home/fnascimento/.copilot/session-state/85c0779d-ddb1-4af3-9f38-b007c4ec88f0/files/backup-pre-impl/
  src/  test/  README.md  package.json  package-lock.json
```

Para voltar à versão 1.0.0:

```sh
cd /home/fnascimento/fean-projects/MCP/mongodb-mcp
B=/home/fnascimento/.copilot/session-state/85c0779d-ddb1-4af3-9f38-b007c4ec88f0/files/backup-pre-impl
rm -rf src test && cp -a "$B/src" "$B/test" . && cp -a "$B/README.md" "$B/package.json" "$B/package-lock.json" .
npm run build && npm test
```

Configurações gravadas no formato versão 2 (com segredos no cofre) **não** são lidas pela 1.0.0. Antes do rollback, regrave-as com `--secret-store=file`.

## 8. Próximos passos sugeridos

1. Validar no macOS e no Windows nativo (VALIDACAO.md, seção 6).
2. Executar o roteiro interativo da spec 01 em um terminal real.
3. Gerar e distribuir o pacote: `npm pack` → `mongodb-readonly-mcp-2.0.0.tgz`, e reinstalar globalmente (`npm install -g ./mongodb-readonly-mcp-2.0.0.tgz`).
4. Considerar a inclusão do projeto em git, para que as próximas mudanças tenham histórico em vez de backup manual.
