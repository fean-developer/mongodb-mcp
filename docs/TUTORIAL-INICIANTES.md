# Tutorial para iniciantes: MongoDB Read-Only MCP

Este guia mostra, **na ordem em que você executa**, como instalar, configurar e usar o MCP do MongoDB somente leitura no VS Code e no Copilot CLI. No fim há uma referência de todas as opções do configurador e das variáveis de ambiente.

> **O que é este MCP?** Um *servidor MCP* é um programa que dá ferramentas ao Copilot. Este servidor permite que o Copilot **consulte** um MongoDB (listar bancos e coleções, buscar e contar documentos) **sem alterar nada**. A senha não fica na configuração do VS Code: a conexão é guardada num arquivo privado do seu usuário ou no cofre de senhas do sistema.

## Sumário

1. [Pré-requisitos](#passo-1--pré-requisitos)
2. [Obter o pacote](#passo-2--obter-o-pacote)
3. [Instalar globalmente](#passo-3--instalar-globalmente)
4. [Configurar a primeira conexão](#passo-4--configurar-a-primeira-conexão)
5. [Verificar a conexão](#passo-5--verificar-a-conexão)
6. [Registrar no VS Code](#passo-6--registrar-no-vs-code)
7. [Registrar no Copilot CLI](#passo-7--registrar-no-copilot-cli)
8. [Usar as tools](#passo-8--usar-as-tools)
9. [Mais de uma conexão: perfis](#passo-9--mais-de-uma-conexão-perfis)
10. [Atualizar e desinstalar](#passo-10--atualizar-e-desinstalar)
11. [Referência: opções do configurador](#referência-opções-do-configurador)
12. [Referência: variáveis de ambiente](#referência-variáveis-de-ambiente)
13. [Problemas comuns](#problemas-comuns)
14. [Glossário](#glossário)

---

## Passo 1 — Pré-requisitos

| Item | Como conferir | Observação |
|---|---|---|
| Node.js **20.19 ou superior** | `node --version` | Recomendado instalar com [nvm](https://github.com/nvm-sh/nvm). |
| npm | `npm --version` | Vem com o Node.js. |
| Um MongoDB acessível | — | Local (`mongodb://localhost:27017`) ou remoto (Atlas, servidor corporativo). |
| VS Code com GitHub Copilot **ou** Copilot CLI | `code --version` / `copilot --version` | Pelo menos um dos dois. |

> **WSL, SSH ou container:** instale e configure **no mesmo ambiente em que o servidor MCP vai rodar**. Se você usa o VS Code do Windows conectado ao WSL, abra o terminal **do WSL** e execute todos os comandos lá.

## Passo 2 — Obter o pacote

Após a publicação, o pacote estará disponível no npm como `@fean-developer/mongodb-readonly-mcp`. Antes disso, você pode usar um arquivo `.tgz` fornecido por quem mantém o projeto ou gerá-lo na pasta do repositório:

```sh
npm ci      # instala dependências e compila
npm test    # opcional: roda os testes
npm pack    # gera fean-developer-mongodb-readonly-mcp-2.0.0.tgz
```

## Passo 3 — Instalar globalmente

Se você instalou anteriormente o pacote sem escopo, remova-o primeiro com `npm uninstall -g mongodb-readonly-mcp` para evitar conflito entre os comandos. A configuração privada e os segredos são preservados.

Após a publicação no npm:

```sh
npm install -g @fean-developer/mongodb-readonly-mcp
```

Ou, para instalar o arquivo gerado localmente:

```sh
npm install -g ./fean-developer-mongodb-readonly-mcp-2.0.0.tgz
```

Confira os comandos instalados:

```sh
command -v mongodb-readonly-mcp mongodb-readonly-mcp-configure
```

O segundo comando deve mostrar dois caminhos. A instalação cria dois comandos:

| Comando | Para que serve |
|---|---|
| `mongodb-readonly-mcp` | O **servidor** MCP. Você não o executa à mão: o VS Code ou o Copilot o iniciam. |
| `mongodb-readonly-mcp-configure` | O **configurador**. Você o usa no terminal para salvar e testar a conexão. |

> Se `npm install -g` pedir `sudo`, não use `sudo`. Configure um prefixo do usuário (`npm config set prefix ~/.local`, com `~/.local/bin` no `PATH`) ou use nvm.

## Passo 4 — Configurar a primeira conexão

```sh
mongodb-readonly-mcp-configure
```

O configurador é interativo e segue estas etapas:

1. **Mostra o destino**, isto é, o arquivo onde vai salvar. Se já houver configuração, mostra um resumo sem senha e pergunta se deve usá-la como base.
2. **Pergunta se deve importar** as variáveis `MONGODB_*` exportadas no terminal, se houver.
3. **Pede a connection string** (`MONGODB_URI`) com digitação oculta. Exemplos:
   - Local sem senha: `mongodb://localhost:27017/`
   - Com usuário e senha: `mongodb://usuario:senha@servidor:27017/?authSource=admin`
   - Atlas: `mongodb+srv://usuario:senha@cluster0.xxxxx.mongodb.net/`
4. **Pede as restrições opcionais.** Enter mantém o valor atual e `-` remove:
   - `MONGODB_ALLOWED_DATABASES`: bancos que o Copilot pode ver, separados por vírgula (ex.: `loja,financeiro`).
   - `MONGODB_ALLOWED_COLLECTIONS`: coleções por banco, em JSON (ex.: `{"loja":["pedidos","clientes"]}`).
   - `MONGODB_ONLY_READ`: `true` (padrão, recomendado) bloqueia qualquer escrita.
   - `MONGODB_QUERY_TIMEOUT_MS`: tempo máximo de cada consulta (padrão `5000`).
5. **Testa a conexão** (resposta padrão `S`). Se falhar, nada é salvo.
6. **Mostra o resumo e pede confirmação** para salvar.
7. **Guarda os segredos** (URI e senha) no cofre do sistema: libsecret no Linux, Keychain no macOS, DPAPI no Windows. Se não houver cofre, pede confirmação para gravá-los no arquivo privado (permissão `0600`, só você lê).

> Nunca cole a URI ou a senha no chat do Copilot nem em arquivos versionados. Digite-as somente no configurador.

## Passo 5 — Verificar a conexão

```sh
mongodb-readonly-mcp-configure --check
```

Esse comando **não altera nada**. Ele conecta, confere a identidade e lista os bancos autorizados. Também mostra o arquivo usado, a origem de cada variável e o *fingerprint*, uma "impressão digital" da configuração. Se terminar com erro, corrija antes de seguir.

## Passo 6 — Registrar no VS Code

1. Abra a paleta de comandos (`Ctrl+Shift+P`) e execute **`MCP: Open User Configuration`**.
2. Adicione a entrada abaixo e salve o arquivo:

   ```json
   {
     "servers": {
       "mongodb-readonly": {
         "type": "stdio",
         "command": "mongodb-readonly-mcp"
       }
     }
   }
   ```

3. Inicie o servidor pelo link **Start** sobre a entrada ou pela view **MCP Servers - Installed**. Se preferir, recarregue a janela com **`Developer: Reload Window`**.
4. No chat do Copilot, em modo **Agent**, as tools de `mongodb-readonly` aparecem no seletor de ferramentas.

### Ícone

O servidor envia o próprio ícone (a folha do MongoDB sobre um banco de dados) no handshake MCP, no campo `serverInfo.icons`, e o mesmo ícone em cada tool (`tools/list`).

- **Onde aparece:** no seletor de ferramentas do chat (**Configure Tools…**, o ícone de ferramentas no campo do chat), ao lado de `mongodb-readonly` e de cada uma das seis tools. O servidor precisa ter iniciado pelo menos uma vez.
- **Onde não aparece:** na lista **Extensions › MCP Servers - Installed**. Nessa lista, o VS Code só mostra ícones de servidores instalados pela **galeria MCP**, como o Atlassian Rovo, porque usa os metadados da galeria e não o `serverInfo`. Servidores registrados manualmente no `mcp.json` sempre aparecem com o ícone genérico, sem linha de publicador.
- Se você atualizou de uma versão sem ícone, reinstale o pacote e reinicie o servidor com **Restart Server** ou `Developer: Reload Window`.
- O Copilot CLI não exibe ícones de servidor.

### Mensagens do servidor no Output

Ao iniciar, o servidor informa qual configuração carregou (arquivo, fonte, modo, hosts e bancos, sem segredos). Ele envia essa mensagem pelo **log do protocolo MCP**, e o VS Code a mostra no painel Output (canal `MCP: mongodb-readonly`) com o nível correto:

- `[info] Configuração carregada de …`: mensagem informativa.
- `[warning] Aviso: …`: aviso real, por exemplo, um projeto sem perfil vinculado usando o arquivo padrão compartilhado.
- `[warning] [server stderr] …`: reservado para **erros**, como configuração ausente ou inválida.

Se a fonte aparecer como `arquivo padrão compartilhado` e você quiser isolar o projeto, use [perfis](#passo-9--mais-de-uma-conexão-perfis).

## Passo 7 — Registrar no Copilot CLI

```sh
copilot mcp add mongodb-readonly -- mongodb-readonly-mcp
copilot mcp list
```

Dentro de uma sessão `copilot`, use `/mcp list` para ver se o servidor conectou.

## Passo 8 — Usar as tools

Peça em linguagem natural no chat, por exemplo:

- "Liste os bancos disponíveis no MongoDB."
- "Quantos pedidos com status `pago` existem no banco `loja`?"
- "Mostre os 5 pedidos mais caros, só com status e valor."

O Copilot escolhe entre seis tools, todas somente leitura:

| Tool | O que faz |
|---|---|
| `listDatabases` | Lista os bancos autorizados. |
| `listCollections` | Lista as coleções de um banco. |
| `find` | Busca documentos com filtro, projeção, ordenação, `limit` (até 100) e `skip`. |
| `findOne` | Busca um único documento. |
| `countDocuments` | Conta documentos que atendem a um filtro. |
| `distinct` | Lista os valores distintos de um campo (até 100). |

## Passo 9 — Mais de uma conexão: perfis

Se os bancos estão no **mesmo servidor MongoDB**, basta listar todos em `MONGODB_ALLOWED_DATABASES` (ex.: `loja,financeiro`).

Se os **servidores ou as credenciais são diferentes**, use **perfis**. Sem perfil, existe **um único arquivo padrão por usuário**: configurar o projeto B sem perfil substitui a conexão do projeto A. Os perfis evitam esse conflito.

```sh
# Projeto A
cd ~/projetos/loja
mongodb-readonly-mcp-configure --profile loja          # cria o perfil "loja"
mongodb-readonly-mcp-configure --profile loja --bind   # vincula esta pasta ao perfil

# Projeto B
cd ~/projetos/financeiro
mongodb-readonly-mcp-configure --profile financeiro
mongodb-readonly-mcp-configure --profile financeiro --bind

mongodb-readonly-mcp-configure --list-profiles         # mostra perfis e vínculos
```

O servidor precisa saber qual perfil usar. Há duas formas de informar isso.

**Opção A: um servidor por perfil.** É a mais simples. No `mcp.json`:

```json
{
  "servers": {
    "mongodb-loja": { "type": "stdio", "command": "mongodb-readonly-mcp", "env": { "MONGODB_MCP_PROFILE": "loja" } },
    "mongodb-financeiro": { "type": "stdio", "command": "mongodb-readonly-mcp", "env": { "MONGODB_MCP_PROFILE": "financeiro" } }
  }
}
```

No Copilot CLI:

```sh
copilot mcp add mongodb-loja --env MONGODB_MCP_PROFILE=loja -- mongodb-readonly-mcp
```

**Opção B: um único servidor que segue a pasta aberta**, usando o vínculo criado com `--bind`:

```json
{
  "servers": {
    "mongodb-readonly": {
      "type": "stdio",
      "command": "mongodb-readonly-mcp",
      "env": { "MONGODB_MCP_WORKSPACE": "${workspaceFolder}" }
    }
  }
}
```

> No `env`, coloque **somente** o nome do perfil ou a pasta, **nunca** a URI ou a senha.

## Passo 10 — Atualizar e desinstalar

```sh
# Atualizar após a publicação no npm
npm install -g @fean-developer/mongodb-readonly-mcp@latest
# Em seguida, reinicie o servidor no VS Code (Restart Server) ou recarregue a janela.

# Desinstalar (apague as configurações antes, se não for mais usá-las)
mongodb-readonly-mcp-configure --reset
mongodb-readonly-mcp-configure --reset --profile loja
npm uninstall -g @fean-developer/mongodb-readonly-mcp
copilot mcp remove mongodb-readonly
```

A desinstalação **não** apaga as configurações nem os segredos do cofre. Por isso, execute `--reset` antes.

---

## Referência: opções do configurador

```text
mongodb-readonly-mcp-configure [opções]
```

Dentro do repositório, use `npm run configure -- [opções]`. O `--` separa as opções do npm das opções do configurador.

### Escolher o destino

| Opção | O que faz | Quando usar | Exemplo |
|---|---|---|---|
| *(nenhuma)* | Usa o **arquivo padrão** do usuário (`~/.config/mongodb-readonly-mcp/config.json`), compartilhado por todos os projetos. | Você tem uma única conexão. | `mongodb-readonly-mcp-configure` |
| `--profile <nome>` | Usa o arquivo de um **perfil** (`profiles/<nome>.json`). O nome aceita letras minúsculas, números, `-` e `_`. | Você tem mais de uma conexão ou quer isolar um projeto. | `--profile loja` |

### Gravar

| Opção | O que faz | Quando usar | Exemplo |
|---|---|---|---|
| `--save` | Modo **não interativo**: grava sem perguntas. Os valores vêm do ambiente (com `--from-env`) ou da configuração atual (com `--update`). | Scripts e automação. | `--save --from-env` |
| `--update` | Parte da configuração **já salva** e altera somente o que você informar. | Trocar só o timeout ou só os bancos. | `--update` |
| `--unset <VAR>` | **Remove** uma variável da configuração salva. Implica `--update`, pode ser repetida e não combina com `--from-env`. | Tirar uma restrição antiga. | `--unset MONGODB_ALLOWED_COLLECTIONS` |
| `--from-env` | **Importa** as variáveis `MONGODB_*` exportadas no terminal, sem perguntar. | Você já tem as variáveis exportadas. | `export MONGODB_URI` e depois `--save --from-env` |
| `--ignore-env` | **Ignora** as variáveis `MONGODB_*` do terminal. | Variáveis antigas no shell atrapalham. | `--save --update --ignore-env` |
| `--secret-store=auto` | Padrão. Usa o cofre do sistema se existir; senão, pede confirmação para gravar no arquivo. | Quase sempre. | — |
| `--secret-store=keyring` | **Exige** o cofre do sistema e falha se ele não estiver disponível. | Você quer garantir que a senha não fique em arquivo. | `--secret-store=keyring` |
| `--secret-store=file` | Grava os segredos no arquivo privado (`0600`). | SSH ou WSL sem chaveiro, ou containers. | `--secret-store=file` |

> `--from-env` e `--ignore-env` não podem ser usados juntos. Com `--save` no arquivo padrão e variáveis `MONGODB_*` no terminal, é obrigatório escolher uma das duas.

### Testar

| Opção | O que faz | Quando usar | Exemplo |
|---|---|---|---|
| `--check` | **Sozinho:** só verifica a configuração atual (conexão, identidade, bancos), sem alterar nada. **Com uma gravação:** testa antes de salvar. | Depois de configurar, ou quando algo deu errado. | `--check`, `--check --profile loja` |
| `--force` | Só funciona com `--check` numa gravação: **salva mesmo se o teste falhar**. | O banco está fora do ar agora, mas a configuração está correta. | `--save --from-env --check --force` |

### Vincular projeto e perfil

| Opção | O que faz | Quando usar | Exemplo |
|---|---|---|---|
| `--bind` | **Vincula** a pasta atual ao perfil. O servidor que recebe essa pasta em `MONGODB_MCP_WORKSPACE` passa a usar esse perfil. Guarda o fingerprint: se o perfil mudar depois, o servidor recusa conectar até você vincular de novo. Exige `--profile`. | Cada projeto com seu banco. | `--profile loja --bind` |
| `--unbind` | **Remove** o vínculo da pasta. Aceita apenas `--workspace`. | O projeto não deve mais usar o perfil. | `--unbind` |
| `--workspace <caminho>` | Usa outra pasta em vez da atual. Só funciona com `--bind`, `--unbind` ou `--check`. | Vincular ou verificar sem entrar na pasta. | `--profile loja --bind --workspace ~/projetos/loja` |

### Gerenciar

| Opção | O que faz | Quando usar | Exemplo |
|---|---|---|---|
| `--list-profiles` | Lista perfis e vínculos, **sem segredos**. Não aceita outras opções. | Ver o que já existe. | `--list-profiles` |
| `--reset` | **Apaga** a configuração (padrão ou de um perfil) e os segredos do cofre, após confirmação. Com `--save`, não pergunta. Aceita apenas `--profile` e `--save`. | Antes de desinstalar ou para recomeçar do zero. | `--reset --profile loja` |

### Abrir o cliente: `--vscode` e `--copilot`

São **atalhos** que executam duas etapas em sequência:

1. **Salvam a configuração**, como uma execução normal do configurador, com teste e confirmação.
2. **Abrem o cliente** na pasta atual:
   - `--vscode` executa `code --new-window <pasta>` e abre uma nova janela do VS Code. O comando `code` precisa estar no `PATH`.
   - `--copilot` executa `copilot` nessa pasta, abrindo uma sessão do Copilot CLI no próprio terminal. O configurador termina quando você sai da sessão.

Detalhes importantes:

- Os atalhos **não** repassam URI, senha ou outras variáveis `MONGODB_*` para o cliente. A conexão vem sempre do arquivo privado ou do cofre, o que evita que valores antigos fiquem presos na janela aberta.
- **Com `--profile`**, o atalho também **vincula** a pasta ao perfil, como `--bind`. Além disso, define no cliente aberto as variáveis `MONGODB_MCP_PROFILE`, `MONGODB_MCP_WORKSPACE` e `MONGODB_MCP_ROOT`, para que o servidor iniciado ali use esse perfil.
- **Sem `--profile`**, o configurador avisa que a janela usará o arquivo padrão, compartilhado entre os projetos.
- O atalho **não registra** o servidor no cliente. Faça isso antes, no [Passo 6](#passo-6--registrar-no-vs-code) ou no [Passo 7](#passo-7--registrar-no-copilot-cli).
- Use apenas um dos dois por vez.

```sh
cd ~/projetos/loja
mongodb-readonly-mcp-configure --profile loja --vscode    # configura "loja", vincula a pasta e abre o VS Code
mongodb-readonly-mcp-configure --profile loja --copilot   # o mesmo, abrindo o Copilot CLI
```

### Combinações úteis

```sh
mongodb-readonly-mcp-configure                                   # primeira configuração (interativa)
mongodb-readonly-mcp-configure --check                           # testar sem alterar
mongodb-readonly-mcp-configure --update                          # editar a configuração atual
mongodb-readonly-mcp-configure --unset MONGODB_ALLOWED_FIELDS    # remover uma restrição
mongodb-readonly-mcp-configure --profile loja --bind             # vincular projeto a perfil
mongodb-readonly-mcp-configure --list-profiles                   # ver perfis
mongodb-readonly-mcp-configure --reset --profile loja            # apagar perfil
```

---

## Referência: variáveis de ambiente

Normalmente você **não** precisa exportar nada: o configurador pergunta e salva. As variáveis servem para automação (`--from-env`) e para escolher a configuração no registro do servidor.

### Conexão (salvas pelo configurador)

| Variável | Obrigatória? | Valores / padrão | Para que serve |
|---|---|---|---|
| `MONGODB_URI` | Sim | `mongodb://…` ou `mongodb+srv://…` | Connection string. Tratada como **segredo**. |
| `MONGODB_AUTH_MODE` | Não | `none`, `uri`, `scram`, `oidc` (inferido se omitido) | Forma de autenticação. Use `none` (sem senha) só em MongoDB local de desenvolvimento. |
| `MONGODB_USERNAME` / `MONGODB_PASSWORD` | Só em `scram` | — | Usuário e senha separados da URI. A senha é **segredo**. |
| `MONGODB_AUTH_SOURCE` | Não | ex.: `admin` | Banco de autenticação do usuário em `scram`. |
| `MONGODB_ALLOWED_DATABASES` | Não | `loja,financeiro` | Bancos que o Copilot pode consultar. |
| `MONGODB_ALLOWED_COLLECTIONS` | Não | JSON: `{"loja":["pedidos"]}` | Coleções permitidas por banco. |
| `MONGODB_ALLOWED_FIELDS` | Não | JSON: `{"loja":{"pedidos":["_id","status"]}}` | Campos que podem ser retornados. |
| `MONGODB_ONLY_READ` | Não | `true` (padrão) ou `false` | `true` bloqueia qualquer escrita antes de chegar ao banco. |
| `MONGODB_QUERY_TIMEOUT_MS` | Não | `100` a `30000`, padrão `5000` | Tempo máximo de cada consulta. |
| `MONGODB_OIDC_*` | Só em `oidc` | ver o [tutorial avançado](TUTORIAL-AVANCADO.md#oidc-humano) | Login pelo navegador com um provedor de identidade. |

### Seleção da configuração (usadas no registro do servidor)

| Variável | Para que serve | Exemplo no `env` do `mcp.json` |
|---|---|---|
| `MONGODB_MCP_PROFILE` | O servidor usa **somente** o perfil indicado. | `"MONGODB_MCP_PROFILE": "loja"` |
| `MONGODB_MCP_WORKSPACE` | Pasta do projeto; o servidor procura o perfil vinculado com `--bind`. | `"MONGODB_MCP_WORKSPACE": "${workspaceFolder}"` |
| `MONGODB_MCP_CONFIG` | Caminho absoluto de um arquivo de configuração alternativo. Não pode ser combinada com `MONGODB_MCP_PROFILE`. | `"MONGODB_MCP_CONFIG": "/home/eu/mongo-loja.json"` |
| `MONGODB_MCP_ROOT` | Raiz da instalação. Os atalhos `--vscode`/`--copilot` a definem automaticamente; quase nunca é necessária. | — |

**Ordem em que o servidor escolhe a configuração:** `MONGODB_MCP_CONFIG` → `MONGODB_MCP_PROFILE` → perfil vinculado a `MONGODB_MCP_WORKSPACE` → arquivo padrão.

### Onde ficam os arquivos

| Sistema | Local |
|---|---|
| Linux, macOS e WSL | `~/.config/mongodb-readonly-mcp/` (ou `$XDG_CONFIG_HOME/mongodb-readonly-mcp/`) |
| Windows | `%APPDATA%\mongodb-readonly-mcp\` |

Dentro dessa pasta ficam:

- `config.json`: o arquivo padrão;
- `profiles/<nome>.json`: um arquivo por perfil;
- `bindings/`: os vínculos entre pastas e perfis;
- `fingerprint.key`: a chave local usada nos fingerprints.

---

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| `command not found: mongodb-readonly-mcp` | Confira `npm prefix -g` e se a pasta `bin` dele está no `PATH`. No VS Code, use o caminho absoluto em `command` (veja o [tutorial avançado](TUTORIAL-AVANCADO.md#4-registrar-no-cliente-uma-vez)). |
| O ícone não aparece em **MCP Servers - Installed** | É o comportamento do VS Code para servidores do `mcp.json`; o ícone aparece em **Configure Tools…** no chat. Veja [Ícone](#ícone). |
| `[warning] [server stderr] …` no Output | É um erro real; leia a mensagem. A partir desta versão, mensagens informativas aparecem como `[info]`. Se ainda vir `[server stderr] Configuração carregada…`, reinstale o pacote e reinicie o servidor. |
| Mudei a configuração e o MCP continua usando a antiga | A conexão fica fixa enquanto o servidor roda. Reinicie o servidor MCP. |
| Outro projeto "sobrescreveu" minha conexão | Você está usando o arquivo padrão compartilhado. Crie um perfil por projeto ([Passo 9](#passo-9--mais-de-uma-conexão-perfis)). |
| `O perfil "<nome>" mudou desde o vínculo…` | O perfil foi alterado depois do vínculo. Confira com `--check --profile <nome>` e renove com `--profile <nome> --bind`. |
| `O cofre do sistema (…) não está disponível` | Comum em SSH ou WSL sem chaveiro. Desbloqueie o chaveiro ou use `--secret-store=file`. |
| Erro citando "Variáveis definidas no ambiente têm precedência…" | Há `export MONGODB_*` antigos no shell. Remova-os do `.bashrc`/`.zshrc` ou use perfis, que ignoram o ambiente. |
| `Operação bloqueada: o MCP está configurado como somente leitura…` | Algo tentou escrever. Reinicie o MCP; esta versão não tem tools de escrita. |

## Glossário

| Termo | Significado |
|---|---|
| **MCP** | *Model Context Protocol*: padrão que permite ao Copilot usar ferramentas externas. |
| **Servidor stdio** | Servidor MCP que o cliente inicia como processo local, conversando com ele pela entrada e saída padrão. |
| **Tool** | Uma ação que o Copilot pode chamar, como `find` ou `listDatabases`. |
| **Connection string / URI** | Endereço do MongoDB; pode conter usuário e senha. |
| **Perfil** | Uma configuração com nome, separada do arquivo padrão. |
| **Vínculo (`--bind`)** | Associação entre uma pasta de projeto e um perfil. |
| **Fingerprint** | Resumo criptográfico da configuração, usado para detectar mudanças sem expor segredos. |
| **Cofre do sistema** | Armazenamento seguro de senhas do sistema operacional (libsecret, Keychain, DPAPI). |
