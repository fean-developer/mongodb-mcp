# Tutorial de instalação e configuração avançada

Este guia reúne detalhes de instalação, configuração, consultas e validação. Para começar passo a passo, consulte o [tutorial para iniciantes](TUTORIAL-INICIANTES.md). Os planos de evolução estão no [roadmap](ROADMAP.md).

## Instalação

Requisitos: Node.js 20.19 ou superior, npm e um MongoDB. O teste de integração também requer Docker.

Há duas formas de uso:

| Forma | Para quem | Comandos |
|---|---|---|
| **Global (recomendada para usuários)** | Quem só quer usar o MCP em qualquer projeto | `mongodb-readonly-mcp` (servidor) e `mongodb-readonly-mcp-configure` (configurador). Veja [Distribuição e instalação global](#distribuição-e-instalação-global). |
| **Repositório** | Quem desenvolve o MCP | `npm run configure` e `node dist/main.js`, como abaixo. |

Os dois configuradores aceitam as mesmas opções; com `npm run`, coloque `--` antes delas (`npm run configure -- --check`).

Instalação a partir do repositório:

```sh
npm ci
npm run configure
npm run configure -- --check
```

`npm ci` também compila o projeto (script `prepare`). O configurador mostra a configuração salva atual, pergunta se deve usá-la como base, solicita os valores ausentes, testa a conexão e exibe um resumo seguro antes de pedir confirmação para salvar. Variáveis `MONGODB_*` exportadas no terminal só são importadas com confirmação (ou `--from-env`). O último comando verifica a conexão e as permissões usando operações de leitura, sem mostrar segredos.

O servidor lê o ambiente do seu processo e, para valores ausentes ou vazios, a configuração privada do usuário. Ele não carrega arquivos `.env` nem executa arquivos de inicialização do shell. URI, senhas e tokens são segredos: não os coloque em comandos, histórico do shell, configurações versionadas ou mensagens de chat. A entrada interativa da URI e da senha é oculta.

## Identidade e permissões

O usuário MongoDB **não precisa** ser somente leitura. Ele pode ter `readWrite`, `dbOwner` ou até `root`: quem decide se o MCP pode alterar dados é a configuração `MONGODB_ONLY_READ`, não as roles do banco. Nos modos com autenticação, o servidor exige apenas que a conexão tenha exatamente uma identidade autenticada; no modo `none`, que não haja identidade.

### Guardrail `MONGODB_ONLY_READ`

| Valor | Efeito |
|---|---|
| `true` (**padrão**, inclusive quando a variável não existe) | O MCP executa somente leituras, independentemente das permissões do usuário. |
| `false` | A trava de leitura do MCP é desativada, mas a [proteção contra escrita em massa](#proteção-contra-escrita-em-massa) continua ativa. Esta versão ainda expõe apenas tools de leitura; o servidor emite um aviso (log MCP `warning`) ao iniciar. |

Com `true`, a garantia tem duas camadas:

1. **Tools:** o servidor só oferece `listDatabases`, `listCollections`, `find`, `findOne`, `countDocuments` e `distinct`. Nomes desconhecidos são rejeitados.
2. **Protocolo:** todo comando enviado pelo driver passa por uma allowlist antes de sair do processo (`find`, `getMore`, `aggregate`, `count`, `distinct`, `listCollections`, `listDatabases`, `listIndexes`, `connectionStatus`, `killCursors`, `endSessions` e comandos de handshake/autenticação). `aggregate` com `$out` ou `$merge` também é bloqueado. Qualquer outro comando (`insert`, `update`, `delete`, `findAndModify`, `drop`, `create*`, `createUser`…) é interrompido **antes** de chegar ao MongoDB, e o servidor passa a recusar todas as operações seguintes até ser reiniciado (fail closed).

### Proteção contra escrita em massa

Com `MONGODB_ONLY_READ=false`, todo comando enviado pelo driver ainda passa por um segundo guardrail, sempre ativo e sem opção para desligar: `updateMany` e `deleteMany` com filtro vazio (`{}` ou ausente) são bloqueados **antes** de chegar ao MongoDB, porque alterariam ou apagariam a coleção inteira. A regra vale também dentro de `bulkWrite`. Escritas com filtro (`{ status: "inativo" }`), `updateOne`/`deleteOne` e inserts seguem normalmente; o bloqueio não desativa o servidor. Erro retornado: `Operação bloqueada: updateMany/deleteMany com filtro vazio afetaria todos os documentos da coleção.`

O guardrail detecta apenas filtro **vazio**; um filtro que case com todos os documentos (ex.: `{ _id: { $exists: true } }`) não é reconhecido como escrita em massa. Com `MONGODB_ONLY_READ=true` essa proteção é redundante, pois nenhuma escrita sai do processo.

Mesmo com a trava, o princípio do menor privilégio continua recomendado: um usuário `read` protege os dados também contra outros clientes que usem as mesmas credenciais e contra falhas fora do MCP. Valores aceitos: `true` ou `false` (sem diferenciar maiúsculas); qualquer outro valor é erro de configuração.

As allowlists do MCP restringem o acesso, mas não substituem as permissões do MongoDB. Resultados enviados ao cliente MCP podem ser usados pelo cliente ou modelo: autorize apenas dados adequados para essa finalidade.

Para MongoDB **sem autenticação**, qualquer cliente com acesso ao MongoDB pode alterar dados fora do MCP. Use esse modo apenas em ambiente de desenvolvimento local e isolado.

## Configuração

| Variável | Uso |
|---|---|
| `MONGODB_URI` | Obrigatória: URI `mongodb://` ou `mongodb+srv://`, tratada integralmente como segredo. |
| `MONGODB_MCP_CONFIG` | Opcional: caminho absoluto de uma configuração privada alternativa; use o mesmo caminho no configurador e no ambiente do servidor. Não pode ser combinada com `MONGODB_MCP_PROFILE`. |
| `MONGODB_MCP_PROFILE` | Opcional: nome de um [perfil](#perfis-e-vínculo-por-workspace) (`[a-z0-9][a-z0-9_-]{0,63}`). O servidor usa somente o arquivo do perfil. |
| `MONGODB_MCP_WORKSPACE` | Opcional: pasta do projeto, usada pelo servidor para encontrar o perfil vinculado com `--bind`. Os launchers a definem automaticamente. |
| `MONGODB_AUTH_MODE` | Opcional: `none`, `uri`, `scram` ou `oidc`. Se omitida, o modo é inferido da URI, das credenciais e das variáveis OIDC. |
| `MONGODB_ALLOWED_DATABASES` | Opcional: nomes separados por vírgula, por exemplo `loja`. Sem ela, são usados os bancos acessíveis pela conexão; sem autenticação, todos os bancos válidos estão acessíveis. |
| `MONGODB_ALLOWED_COLLECTIONS` | Opcional: JSON para restringir coleções por banco, por exemplo `{"loja":["pedidos"]}`. Sem ela, todas as coleções válidas ficam disponíveis, exceto `system.*`. |
| `MONGODB_ALLOWED_FIELDS` | Opcional: JSON por banco e coleção, por exemplo `{"loja":{"pedidos":["_id","status","valor","criadoEm"]}}`. |
| `MONGODB_QUERY_TIMEOUT_MS` | Opcional: `100` a `30000`; padrão `5000`. Usado como `maxTimeMS` onde suportado. |
| `MONGODB_ONLY_READ` | Opcional: `true` (padrão) ou `false`. Com `true`, o guardrail do MCP bloqueia qualquer comando que não seja leitura, mesmo que o usuário tenha permissão de escrita. Veja [Guardrail](#guardrail-mongodb_only_read). |
| `MONGODB_USERNAME`, `MONGODB_PASSWORD` | Obrigatórias em `scram`; o modo SCRAM é inferido quando a URI não traz identidade e essas credenciais são fornecidas. Não aceitas separadamente nos demais modos. |
| `MONGODB_AUTH_SOURCE` | Opcional em `scram`; não pode conflitar com a URI. |

As listas não aceitam curingas. Mesmo sem allowlists explícitas, são bloqueados os bancos `admin`, `config` e `local` e as coleções `system.*`. Quando há autenticação, o MongoDB também aplica as permissões da identidade. Cada lista tem até 100 entradas; cada configuração JSON de política tem até 65.536 bytes. Se `MONGODB_ALLOWED_COLLECTIONS` for informada, bancos omitidos do objeto permanecem sem restrição de coleções.

Quando uma coleção tem `MONGODB_ALLOWED_FIELDS`, os caminhos são exatos e também restringem filtro, ordenação, projeção e `distinct`. Sem projeção, somente esses campos são retornados; `_id` é excluído se não estiver autorizado. Autorizar um campo pai permite retornar todo o seu subdocumento. Coleções sem entrada em `MONGODB_ALLOWED_FIELDS` não têm restrição adicional de campos.

### Modos de autenticação

- **`none`**: conexão sem autenticação. É inferido quando a URI não contém credenciais nem opções de autenticação e não há credenciais separadas ou configuração OIDC. Não aceita credenciais nem opções de autenticação. O servidor emite um aviso e mantém os guardrails de leitura.
- **`scram`**: URI sem credenciais embutidas; usuário e senha são fornecidos separadamente. O mecanismo é SCRAM-SHA-256. É inferido quando há credenciais separadas ou opções de autenticação SCRAM na URI.
- **`uri`**: opções e, quando aplicável, credenciais ficam na URI. O modo é inferido quando a URI já contém credenciais ou configura `MONGODB-X509`/`MONGODB-AWS`. Não informe também usuário, senha ou `MONGODB_AUTH_SOURCE` separados.
- **`oidc`**: fluxo humano no navegador, sem fallback para SCRAM. É inferido quando a URI usa `authMechanism=MONGODB-OIDC` ou há configuração OIDC no ambiente.

O servidor rejeita opções que desabilitam validação de certificados/hostnames e `NODE_TLS_REJECT_UNAUTHORIZED=0`. Use TLS também nos modos `uri` e `scram`, especialmente fora do ambiente local. Se o MongoDB exigir SCRAM, mas a URI não indicar autenticação, defina `MONGODB_AUTH_MODE=scram` para solicitar usuário e senha.

### OIDC humano

O deployment MongoDB deve estar configurado para `MONGODB-OIDC` e associar o usuário autenticado à identidade de leitura. O provedor deve suportar Authorization Code com PKCE S256 e um cliente público com a URI de redirecionamento registrada. O issuer e o client ID retornados pelo MongoDB devem coincidir exatamente com os configurados. Os endpoints de autorização e token devem ser HTTPS e usar hosts explicitamente autorizados.

| Variável | Uso |
|---|---|
| `MONGODB_OIDC_ISSUER` | Obrigatória: issuer HTTPS exato. |
| `MONGODB_OIDC_CLIENT_ID` | Obrigatória: ID do cliente público. |
| `MONGODB_OIDC_MONGO_HOSTS` | Obrigatória: hosts MongoDB permitidos, separados por vírgula; aceita `*.exemplo.com`. |
| `MONGODB_OIDC_PROVIDER_HOSTS` | Obrigatória: hosts HTTPS exatos do issuer e dos endpoints do provedor, separados por vírgula. |
| `MONGODB_OIDC_ALLOWED_SCOPES` | Opcional: escopos permitidos, separados por vírgula; padrão `openid`. |
| `MONGODB_OIDC_REDIRECT_URI` | Opcional: padrão `http://127.0.0.1:8400/callback`; deve usar loopback, porta explícita >= 1024 e caminho `/callback`. |

Exemplo de valores não secretos:

```sh
export MONGODB_AUTH_MODE=oidc
export MONGODB_OIDC_ISSUER=https://login.example.com/tenant
export MONGODB_OIDC_CLIENT_ID=cliente-publico
export MONGODB_OIDC_MONGO_HOSTS=cluster.example.com
export MONGODB_OIDC_PROVIDER_HOSTS=login.example.com
```

Na URI `mongodb://`, habilite `tls=true`; em `mongodb+srv://`, TLS deve permanecer habilitado. O navegador precisa acessar o callback no mesmo ambiente de execução, e a porta deve estar livre. A senha é digitada somente na página do provedor. O fluxo valida `state`, `nonce`, PKCE e hosts; tokens não são persistidos pelo servidor. Este fluxo foi testado com provedor simulado, não com um provedor OIDC real.

## Configuração simples e reutilizável

Execute o configurador (`mongodb-readonly-mcp-configure` na instalação global ou `npm run configure` no repositório) no terminal do **mesmo ambiente e usuário em que o MCP roda**. No WSL, SSH ou container, use o terminal desse ambiente, não o terminal do Windows ou de outra máquina.

1. O configurador mostra o destino (arquivo padrão, perfil ou `MONGODB_MCP_CONFIG`) e, se já houver configuração, um resumo seguro dela (modo, hosts, usuário, bancos, restrições), oferecendo usá-la como base. Sem `--update`, valores salvos **não** são reaproveitados silenciosamente.
2. Se houver variáveis `MONGODB_*` exportadas, ele pergunta se deve importá-las. Valores ausentes são pedidos no prompt (URI e senha com entrada oculta, limitada a 8.192 caracteres).
3. O modo de autenticação é inferido. Para exigir SCRAM com credenciais separadas, use `MONGODB_AUTH_MODE=scram npm run configure`. Um MongoDB local sem autenticação não exige usuário ou senha. Restrições opcionais (bancos, coleções, campos, somente leitura, timeout) podem ser preenchidas no mesmo fluxo.
4. A conexão é testada antes de salvar (padrão `S`); se falhar, nada é gravado, salvo com `--check --force`. Por fim, o resumo do que será salvo é exibido e a gravação exige confirmação.
5. Segredos (`MONGODB_URI`, `MONGODB_PASSWORD`) vão para o cofre do sistema quando disponível (libsecret no Linux, Keychain no macOS, DPAPI no Windows); caso contrário, o configurador pede confirmação para gravá-los em texto no arquivo `0600`. `--secret-store=keyring` exige o cofre; `--secret-store=file` grava no arquivo.
6. Execute `npm run configure -- --check` para verificar conexão, identidade e listagem de bancos autorizados sem alterar nada. A saída informa arquivo, fonte, origem de cada variável e o fingerprint. Falhas retornam código de saída diferente de zero, sem mostrar a URI ou a senha.

Um `MONGODB_AUTH_MODE` explícito tem precedência sobre a inferência. Se ele estiver como `uri`, mas o banco não usar autenticação, o configurador não rebaixa a segurança automaticamente: execute `MONGODB_AUTH_MODE=none npm run configure` para configurar esse banco local. Não use `none` para contornar autenticação exigida pelo MongoDB.

Somente variáveis MongoDB suportadas são salvas, nunca o ambiente inteiro ou tokens de sessão OIDC. Variáveis de outro modo de autenticação (por exemplo, `MONGODB_USERNAME` ao trocar para `uri`) não são carregadas para a nova configuração.

Opções do configurador:

| Opção | Efeito |
|---|---|
| `--profile <nome>` | Usa o arquivo do perfil em vez do arquivo padrão. |
| `--save` | Modo não interativo: grava sem perguntas. |
| `--update` | Parte da configuração salva e altera somente o que for informado. |
| `--unset <VAR>` | Remove a variável da configuração salva (implica `--update`); pode ser repetida. |
| `--from-env` / `--ignore-env` | Importa ou ignora explicitamente as variáveis `MONGODB_*` do ambiente. |
| `--secret-store=auto\|keyring\|file` | Onde guardar segredos (padrão `auto`). |
| `--check [--force]` | Sozinho, só verifica; junto de uma gravação, testa antes e (com `--force`) salva mesmo se falhar. |
| `--bind` / `--unbind [--workspace <caminho>]` | Vincula/desvincula o perfil à pasta do projeto. |
| `--reset [--profile <nome>]` | Remove a configuração (e os segredos do cofre) após confirmação, ou sem perguntas com `--save`. |
| `--list-profiles` | Lista perfis e vínculos sem mostrar segredos. |
| `--vscode` / `--copilot` | Salva e abre o cliente na pasta atual. |

### Arquivo privado e precedência

- Linux/macOS: `$XDG_CONFIG_HOME/mongodb-readonly-mcp/config.json`, ou `~/.config/mongodb-readonly-mcp/config.json` quando XDG não estiver definido.
- Windows: `%APPDATA%/mongodb-readonly-mcp/config.json`, ou `~/.config/mongodb-readonly-mcp/config.json` se APPDATA não estiver definido.
- Perfis: `profiles/<nome>.json` no mesmo diretório; vínculos de workspace em `bindings/`.
- `MONGODB_MCP_CONFIG` substitui o caminho padrão e permite configurações diferentes para vários servidores; `~` é expandido. Um caminho fora do diretório da aplicação gera aviso.
- No Linux/macOS, o configurador cria somente o diretório da aplicação e seus subdiretórios com modo `0700` (diretórios pais não são alterados) e grava o arquivo atomicamente (`fsync` do arquivo e do diretório) com modo `0600`, sob um lock que impede que duas execuções simultâneas se sobrescrevam. O servidor rejeita arquivos de outro usuário, links simbólicos e permissões que exponham o arquivo a grupo/outros. No Windows, o configurador remove a herança de ACL e concede acesso somente ao usuário atual (`icacls`).
- Com segredos no cofre, o arquivo usa o formato `{"version": 2, "variables": {...}, "secrets": {...}}`, em que `secrets` guarda apenas referências. O formato antigo (objeto simples) continua aceito.
- Ordem de resolução do servidor: `MONGODB_MCP_CONFIG` → `MONGODB_MCP_PROFILE` → perfil vinculado a `MONGODB_MCP_WORKSPACE` → arquivo padrão. A fonte usada é registrada no log MCP do servidor, no nível `info` (arquivo, tipo de fonte, modo, hosts, bancos e fingerprint), sem segredos.
- **Com arquivo explícito ou perfil**, o arquivo é a única fonte: variáveis `MONGODB_*` herdadas do cliente são ignoradas. É a forma recomendada de registrar o MCP. O configurador também ignora o ambiente nesses destinos, exceto com `--from-env`.
- Com o arquivo padrão, valores não vazios do ambiente do processo têm precedência sobre os salvos, variável por variável, e o servidor avisa quais variáveis do arquivo foram sobrescritas. Para remover uma variável persistida, use `--unset <VAR>`. Configurações conflitantes ou arquivos inválidos geram erro explícito, sem fallback silencioso.

Para importar um ambiente completo sem interação, após consentir explicitamente com a persistência, use:

```sh
export MONGODB_URI
npm run configure -- --save --from-env
```

Esse comando não recebe segredos por argumentos e não imprime seus valores. Sem `--from-env` ou `--ignore-env`, `--save` recusa gravar no arquivo padrão quando há variáveis `MONGODB_*` no ambiente, para evitar importações acidentais. Ele precisa das variáveis **exportadas**; `echo $MONGODB_URI` sozinho apenas comprova que o shell conhece o valor. Se um valor obrigatório faltar, use o configurador interativo.

O ambiente de um terminal não modifica retroativamente o VS Code, o Extension Host ou um MCP já aberto. A configuração privada resolve esse limite sem tentar ler a memória de outro processo ou executar `.bashrc`/`.zshrc`. Se o MCP iniciar sem configuração, ele permanece disponível e relê o arquivo na próxima tool, até conseguir configurar-se. Uma conexão já configurada fica fixa até reiniciar o MCP, evitando trocar o banco silenciosamente durante uma sessão. Com perfil vinculado, o servidor também confere o fingerprint do perfil: se outro configurador alterou o arquivo depois do vínculo, ele recusa a conexão até que `--bind` seja executado de novo. **Ao atualizar uma instalação antiga para esta versão, reinicie o MCP uma vez para carregar o novo código.**

O painel MCP do VS Code e uma sessão do Copilot SDK/CLI podem manter processos distintos do mesmo servidor. Reiniciar um não reinicia necessariamente o outro. Se uma sessão continuar mostrando o diagnóstico da versão antiga após a atualização, reinicie o cliente que mantém essa sessão; no VS Code com Copilot SDK, use `Developer: Reload Window` para recriar a conexão do agent host.

### VS Code e Copilot CLI

No workspace, `.vscode/mcp.json` registra `mongodb-readonly`. Confie no workspace e inicie o servidor pelo VS Code/Copilot. Ele encontra a configuração privada no ambiente em que o Node está executando, mesmo que o VS Code tenha sido aberto antes da configuração ou pelo Windows.

A configuração portátil `.mcp.json` é usada pelo Copilot CLI e por clientes compatíveis. Ela herda o ambiente sem substituí-lo por valores vazios e funciona ao iniciar `copilot` na raiz do projeto. Autorize a confiança nesse workspace quando o cliente solicitar; sem isso, o CLI pode ignorar o arquivo. Não é necessário aprovar todas as tools. `MONGODB_MCP_ROOT` é opcional para indicar outra raiz de instalação; os launchers o definem automaticamente. `copilot mcp list` mostra a configuração; `/mcp list` na sessão mostra o estado da conexão.

Opcionalmente, `--vscode` ou `--copilot` salva a configuração com consentimento e abre o cliente na pasta atual (com `npm run`, a raiz do repositório). O VS Code usa o perfil normal, sem perfil isolado temporário. Os launchers **não** repassam variáveis `MONGODB_*` ao cliente: a conexão vem sempre do arquivo privado, evitando que valores antigos fiquem presos no ambiente da janela aberta. Com `--profile`, eles definem `MONGODB_MCP_PROFILE` e `MONGODB_MCP_WORKSPACE` para o cliente aberto.

Para usar o MCP em outros workspaces, prefira a [instalação global](#distribuição-e-instalação-global). Sem ela, registre o entrypoint compilado com **caminho absoluto**, sem credenciais na configuração do cliente. Exemplo para VS Code:

```json
{
  "servers": {
    "mongodb-readonly": {
      "type": "stdio",
      "command": "node",
      "args": ["/caminho/absoluto/mongodb-mcp/dist/main.js"]
    }
  }
}
```

Em clientes que usam o formato portátil, troque `servers` por `mcpServers`. Se precisar selecionar outra configuração privada, adicione `env` com `MONGODB_MCP_PROFILE` (ou `MONGODB_MCP_CONFIG` com o caminho absoluto do arquivo), nunca com a URI ou senha. O Node deve estar disponível no ambiente do cliente.

O servidor não solicita credenciais pelo protocolo MCP. Se faltar configuração ou ela for inválida, o processo permanece ativo e as tools retornam um diagnóstico sanitizado (sem URI ou senha); use o terminal para inserir segredos, nunca a conversa.

### Solução de problemas

| Sintoma | Causa | Correção |
| --- | --- | --- |
| Erro de conexão/autenticação mesmo com o arquivo correto, e a mensagem cita "Variáveis definidas no ambiente têm precedência…" | Variáveis `MONGODB_*` antigas no ambiente do terminal ou da janela do VS Code têm precedência sobre o arquivo. A mensagem lista quais variáveis estão no ambiente. | Solução definitiva: adicione `"env": { "MONGODB_MCP_CONFIG": "/caminho/absoluto/config.json" }` ao registro do servidor; o ambiente herdado passa a ser ignorado. Também remova `export MONGODB_*` de `.bashrc`/`.zshrc` e arquivos carregados por eles. Para inspecionar: `env \| grep -o '^MONGODB_[A-Z_]*'` para ver; `unset MONGODB_URI MONGODB_AUTH_MODE MONGODB_ALLOWED_DATABASES`; feche a janela do VS Code aberta por esse terminal (ou por versões antigas de `--vscode`) e reabra a pasta normalmente. Em VS Code Remote, se persistir, encerre o VS Code Server do host. |
| `Operação bloqueada: o MCP está configurado como somente leitura…` | Algum comando de escrita chegou ao guardrail com `MONGODB_ONLY_READ=true`. O servidor passa a recusar tudo depois disso. | Reinicie o MCP. Se a escrita era intencional, avalie `MONGODB_ONLY_READ=false` (esta versão não tem tools de escrita). |
| `Operação bloqueada: updateMany/deleteMany com filtro vazio…` | Com `MONGODB_ONLY_READ=false`, uma atualização ou exclusão múltipla foi enviada sem filtro. | Informe um filtro que selecione apenas os documentos desejados. Não há como desativar essa proteção. |
| `A conexão MongoDB deve usar exatamente uma identidade autenticada.` | Modo `uri`/`scram`/`oidc` sem usuário efetivamente autenticado. | Confira credenciais e `MONGODB_AUTH_MODE`; para MongoDB sem autenticação, use `none`. |
| Configuração mudou, mas o MCP usa a anterior | A conexão fica fixa durante a vida do processo. | Reinicie o servidor MCP (ou `Developer: Reload Window`). |
| `O perfil "<nome>" mudou desde o vínculo com este workspace` | Outro terminal reconfigurou o perfil vinculado. | Confira com `--check --profile <nome>` e execute `--profile <nome> --bind` no projeto para aceitar a nova configuração. |
| `Aviso: nenhum perfil vinculado ao workspace …` no log do servidor (`[warning]`) | O servidor recebeu `MONGODB_MCP_WORKSPACE`, mas o projeto não tem vínculo; ele usa o arquivo padrão compartilhado. | Execute `mongodb-readonly-mcp-configure --profile <nome> --bind` na pasta do projeto. |
| `foi alterado por outra execução durante a configuração` | Duas execuções do configurador gravaram o mesmo arquivo ao mesmo tempo. | Execute de novo; a gravação anterior foi preservada. |
| `O cofre do sistema (…) não está disponível` | Chaveiro bloqueado, ausente ou sem sessão D-Bus (comum em SSH/WSL). | Desbloqueie o chaveiro ou use `--secret-store=file`. |

O arquivo padrão é **único por usuário**: executar o configurador sem perfil em outro projeto sobrescreve a conexão anterior (o configurador mostra a configuração atual e pede confirmação antes). Para manter conexões diferentes, use perfis.

### Perfis e vínculo por workspace

Um perfil é um arquivo privado com nome, independente do arquivo padrão. Vincular um perfil a uma pasta faz o servidor iniciado nesse projeto usar sempre aquele perfil, mesmo que outro projeto reconfigure o arquivo padrão:

```sh
cd ~/projetos/flowboard
mongodb-readonly-mcp-configure --profile flowboard          # cria/edita o perfil
mongodb-readonly-mcp-configure --profile flowboard --bind   # vincula esta pasta ao perfil
mongodb-readonly-mcp-configure --check                      # nesta pasta, verifica o perfil vinculado
mongodb-readonly-mcp-configure --list-profiles              # perfis e vínculos, sem segredos
mongodb-readonly-mcp-configure --unbind                     # remove o vínculo desta pasta
mongodb-readonly-mcp-configure --reset --profile flowboard   # remove o perfil e seus segredos
```

O vínculo guarda o fingerprint (HMAC-SHA-256 com chave local) da configuração do perfil. Se o perfil for alterado depois, o servidor recusa a conexão até o vínculo ser renovado com `--bind`, evitando trocar de banco sem perceber. Para o servidor encontrar o vínculo, ele precisa receber a pasta do projeto em `MONGODB_MCP_WORKSPACE`; os launchers `--vscode`/`--copilot` fazem isso. No registro manual do VS Code, use `"env": { "MONGODB_MCP_WORKSPACE": "${workspaceFolder}" }`, ou defina diretamente `MONGODB_MCP_PROFILE`.

### Dois ou mais bancos

**Mesma conexão (mesmo MongoDB/cluster):** um único servidor MCP atende vários bancos. Liste-os em `MONGODB_ALLOWED_DATABASES`, separados por vírgula. As tools recebem o banco como parâmetro.

```sh
export MONGODB_URI='mongodb://localhost:27017/'
export MONGODB_AUTH_MODE=none
export MONGODB_ALLOWED_DATABASES='flowboard,loja,analytics'
# opcional: restringe coleções por banco (JSON)
export MONGODB_ALLOWED_COLLECTIONS='{"loja":["pedidos","clientes"]}'
mongodb-readonly-mcp-configure --save --from-env
mongodb-readonly-mcp-configure --check
```

Arquivo resultante, sem segredos no cofre (os valores são sempre strings; políticas JSON ficam serializadas):

```json
{
  "MONGODB_URI": "mongodb://localhost:27017/",
  "MONGODB_AUTH_MODE": "none",
  "MONGODB_ALLOWED_DATABASES": "flowboard,loja,analytics",
  "MONGODB_ALLOWED_COLLECTIONS": "{\"loja\":[\"pedidos\",\"clientes\"]}"
}
```

O usuário pode ter qualquer permissão nesses bancos: com `MONGODB_ONLY_READ=true` (padrão) o MCP só lê.

**Conexões diferentes (servidores, credenciais ou modos de autenticação distintos):** registre uma instância do MCP por conexão, cada uma com seu perfil. Com perfil, variáveis exportadas no terminal só são usadas com `--from-env`:

```sh
# 1) MongoDB local, sem autenticação
MONGODB_URI='mongodb://localhost:27017/flowboard' MONGODB_AUTH_MODE=none \
MONGODB_ALLOWED_DATABASES=flowboard \
  mongodb-readonly-mcp-configure --profile flowboard --save --from-env
mongodb-readonly-mcp-configure --profile flowboard --check

# 2) MongoDB corporativo (URI digitada no prompt oculto); MONGODB_ONLY_READ=true é o padrão
mongodb-readonly-mcp-configure --profile corporativo
mongodb-readonly-mcp-configure --profile corporativo --check
```

Registro no VS Code (`.vscode/mcp.json` ou configuração de usuário). `env` contém apenas o nome do perfil, nunca URI ou senha:

```json
{
  "servers": {
    "mongodb-flowboard": {
      "type": "stdio",
      "command": "mongodb-readonly-mcp",
      "env": { "MONGODB_MCP_PROFILE": "flowboard" }
    },
    "mongodb-corporativo": {
      "type": "stdio",
      "command": "mongodb-readonly-mcp",
      "env": { "MONGODB_MCP_PROFILE": "corporativo" }
    }
  }
}
```

No Copilot CLI:

```sh
copilot mcp add mongodb-flowboard --env MONGODB_MCP_PROFILE=flowboard -- mongodb-readonly-mcp
copilot mcp add mongodb-corporativo --env MONGODB_MCP_PROFILE=corporativo -- mongodb-readonly-mcp
```

Cada instância aparece com suas próprias tools (`mongodb-flowboard-find`, `mongodb-corporativo-find`, …). Como cada instância define o perfil, ela usa somente o próprio arquivo, mesmo que o ambiente do cliente tenha variáveis `MONGODB_*` antigas. `MONGODB_MCP_CONFIG` com caminhos absolutos continua funcionando da mesma forma, para quem já a utiliza.

## Distribuição e instalação global

O pacote expõe dois comandos: `mongodb-readonly-mcp`, o servidor MCP stdio, e `mongodb-readonly-mcp-configure`, o configurador. Instalado globalmente, o MCP funciona em qualquer pasta, sem clonar o repositório, sem `MONGODB_MCP_ROOT` e sem credenciais na configuração do cliente.

### 1. Gerar o pacote (mantenedor)

```sh
npm ci
npm test
npm pack
```

`npm pack` compila o projeto e gera `fean-developer-mongodb-readonly-mcp-<versão>.tgz`. O pacote contém `dist/`, `docs/`, os ícones, `README.md`, `LICENSE`, `server.json` e `package.json`; código-fonte, testes, `.env` e configurações privadas não são incluídos. Confira o conteúdo com `tar -tzf fean-developer-mongodb-readonly-mcp-2.0.0.tgz`.

Formas de distribuição:

| Canal | Como publicar | Como o usuário instala |
|---|---|---|
| Arquivo `.tgz` (release interna, artefato de CI, compartilhamento) | Anexe o `.tgz` gerado. | `npm install -g ./fean-developer-mongodb-readonly-mcp-2.0.0.tgz` ou a URL HTTPS do arquivo. |
| Repositório Git | Publique uma tag, por exemplo `v2.0.0`. | `npm install -g git+https://github.com/fean-developer/mongodb-mcp.git#v2.0.0`; o npm instala as dependências de desenvolvimento e compila via `prepare`. |
| Registro npm público | Siga [Publicar no npm e no Registro MCP](#publicar-no-npm-e-no-registro-mcp). | Após a publicação, `npm install -g @fean-developer/mongodb-readonly-mcp`. |

### Publicar no npm e no Registro MCP

Os comandos de publicação abaixo só devem ser executados quando você decidir disponibilizar o pacote publicamente. O Registro MCP guarda metadados; o pacote precisa ser publicado no npm **primeiro**.

1. Confirme que as alterações e os tutoriais estão no repositório público. Para mudar de versão, atualize `package.json` e `package-lock.json` (por exemplo, com `npm version <versão> --no-git-tag-version`), os dois campos `version` de `server.json` e `serverVersion` em `src/interfaces/mcp/branding.ts`. O teste de publicação verifica a consistência.
2. Autentique-se no npm como `fean-developer`, com 2FA configurada, e instale o [`mcp-publisher`](https://modelcontextprotocol.io/registry/quickstart#step-3-install-mcp-publisher).
3. Na raiz do projeto, valide antes de publicar:

   ```sh
   npm ci
   npm run typecheck
   npm run lint
   npm test
   npm run test:integration  # requer Docker
   npm pack --dry-run
   mcp-publisher validate server.json
   npm whoami
   ```

4. Quando a publicação estiver autorizada, publique o pacote e confirme a versão e o `mcpName`:

   ```sh
   npm publish --access public
   npm view @fean-developer/mongodb-readonly-mcp@2.0.0 version mcpName
   ```

   Substitua `2.0.0` pela versão preparada, se necessário. O npm não permite reutilizar a mesma combinação de nome e versão.

5. Autentique-se no Registro MCP com a conta GitHub `fean-developer` e publique o manifesto:

   ```sh
   mcp-publisher login github
   mcp-publisher publish
   ```

   Confira o resultado na [API do Registro MCP](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.fean-developer%2Fmongodb-readonly-mcp). O `name` em `server.json` deve ser idêntico ao `mcpName` do pacote publicado.

O manifesto declara `MONGODB_URI` como segredo opcional, pois a conexão também pode vir da configuração privada. Prefira o configurador; não grave URI ou senha em configurações versionadas nem as compartilhe no chat. Com `MONGODB_MCP_PROFILE`, o servidor usa somente o perfil escolhido, ignorando outras variáveis de conexão herdadas.

Após a publicação, quem usar o servidor pelo Registro MCP pode executar o configurador sem instalação global:

```sh
npx --yes --package=@fean-developer/mongodb-readonly-mcp mongodb-readonly-mcp-configure
```

### 2. Instalar (usuário)

Instale no **mesmo ambiente em que o cliente MCP executa o servidor**: no WSL, instale dentro do WSL; em SSH ou container, no host remoto.

Se já houver uma instalação antiga do pacote sem escopo, remova-a primeiro com `npm uninstall -g mongodb-readonly-mcp` para evitar conflito entre os comandos. A configuração privada e os segredos são preservados.

Após a publicação no npm, instale com `npm install -g @fean-developer/mongodb-readonly-mcp`. Antes dela, use `npm install -g ./fean-developer-mongodb-readonly-mcp-2.0.0.tgz`. Confira os comandos com `command -v mongodb-readonly-mcp mongodb-readonly-mcp-configure`.

Se `npm install -g` exigir `sudo`, configure um prefixo npm do usuário (`npm config set prefix ~/.local`, com `~/.local/bin` no `PATH`) ou use nvm, em vez de instalar como root. Com nvm, os comandos globais pertencem à versão ativa do Node.

### 3. Configurar a conexão (uma vez)

```sh
mongodb-readonly-mcp-configure
mongodb-readonly-mcp-configure --check
```

O primeiro comando mostra a configuração atual (se houver), pergunta se deve importar variáveis exportadas, solicita o que faltar com entrada oculta para URI e senha, testa a conexão e pede confirmação antes de salvar. O segundo verifica a configuração salva. Ela fica no [arquivo privado](#arquivo-privado-e-precedência) do usuário e vale para todos os clientes e workspaces; para conexões por projeto, use [perfis](#perfis-e-vínculo-por-workspace).

### 4. Registrar no cliente (uma vez)

**Copilot CLI** (configuração do usuário em `~/.copilot/mcp-config.json`):

```sh
copilot mcp add mongodb-readonly -- mongodb-readonly-mcp
copilot mcp list
```

**VS Code**: execute `MCP: Open User Configuration` na paleta de comandos e adicione:

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

Em seguida, inicie o servidor pelo painel MCP ou recarregue a janela (`Developer: Reload Window`). O servidor informa título, descrição e ícone no `initialize` (`serverInfo.icons`, PNG em `data:` URI), e repete o ícone em cada tool; o VS Code exibe esses ícones no seletor de ferramentas do chat (**Configure Tools…**) depois da primeira inicialização. A lista **Extensions › MCP Servers - Installed** só mostra ícones de servidores instalados pela galeria MCP, então registros do `mcp.json` aparecem com o ícone genérico. O Copilot CLI não exibe ícones. Mensagens não fatais (configuração carregada, avisos de perfil e de `MONGODB_ONLY_READ=false`) vão pelo log do protocolo MCP (`notifications/message`, capability `logging`) e aparecem no Output como `[info]` ou `[warning]`; o stderr, que o VS Code mostra como `[warning] [server stderr]`, fica reservado para erros. Não coloque `env` com URI ou senha nessas configurações; se precisar de outra configuração, use somente `MONGODB_MCP_PROFILE` ou `MONGODB_MCP_CONFIG`.

Se o cliente não encontrar o comando, o `PATH` do cliente difere do terminal, o que é comum com nvm e no VS Code remoto. Use caminhos absolutos, obtidos no terminal com `command -v node` e `npm root -g`:

```json
{
  "servers": {
    "mongodb-readonly": {
      "type": "stdio",
      "command": "/caminho/absoluto/bin/node",
      "args": ["/caminho/absoluto/lib/node_modules/@fean-developer/mongodb-readonly-mcp/dist/main.js"]
    }
  }
}
```

Dentro deste repositório, `.mcp.json` e `.vscode/mcp.json` também registram `mongodb-readonly`. Se o cliente mostrar o servidor duplicado, desabilite um dos registros.

### 5. Atualizar e desinstalar

```sh
npm install -g @fean-developer/mongodb-readonly-mcp@latest   # atualizar após a publicação
npm uninstall -g @fean-developer/mongodb-readonly-mcp        # desinstalar
copilot mcp remove mongodb-readonly
```

Após atualizar, reinicie o MCP no cliente para carregar a nova versão. A desinstalação mantém o arquivo privado de configuração e os segredos no cofre; antes de desinstalar, use `mongodb-readonly-mcp-configure --reset` (e `--reset --profile <nome>` para cada perfil) se não for mais usá-los.

**Mudanças da versão 2.0.0:** `--save` no arquivo padrão com variáveis `MONGODB_*` no ambiente exige `--from-env` ou `--ignore-env`; destinos explícitos (perfil ou `MONGODB_MCP_CONFIG`) ignoram o ambiente sem `--from-env`; o modo interativo não reaproveita valores salvos sem confirmação; e segredos passam a ir para o cofre do sistema quando disponível. Arquivos salvos por versões anteriores continuam válidos.

## Tools e consultas

| Tool | Argumentos | Resultado |
|---|---|---|
| `listDatabases` | Nenhum | `{ "databases": [...] }`, somente bancos autorizados pela política e pelas permissões MongoDB, quando habilitadas. |
| `listCollections` | `database` | `{ "collections": [...] }`, somente coleções autorizadas. |
| `find` | `database`, `collection`, `filter`, `projection?`, `sort?`, `limit?`, `skip?` | `{ "documents": [...], "truncated": boolean }`. |
| `findOne` | `database`, `collection`, `filter`, `projection?`, `sort?` | `{ "document": {...} \| null }`. |
| `countDocuments` | `database`, `collection`, `filter` | `{ "count": número }`, contagem exata. |
| `distinct` | `database`, `collection`, `field`, `filter` | `{ "values": [...], "truncated": boolean }`. |

As consultas exigem `filter`, inclusive `{}` para selecionar todos os documentos autorizados. São aceitos igualdade, `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$and` e `$or`; outros operadores, expressões executáveis e segmentos `__proto__`, `constructor` e `prototype` são rejeitados. Filtros têm limite de 16.384 bytes, profundidade 8 e 500 nós.

Exemplo de argumentos para `find`:

```json
{
  "database": "loja",
  "collection": "pedidos",
  "filter": {
    "status": { "$in": ["novo", "pago"] },
    "criadoEm": { "$gte": { "$date": "2024-01-02T03:04:05Z" } }
  },
  "projection": { "_id": 0, "status": 1, "valor": 1 },
  "sort": { "valor": -1 },
  "limit": 20,
  "skip": 0
}
```

Datas de entrada usam UTC ISO-8601 com `Z`, com até três casas de milissegundos. ObjectId usa `{ "$oid": "0123456789abcdef01234567" }`. A saída de documentos e valores BSON usa Extended JSON canônico; por exemplo, números BSON e datas podem ser representados por objetos `$numberInt` e `$date`. Projeções aceitam inclusão (`1`) ou exclusão (`0`), sem misturá-las, exceto a exclusão de `_id`; com restrição de campos, use inclusão. Ordenação aceita somente `1` ou `-1`.

O limite de `find` é 20 por padrão e 100 no máximo; `skip` vai de 0 a 10.000. `truncated: true` indica mais documentos ou corte por tamanho. `distinct` retorna no máximo 100 valores, mas o comando nativo calcula o conjunto distinto antes desse corte. Resultados de documentos/valores são limitados a aproximadamente 120.000 bytes; `findOne` retorna erro se não couber. Toda resposta MCP tem teto de 262.144 bytes, e o buffer de entrada stdio tem teto de 65.536 bytes. Erros de validação e de conexão não incluem URI, senha ou token.

## Validação

```sh
npm run build
npm run typecheck
npm run lint
npm test
npm run test:integration
```

Os testes de integração iniciam containers MongoDB descartáveis com e sem autenticação. No primeiro, usam uma identidade `root` para confirmar que `MONGODB_ONLY_READ=true` bloqueia escritas antes do banco e que, com `false`, escritas com filtro passam enquanto `updateMany`/`deleteMany` com filtro vazio são bloqueados; também criam uma identidade `read` e confirmam que o próprio banco rejeita escritas; no segundo, verificam as consultas MCP e as restrições de bancos, coleções e campos. Os testes baixam a imagem `mongo:8.0` se necessário. Os testes unitários usam stubs tipados, exercitam guardrails, configuração, protocolo e OIDC simulado.

Os testes também cobrem importação não interativa de variáveis exportadas, permissões e precedência do arquivo privado, perfis, vínculos com fingerprint, cofre simulado, lock de gravação, `--unset`/`--reset`, diagnóstico de conexão e recuperação do mesmo processo MCP após configurar pelo terminal. A abertura real do VS Code e o login com provedor OIDC real ainda precisam ser validados no ambiente de destino; os launchers são testados com cliente simulado.

