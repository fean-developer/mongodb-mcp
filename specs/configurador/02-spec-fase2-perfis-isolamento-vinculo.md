# Spec — Fase 2: perfis nomeados, isolamento do ambiente e vínculo do servidor

> **Status: CONCLUÍDO** em 2026-11-22 (versão 2.0.0). Resultado dos testes em [VALIDACAO.md](./VALIDACAO.md); estado e arquivos alterados em [STATE.md](./STATE.md).
> Cobre: G3, G4, G5 (aviso), G6, G7, G10 e ponto 2.
> Dependências: fase 1 (resumo seguro e origem das variáveis).

## 1. Objetivo

Permitir várias configurações independentes sem escrever caminhos à mão. Cada projeto deve ficar preso à configuração escolhida. Um servidor MCP não pode passar a usar outro banco sem aviso por causa de uma gravação feita em outro projeto ou de variáveis herdadas do ambiente.

## 2. Conceitos

| Termo | Definição |
|---|---|
| **Fonte explícita** | `MONGODB_MCP_CONFIG`, `MONGODB_MCP_PROFILE` ou um vínculo de workspace. Com fonte explícita, o arquivo é a **única** fonte; `MONGODB_*` do ambiente são ignoradas. |
| **Fonte padrão** | `<raiz>/mongodb-readonly-mcp/config.json`. Mantém a precedência atual (ambiente sobre arquivo), agora com aviso. |
| **Perfil** | Arquivo `<raiz>/mongodb-readonly-mcp/profiles/<nome>.json`, no mesmo formato do arquivo atual. |
| **Vínculo** | Registro por usuário que associa um workspace a um perfil e ao fingerprint esperado. |
| **Fingerprint** | HMAC-SHA-256 da configuração efetiva completa (REQ-2.9). |

`<raiz>` é a mesma de hoje: `$XDG_CONFIG_HOME`, `%APPDATA%` ou `~/.config`.

## 3. Requisitos

### REQ-2.1 — Perfis no configurador

- Nova opção `--profile <nome>` (também `--profile=<nome>`).
- Nome válido: `^[a-z0-9][a-z0-9_-]{0,62}$`. Qualquer outro valor é rejeitado, o que impede `..`, `/` e caminhos absolutos.
- Caminho: `<raiz>/mongodb-readonly-mcp/profiles/<nome>.json`, diretório com `0700` e arquivo com `0600`, mesma gravação atômica de hoje.
- `--profile` junto com `MONGODB_MCP_CONFIG` no ambiente é erro: `Use MONGODB_MCP_CONFIG ou --profile, não ambos.`
- Nova opção `--list-profiles`: lista os nomes e, para cada um, o resumo seguro do REQ-1.4, ou `inválido` com o motivo. Não aceita outras opções.

### REQ-2.2 — Perfis no servidor e ordem de resolução

O servidor resolve a fonte **uma vez, na inicialização**, e a guarda para todas as cargas seguintes (inclusive novas tentativas depois de falha):

1. `MONGODB_MCP_CONFIG`
2. `MONGODB_MCP_PROFILE`
3. vínculo do workspace (REQ-2.4), quando `MONGODB_MCP_WORKSPACE` estiver definido
4. arquivo padrão

Definir 1 e 2 ao mesmo tempo é erro de configuração. Para 1, 2 e 3, as `MONGODB_*` do ambiente são ignoradas (generaliza o `serverEnvironment` atual).

### REQ-2.3 — Caminhos explícitos (G10)

- `MONGODB_MCP_CONFIG` iniciado por `~/` é expandido para o diretório home. `~usuario/` continua inválido.
- No configurador, se o arquivo explícito ainda não existe:
  - interativo: `O arquivo <caminho> não existe. Criar? [s/N]`;
  - `--save`: cria e avisa `Novo arquivo criado: <caminho>`.
- No servidor, um arquivo explícito ausente gera, no **stderr**, `Arquivo de configuração explícito não encontrado: <caminho>`. A mensagem para a tool continua sendo a de configuração ausente, sem o caminho.

### REQ-2.4 — Vínculo de workspace (G7)

- Nova variável do servidor: `MONGODB_MCP_WORKSPACE` (caminho absoluto). **Não reutilizar `MONGODB_MCP_ROOT`**, que o README define como raiz de instalação.
- No VS Code: `"env": { "MONGODB_MCP_WORKSPACE": "${workspaceFolder}" }`.
- O vínculo fica **no diretório do usuário**, não no projeto:
  `<raiz>/mongodb-readonly-mcp/bindings/<sha256(realpath(workspace))>.json`, modo `0600`, com o conteúdo:

  ```json
  { "version": 1, "workspace": "/caminho/real/do/projeto", "profile": "flowboard", "fingerprint": "hmac-sha256:<hex>" }
  ```

- Sem segredos. Leitura com as mesmas verificações do arquivo principal (dono, `0600`, sem symlink, até 4 KiB, esquema validado, `workspace` igual ao `realpath` informado).
- Criado ou atualizado com `configure --profile <nome> --bind`, usando `process.cwd()` como workspace, ou `--workspace <caminho absoluto>`.
- `--unbind` remove o vínculo do workspace atual.

### REQ-2.5 — Launchers `--vscode` e `--copilot`

- Com `--profile`, o cliente recebe `MONGODB_MCP_PROFILE=<nome>` e `MONGODB_MCP_WORKSPACE=<cwd>`.
- `MONGODB_MCP_ROOT` passa a receber a raiz real do pacote (derivada de `import.meta.url`), não o `cwd`.
- Sem `--profile`, o comportamento atual é mantido, com aviso: `A janela usará o arquivo padrão compartilhado; use --profile para isolar este projeto.`

### REQ-2.6 — Isolamento do ambiente no configurador (G6)

- Com fonte explícita (`MONGODB_MCP_CONFIG` ou `--profile`), o configurador **ignora** as `MONGODB_*` do ambiente.
- Nova opção `--from-env`: importa as variáveis do ambiente de propósito e lista os nomes importados antes de salvar.

### REQ-2.7 — Variáveis exportadas no arquivo padrão (ponto 2)

Sem fonte explícita, quando houver `MONGODB_*` no ambiente:

- interativo: listar os **nomes** e perguntar `Importar estas variáveis do ambiente? [s/N]`. Com `N`, elas são ignoradas e o prompt pede o que faltar;
- `--save`: exigir `--from-env` ou `--ignore-env`. Sem nenhum dos dois, erro listando os nomes.

### REQ-2.8 — Aviso de sobreposição no servidor (G5)

Com fonte padrão, se alguma variável do ambiente sobrepuser um valor do arquivo, escrever no stderr, mesmo quando a configuração for válida:
`Aviso: variáveis do ambiente sobrepõem o arquivo <caminho>: MONGODB_URI, MONGODB_PASSWORD.`

### REQ-2.9 — Fingerprint da configuração efetiva

- Entrada: todas as variáveis `MONGODB_*` permitidas **já resolvidas** (arquivo + ambiente, conforme a fonte), só as não vazias, serializadas em JSON canônico com chaves ordenadas.
- Cálculo: `HMAC-SHA-256(chave, "mongodb-readonly-mcp/fingerprint/v1\n" + json)`.
- A chave tem 32 bytes aleatórios em `<raiz>/mongodb-readonly-mcp/fingerprint.key` (`0600`), criada no primeiro uso.
- Usa HMAC, e não SHA-256 puro, porque o fingerprint aparece em vínculos e logs. Com hash sem chave, uma senha fraca poderia ser descoberta por força bruta offline.
- Exibição: `hmac-sha256:` + 12 primeiros caracteres hexadecimais. O valor completo só fica no vínculo.
- Qualquer mudança, inclusive só em `MONGODB_ALLOWED_DATABASES`, altera o fingerprint.

### REQ-2.10 — Verificação no servidor (G4)

- Com vínculo (fonte 3), a cada carga o servidor compara o fingerprint calculado com o do vínculo **antes** de criar o `MongoClient`.
- Divergência gera `ConfigurationError`, sem conexão:
  `A configuração do perfil "<nome>" mudou desde o vínculo deste workspace. Execute mongodb-readonly-mcp-configure --profile <nome> --bind neste workspace para aceitar a mudança.`
- Sem vínculo, o fluxo atual de "configurar e tentar a tool de novo" continua, mas a linha de stderr do REQ-1.7 passa a incluir o fingerprint curto.

### REQ-2.11 — Fonte fixa durante o processo

- O caminho da fonte (arquivo, perfil ou vínculo) é resolvido na inicialização e não muda até o processo terminar.
- Depois de uma carga bem-sucedida, o comportamento atual se mantém: a configuração não é relida.

### REQ-2.12 — `--check` com fonte e vínculo

`--check` (aceita `--profile`) mostra:
- tipo de fonte (`arquivo explícito`, `perfil`, `vínculo`, `padrão`);
- fingerprint curto;
- para o `cwd`, ou para `MONGODB_MCP_WORKSPACE`: vínculo `ok`, `divergente` ou `inexistente`.

## 4. Design técnico

| Arquivo | Mudança |
|---|---|
| `src/infrastructure/configuration-store.ts` | Novo tipo `ConfigurationSource` (`explicit-file`, `profile`, `binding`, `default`). `resolveConfigurationSource(env)`. `configurationFilePath` passa a aceitar a fonte. Funções de perfil e de lista. `serverEnvironment` generalizado para qualquer fonte explícita. |
| novo `src/infrastructure/fingerprint.ts` | Chave, HMAC, JSON canônico, formatação curta. |
| novo `src/infrastructure/workspace-binding.ts` | Leitura, gravação e remoção de vínculos, com as mesmas verificações do arquivo principal. |
| `src/interfaces/cli/configure.ts` | Opções `--profile`, `--list-profiles`, `--from-env`, `--ignore-env`, `--bind`, `--unbind`, `--workspace`. Matriz de combinações válidas documentada no parser. |
| `src/interfaces/cli/setup.ts` | `clientEnvironment` com `MONGODB_MCP_PROFILE`, `MONGODB_MCP_WORKSPACE` e `MONGODB_MCP_ROOT` correto. |
| `src/main.ts` | Fonte resolvida uma vez; verificação de fingerprint antes do client; aviso do REQ-2.8. |
| `README.md` | Substituir o exemplo de vários arquivos com `MONGODB_MCP_CONFIG` por perfis; documentar vínculo, `MONGODB_MCP_WORKSPACE` e `--from-env`. |

## 5. Critérios de aceite

1. `configure --profile a` e `configure --profile b` geram arquivos independentes. Alterar `b` não muda `a`.
2. Com `MONGODB_URI` exportada e `--profile x --save`, o arquivo não contém a URI do ambiente. Com `--from-env`, contém.
3. Servidor com `MONGODB_MCP_PROFILE=a` ignora `MONGODB_URI` do ambiente.
4. Servidor com vínculo para `a`: depois de `configure --profile a --update` mudar só `MONGODB_ALLOWED_DATABASES`, a próxima tool falha com a mensagem de divergência e nenhuma conexão é aberta. Depois de `--bind`, volta a funcionar.
5. Um servidor sem configuração no início, com vínculo, não carrega a configuração gravada por outro projeto no arquivo padrão.
6. `MONGODB_MCP_CONFIG=~/x.json` resolve para `<home>/x.json`.
7. Nenhum vínculo, log ou saída contém segredo. O fingerprint exibido tem 12 caracteres.
8. Nomes de perfil como `../a`, `A`, `a/b` e uma string vazia são rejeitados.

## 6. Testes

- Unitários: validação do nome do perfil; ordem de resolução da fonte; conflito CONFIG + PROFILE; expansão de `~/`; fingerprint estável para a mesma entrada e diferente para qualquer variável alterada; chave criada com `0600`.
- Vínculo: gravar, ler, divergir, `--unbind`; rejeição de symlink, permissão aberta e `workspace` diferente do `realpath`.
- Integração por processo (`env -i`, raiz temporária via `XDG_CONFIG_HOME`): critérios 1 a 5.
- `test/launcher.test.ts`: ambiente do cliente com `MONGODB_MCP_PROFILE`, `MONGODB_MCP_WORKSPACE` e sem `MONGODB_*`.

## 7. Compatibilidade

- Arquivo padrão e `MONGODB_MCP_CONFIG` continuam funcionando.
- **Mudança de comportamento:** com `MONGODB_MCP_CONFIG`, o configurador deixa de importar o ambiente. O exemplo atual do README (`MONGODB_MCP_CONFIG=… MONGODB_URI=… configure --save`) passa a exigir `--from-env` (D2.3).
- **Mudança de comportamento:** `--save` no arquivo padrão com `MONGODB_*` exportadas passa a exigir `--from-env` ou `--ignore-env` (D2.3).
- `MONGODB_MCP_ROOT` passa a apontar para a raiz do pacote. Para `npm run configure` o valor não muda, porque o `cwd` já é a raiz.

## 8. Riscos

- Ao mover ou renomear o projeto, o `realpath` muda e o vínculo deixa de valer. O servidor cai na fonte padrão com aviso no stderr (D2.4).
- Perder `fingerprint.key` invalida todos os vínculos. O servidor deve dizer isso e pedir um novo `--bind`, sem recriar a chave em silêncio.

## 9. Decisões (resolvidas)

> Todas as recomendações abaixo foram aplicadas na implementação.

| ID | Decisão | Recomendação |
|---|---|---|
| D2.1 | Onde guardar o vínculo: diretório do usuário ou arquivo `.mongodb-mcp.json` no projeto | Diretório do usuário. Não toca o repositório e não corre risco de commit; o fingerprint depende de uma chave local, então não serviria para outras máquinas |
| D2.2 | Fingerprint sobre as variáveis brutas ou sobre a configuração normalizada (por exemplo, `ONLY_READ` ausente igual a `true`) | Variáveis brutas. É mais simples e previsível; uma mudança só de forma exige um novo `--bind` |
| D2.3 | Exigir `--from-env` (quebra o exemplo do README) ou só listar e importar | Exigir `--from-env`. É o que impede o vazamento entre configurações relatado |
| D2.4 | Vínculo ausente com `MONGODB_MCP_WORKSPACE` definido: cair na fonte padrão com aviso ou falhar | Cair na fonte padrão com aviso, para não quebrar quem ainda não usa perfis |
| D2.5 | Fazer `--bind` automaticamente quando `--profile` for usado com `--vscode`/`--copilot` | Sim, porque é a intenção natural desse fluxo |
