# Spec — Fase 3: endurecimento da gravação e da leitura

> **Status: CONCLUÍDO** em 2026-11-22 (versão 2.0.0). Resultado dos testes em [VALIDACAO.md](./VALIDACAO.md); estado e arquivos alterados em [STATE.md](./STATE.md).
> Cobre: pontos 3 (complemento), 5, 6, 7, 8 e 10, e G9.
> Dependências: fase 1 (substituição por padrão e `--update`). Se a fase 2 estiver pronta, todas as regras valem também para perfis e vínculos.

## 1. Objetivo

Tornar a gravação previsível e recuperável. O usuário deve conseguir remover valores, recuperar-se de um arquivo inválido sem editar à mão e entender por que uma gravação falhou. Gravações simultâneas não podem perder dados em silêncio.

## 2. Requisitos

### REQ-3.1 — `--unset NOME` (ponto 3)

- Repetível: `--unset MONGODB_AUTH_SOURCE --unset MONGODB_ALLOWED_FIELDS`.
- Aceita só nomes da lista de variáveis permitidas. Outros nomes são erro.
- Sempre opera sobre o arquivo salvo (semântica de `--update`), remove as variáveis indicadas e valida com `loadConfiguration` antes de gravar. Se o resultado for inválido, nada é gravado e a mensagem explica o motivo.
- Não pode ser combinado com `--check`, nem (na fase 2) com `--from-env`.

### REQ-3.2 — `--reset` (ponto 3)

- Apaga o arquivo da fonte alvo (padrão, `MONGODB_MCP_CONFIG` ou `--profile`).
- Interativo: `Apagar <caminho>? [s/N]`. Com `--save`, sem pergunta.
- Usa `lstat` antes: só remove arquivo regular do próprio usuário. Diante de symlink ou arquivo de outro dono, recusa e explica como remover à mão.
- Na fase 2, `--reset --profile x` também lista os vínculos que apontam para `x`. Eles não são apagados; passam a dar divergência.
- Na fase 4, também remove os segredos do cofre.

### REQ-3.3 — Arquivo existente inválido (ponto 5)

| Motivo | Substituição (padrão) | `--update` / `--unset` |
|---|---|---|
| JSON inválido, variável não suportada, valor não string | Aviso `arquivo existente inválido (<motivo>) será substituído`. Interativo pede confirmação; `--save` segue | Erro com o motivo e a sugestão: rode sem `--update` ou use `--reset` |
| Permissão diferente de `0600` | Igual à linha acima; o arquivo novo nasce com `0600` | Erro com o motivo e o comando `chmod 600 <caminho>` |
| Symlink no destino | **Recusa**: o servidor rejeita symlink (`O_NOFOLLOW`), então substituir o link sem aviso não resolveria nada. Explica como remover | Recusa |
| Arquivo de outro usuário | **Recusa** e explica | Recusa |
| Maior que 1 MiB ou não é arquivo regular | Recusa e explica | Recusa |

Nenhuma mensagem mostra o conteúdo do arquivo.

### REQ-3.4 — Permissões do diretório (ponto 6)

Fora do Windows, depois do `mkdir`, verificar o diretório de destino com `lstat`:

- deve ser diretório e não symlink;
- deve pertencer ao usuário atual (`uid === process.getuid()`);
- não pode permitir escrita por grupo ou outros (`(mode & 0o022) === 0`).

Se a verificação falhar:

- no diretório do aplicativo (`<raiz>/mongodb-readonly-mcp` e subdiretórios `profiles`/`bindings`) do próprio usuário, aplicar `chmod 0700` e seguir;
- em qualquer outro caso, erro sem gravar.

Quando `MONGODB_MCP_CONFIG` apontar para fora de `<raiz>/mongodb-readonly-mcp`, avisar: `O arquivo está fora do diretório privado padrão; confira as permissões de <diretório>.`

### REQ-3.5 — Durabilidade (ponto 7)

Sequência de gravação:

1. `open(temporário, 'wx', 0o600)`;
2. `write` do conteúdo completo;
3. `handle.sync()` (fsync);
4. `close`;
5. `rename(temporário, destino)`;
6. fora do Windows, abrir o diretório e chamar `sync()`. Ignorar `EINVAL`/`EISDIR`/`EPERM` nesse passo, porque alguns sistemas de arquivos não suportam fsync de diretório.

O temporário continua sendo removido no `finally`.

### REQ-3.6 — Erros específicos (ponto 8)

Mapear o `code` do erro de E/S, na leitura e na gravação, mostrando só o caminho:

| Código | Mensagem |
|---|---|
| `EACCES`, `EPERM` | `Sem permissão para gravar em <diretório>.` (ou "ler <caminho>") |
| `ENOSPC`, `EDQUOT` | `Sem espaço em disco ou cota excedida em <diretório>.` |
| `EROFS` | `<diretório> está em um sistema de arquivos somente leitura.` |
| `ENOTDIR` | `Um componente de <caminho> não é um diretório.` |
| `EISDIR` | `<caminho> é um diretório, não um arquivo.` |
| `ELOOP` | `<caminho> é um link simbólico; links não são aceitos.` |
| `EEXIST` no temporário | Tentar de novo uma vez com outro UUID; se repetir, mensagem genérica |
| outros | Mensagem genérica atual |

### REQ-3.7 — Lock de gravação (G9)

- Arquivo `<destino>.lock`, criado com `open(…, 'wx', 0o600)`, contendo `{ "pid": …, "hostname": …, "createdAt": … }`.
- O configurador mantém o lock durante a leitura e a gravação (`--update`, `--unset`) ou durante a gravação (substituição, `--reset`). Ele é liberado no `finally`.
- Se o lock estiver ocupado, tentar a cada 100 ms por até 5 s. Depois disso: `Outra execução do configurador está gravando <caminho>. Tente novamente.`
- Lock antigo: com mais de 30 s **e** do mesmo `hostname` **e** com o processo inexistente (`process.kill(pid, 0)` retorna `ESRCH`), é removido e a tentativa se repete. Em qualquer outro caso, não é removido automaticamente.
- O servidor não usa lock na leitura; o `rename` atômico já garante leitura consistente.

### REQ-3.8 — Porta do callback OIDC (G9)

- Em `listenForCallback` (`oidc.ts`), tratar `EADDRINUSE` com uma mensagem clara: `A porta <porta> do callback OIDC está em uso, talvez por outra instância autenticando. Tente novamente ou use um MONGODB_OIDC_REDIRECT_URI diferente por perfil (ele precisa estar registrado no provedor).`
- **Sem** troca automática de porta, porque o provedor só aceita redirect URIs registradas.
- Na etapa opcional da fase 1, no modo OIDC, perguntar também `MONGODB_OIDC_REDIRECT_URI`.
- Na fase 2, `--list-profiles` avisa quando dois perfis OIDC usam a mesma porta.

### REQ-3.9 — Backspace e limite (ponto 10)

- Em `askSecret`, contar o limite em code points: `[...value].length + [...character].length > 8192`, coerente com o backspace, que já apaga um code point.
- Sem mudança visível para o usuário.

## 3. Design técnico

| Arquivo | Mudança |
|---|---|
| `src/infrastructure/configuration-store.ts` | Gravação com `FileHandle` e fsync; `ensurePrivateDirectory`; `describeIoError(code, caminho)`; `removeConfiguration`; leitura com diagnóstico tipado (motivo do arquivo inválido) para o REQ-3.3 |
| novo `src/infrastructure/file-lock.ts` | `withFileLock(caminho, fn)` |
| `src/interfaces/cli/configure.ts` | `--unset`, `--reset`, matriz de combinações, avisos do REQ-3.3 |
| `src/infrastructure/oidc.ts` | `EADDRINUSE` no listener |
| `README.md` | `--unset`, `--reset`, recuperação de arquivo inválido, porta OIDC por perfil |

Sem dependências novas.

## 4. Critérios de aceite

1. `--unset MONGODB_ALLOWED_DATABASES` remove só essa chave. `--unset MONGODB_URI` falha sem gravar.
2. `--reset --save` apaga o arquivo. Com symlink no destino, recusa.
3. Com JSON inválido, a substituição funciona e `--update` falha com a sugestão.
4. Diretório do aplicativo com `0755` vira `0700`. Diretório fora do padrão com `0777` gera erro sem gravar.
5. Um `EACCES` simulado gera a mensagem específica com o caminho.
6. Duas execuções simultâneas de `--update` alterando variáveis diferentes terminam com as duas mudanças, ou uma delas falha com a mensagem de lock. Nenhuma se perde em silêncio.
7. Lock antigo de um PID inexistente é removido. Lock recente não é removido.
8. Porta OIDC ocupada gera a mensagem do REQ-3.8.

## 5. Testes

- Unitários em `test/configuration-store.test.ts` com diretórios temporários: cada linha da tabela do REQ-3.3, permissões do REQ-3.4, mapeamento do REQ-3.6 (injetando o erro).
- Novo `test/file-lock.test.ts`: concorrência com dois `withFileLock`, timeout, lock antigo.
- `test/oidc.test.ts`: ocupar a porta antes do login e verificar a mensagem.
- `askSecret`: teste com caracteres fora do BMP (emoji) no limite.
- O fsync não tem teste determinístico; só uma verificação de que `sync` é chamado (spy no `FileHandle`).

## 6. Compatibilidade

- Nenhuma mudança no formato do arquivo.
- Diretórios do aplicativo com permissões mais abertas passam a ser corrigidos para `0700`. Diretórios fora do padrão com escrita por grupo/outros passam a ser recusados (antes eram aceitos).

## 7. Decisões (resolvidas)

> Todas as recomendações abaixo foram aplicadas na implementação.

| ID | Decisão | Recomendação |
|---|---|---|
| D3.1 | Corrigir permissões do diretório do aplicativo automaticamente ou só avisar | Corrigir, porque o diretório é do próprio aplicativo e do próprio usuário |
| D3.2 | Recusar diretórios fora do padrão com escrita por grupo/outros (quebra possível) ou só avisar | Recusar; outro usuário poderia trocar o arquivo |
| D3.3 | `--reset` também apagar vínculos do perfil (fase 2) | Não apagar; deixar a divergência avisar |
| D3.4 | Tempo máximo de espera pelo lock | 5 s |
