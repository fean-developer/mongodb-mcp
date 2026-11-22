# Spec — Fase 1: substituição por padrão e visibilidade da configuração

> **Status: CONCLUÍDO** em 2026-11-22 (versão 2.0.0). Resultado dos testes em [VALIDACAO.md](./VALIDACAO.md); estado e arquivos alterados em [STATE.md](./STATE.md).
> Cobre: G1, G2, G8, G5 (mensagem), ponto 3 (parcial) e ponto 4.
> Dependências: nenhuma.

## 1. Objetivo

Eliminar o conflito reproduzido no [diagnóstico](./00-diagnostico.md#31-reprodução). Uma nova configuração não pode herdar valores de outra sem que o usuário peça. O usuário também precisa ver qual configuração está salva e qual está ativa.

## 2. Comportamento atual × desejado

| Situação | Hoje | Depois da fase 1 |
|---|---|---|
| `--save` com arquivo existente | Mescla ambiente + arquivo antigo + prompt | **Substitui:** grava só ambiente + prompt |
| Atualizar uma única opção | `--save` com a variável exportada | `--update` (mescla explícita) |
| Interativo com arquivo existente | Não pergunta nada e regrava | Mostra resumo e pergunta se quer usar o arquivo como base |
| Conflito vindo do arquivo | Mensagem culpa o ambiente | Mensagem informa a origem de cada variável |
| `--check` | Mostra modo, somente leitura e quantidade de bancos | Mostra também arquivo, hosts, origem das variáveis e restrições |
| Restrições opcionais | Nunca perguntadas | Etapa opcional no modo interativo |

## 3. Requisitos

### REQ-1.1 — Substituir por padrão

- Sem `--update`, o configurador **não lê** o arquivo salvo para compor os valores. A base é `process.env` (as variáveis `MONGODB_*` permitidas) mais as respostas do prompt.
- O arquivo final contém exatamente esses valores. Variáveis que existiam só no arquivo antigo desaparecem.
- O arquivo antigo pode ser lido apenas para mostrar o resumo do REQ-1.3, nunca para compor valores.

### REQ-1.2 — Opção `--update`

- Mantém o comportamento atual: ambiente > arquivo salvo > prompt.
- Combinações válidas: `--update`, `--update --save`, ambos com `--vscode` ou `--copilot`. `--check` continua exclusivo.
- Mensagem de uso atualizada: `Opções: [--save] [--update] [--vscode | --copilot], ou somente --check.`

### REQ-1.3 — Perguntar de novo no modo interativo

Quando não há `--save` nem `--update` e o arquivo existe e é válido:

1. Mostrar o resumo seguro da configuração salva (REQ-1.4).
2. Perguntar: `Usar a configuração salva como base? [s/N]`.
   - `s`: segue como `--update`.
   - Qualquer outra resposta: segue como substituição (REQ-1.1). Todas as obrigatórias que não vierem do ambiente são perguntadas, **inclusive a URI**.
3. Depois da coleta e da etapa opcional (REQ-1.5), mostrar o resumo da **nova** configuração, com a origem de cada variável, e só então pedir o consentimento de gravação já existente (`Salvar configuração com possíveis segredos em texto no arquivo privado …? [s/N]`). O consentimento sai do início do fluxo e vai para o fim. Ver decisão D1.2.

Se o arquivo existir, mas for inválido, mostrar só "arquivo existente inválido: será substituído" e seguir como substituição. O tratamento completo fica para o REQ-3.3.

### REQ-1.4 — Resumo seguro

Nova função pura, por exemplo `describeConfiguration(configuration, sources, path)`, que devolve linhas de texto com:

- caminho do arquivo;
- modo de autenticação;
- hosts da URI, extraídos de `ConnectionString.hosts`, **sem** userinfo nem opções da query string. Em `mongodb+srv://`, o host SRV;
- usuário: `definido` ou `não definido`, sem o valor (D1.3);
- bancos permitidos (nomes) ou `todos`;
- coleções e campos restritos: `sim` ou `não`;
- somente leitura e timeout;
- origem das variáveis, agrupada: `ambiente: …`, `arquivo: …`, `prompt: …` (só nomes).

Ela nunca inclui URI, senha, userinfo, client ID nem o JSON bruto. Um teste dedicado garante isso.

### REQ-1.5 — Etapa opcional de restrições (ponto 4)

- Só no modo interativo, depois das variáveis obrigatórias: `Configurar restrições opcionais (bancos, coleções, somente leitura, timeout)? [s/N]`.
- Se a resposta for sim, perguntar uma por vez, mostrando o valor atual quando houver (nenhuma delas é secreta):
  - `MONGODB_ALLOWED_DATABASES`
  - `MONGODB_ALLOWED_COLLECTIONS`
  - `MONGODB_ONLY_READ`
  - `MONGODB_QUERY_TIMEOUT_MS`
  - `MONGODB_AUTH_SOURCE` (só no modo scram)
- Enter mantém o valor atual. `-` remove o valor.
- Cada resposta é validada com `loadConfiguration`. Em caso de erro, mostrar a mensagem e perguntar de novo, até 3 tentativas.
- As descrições hoje sem uso em `descriptions` (`setup.ts`) passam a ser usadas; as novas variáveis ganham descrição.

### REQ-1.6 — Mensagem com a origem do conflito (G5 parcial)

- O configurador e o servidor passam a saber a origem de cada variável: `ambiente`, `arquivo` ou `prompt`.
- `explainConfigurationError` recebe esse mapa e informa, por exemplo:
  `… Valores vindos do arquivo <caminho>: MONGODB_USERNAME, MONGODB_PASSWORD. Valores do ambiente: MONGODB_URI, MONGODB_AUTH_MODE.`
- No configurador em modo `--update`, acrescentar: `Execute sem --update para substituir a configuração salva.`
- A dica atual ("Remova-as do ambiente…") só aparece quando o ambiente realmente contribuiu com alguma variável.

### REQ-1.7 — Configuração ativa visível (G8)

- `--check` imprime o resumo do REQ-1.4 antes do resultado da verificação.
- O servidor, depois de carregar a configuração com sucesso, escreve uma linha no **stderr**, por exemplo: `Configuração carregada de <caminho>: modo scram, hosts hostB:27017, bancos bancoB.`
- A mensagem devolvida às tools (visível ao modelo) **não** ganha o caminho nem os hosts (D1.4).

## 4. Design técnico

| Arquivo | Mudança |
|---|---|
| `src/infrastructure/configuration-store.ts` | Nova `resolveEnvironmentWithSources(env, { merge })` que devolve `{ values, sources }`. `resolveEnvironment` continua existindo para o servidor e passa a usar a nova função. Nova `describeConfiguration`. `explainConfigurationError` aceita `sources` opcional. |
| `src/interfaces/cli/setup.ts` | `collectEnvironment` marca a origem `prompt` nas respostas. Nova `collectOptionalRestrictions(env, prompt)`. Descrições novas. |
| `src/interfaces/cli/configure.ts` | Parser com `--update`. Fluxo interativo do REQ-1.3. Resumo antes do consentimento. `--check` com resumo. |
| `src/main.ts` | Linha de stderr do REQ-1.7. Passa `sources` para `explainConfigurationError`. |
| `README.md` | Seções "Configuração simples e reutilizável" e "Arquivo privado e precedência": substituição por padrão, `--update`, etapa opcional, novo `--check`. Corrigir a frase "não são solicitadas". |

Sem dependências novas.

## 5. Critérios de aceite

1. Na sequência A → B do diagnóstico, com `--save`:
   - o passo 2 (`URI=hostB`, `AUTH_MODE=none`) **salva** com sucesso;
   - o passo 3 (credenciais na URI) **salva** com sucesso;
   - no passo 4, o arquivo final **não** contém `pwA` nem `bancoA`;
   - o passo 5 (sem variáveis, sem TTY) falha com "Há valores ausentes…" em vez de regravar A.
2. `--update --save` reproduz exatamente o comportamento atual (mescla).
3. No modo interativo com arquivo existente, responder `N` faz o prompt pedir a URI mesmo com uma URI já salva.
4. Nenhuma saída do configurador ou do servidor contém senha, userinfo ou URI completa, inclusive com URI `mongodb://u:p@host/?authSource=admin`.
5. Um erro causado por variável vinda do arquivo cita o arquivo como origem.
6. `--check` mostra caminho, modo e hosts.

## 6. Testes

- `test/configuration-store.test.ts`: `resolveEnvironmentWithSources` com e sem mescla; `describeConfiguration` sem segredos (URI com userinfo, SRV, OIDC); `explainConfigurationError` com origens mistas.
- `test/launcher.test.ts` (ou novo `test/configure.test.ts`): rodar `dist/interfaces/cli/configure.js` com `env -i` e `MONGODB_MCP_CONFIG` temporário para os critérios 1 e 2.
- Teste de `collectEnvironment` e da etapa opcional com um `Prompt` falso: resposta `N` pede a URI de novo; `-` remove; valor inválido é perguntado de novo.
- `test/stdio.test.ts`: a linha de stderr de carga não contém segredos.

## 7. Compatibilidade

- **Mudança de comportamento:** `--save` deixa de mesclar. Scripts que exportam só uma variável para alterar o arquivo precisam usar `--update`. Isso deve constar no README e nas notas de versão (D1.1).
- Formato do arquivo inalterado. Arquivos existentes continuam válidos.
- O servidor não muda o modo de leitura; só ganha a linha de stderr e a mensagem com origem.

## 8. Fora de escopo nesta fase

- Isolamento do ambiente, perfis e fingerprint (fase 2).
- `--unset`, `--reset`, tratamento completo de arquivo inválido (fase 3).

## 9. Decisões (resolvidas)

> Todas as recomendações abaixo foram aplicadas na implementação.

| ID | Decisão | Recomendação |
|---|---|---|
| D1.1 | Versão do pacote para a mudança de comportamento do `--save` | `2.0.0` (semver: quebra de comportamento) ou `1.1.0` com aviso destacado no README |
| D1.2 | Mover o consentimento de gravação para depois da coleta (o usuário digita segredos antes de consentir; se recusar, nada é salvo) | Mover, porque o usuário vê exatamente o que será gravado |
| D1.3 | Mostrar o nome do usuário SCRAM no resumo | Não mostrar; exibir só `definido` |
| D1.4 | Incluir caminho e hosts na mensagem devolvida às tools | Não incluir; manter só no stderr |
