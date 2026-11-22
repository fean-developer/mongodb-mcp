# Diagnóstico: gravação de configuração e conflito entre instâncias

> Documento de referência. Descreve o comportamento **anterior** à versão 2.0.0. Todos os pontos e gaps foram tratados (status: **CONCLUÍDO** em 2026-11-22); veja [STATE.md](./STATE.md).
> Arquivos analisados: `src/interfaces/cli/configure.ts`, `src/interfaces/cli/setup.ts`, `src/infrastructure/configuration-store.ts`, `src/infrastructure/configuration.ts`, `src/main.ts`. O `dist/` corresponde ao `src/`.

## 1. Fluxo atual ao salvar

1. **Validação dos argumentos.** O comando aceita `--save`, `--vscode` e `--copilot`, ou só `--check`. Argumentos repetidos ou combinações inválidas são rejeitados.
2. **Consentimento.** Sem `--save`, o comando pergunta "Salvar configuração com possíveis segredos em texto…? [s/N]" e mostra o caminho. Só segue com `s`, `sim`, `y` ou `yes`. Com `--save`, não há confirmação.
3. **Fusão das fontes** (`resolveEnvironment`). O arquivo existente é lido e combinado com `process.env`. Prioridade: variáveis exportadas no shell, depois o arquivo salvo, depois as respostas do terminal.
4. **Coleta** (`collectEnvironment`). Pergunta só as variáveis obrigatórias que faltam, conforme o modo inferido:
   - sempre `MONGODB_URI`;
   - SCRAM: `MONGODB_USERNAME` e `MONGODB_PASSWORD`;
   - OIDC: `MONGODB_OIDC_ISSUER`, `MONGODB_OIDC_CLIENT_ID`, `MONGODB_OIDC_MONGO_HOSTS`, `MONGODB_OIDC_PROVIDER_HOSTS`.
5. **Validação completa** (`loadConfiguration`), sem testar a conexão.
6. **Gravação** (`saveEnvironment`):
   - filtra para 16 variáveis `MONGODB_*` permitidas e descarta valores vazios;
   - JSON indentado, limite de 1 MiB;
   - `mkdir -p` com modo `0700`;
   - temporário `.config.json.<uuid>.tmp` com `flag: 'wx'` e modo `0600`, seguido de `rename` atômico e `rm` do temporário.
7. **Caminho.** `MONGODB_MCP_CONFIG` (absoluto), senão `$XDG_CONFIG_HOME` (Windows: `%APPDATA%`) ou `~/.config`, mais `/mongodb-readonly-mcp/config.json`.
8. **Depois de salvar.** `--vscode`/`--copilot` abrem o cliente sem as `MONGODB_*` e com `MONGODB_MCP_ROOT=cwd`.

### Entrada oculta

- Só `MONGODB_URI` e `MONGODB_PASSWORD` são lidas sem eco (modo raw, sem asteriscos, limite de 8192, Ctrl+C cancela).
- Usuário SCRAM, issuer, client ID e hosts OIDC aparecem na tela.
- Sem TTY, o comando falha.

## 2. Pontos de atenção (análise original)

| # | Ponto | Descrição |
|---|---|---|
| 1 | Segredos em texto puro | Senha e URI com credenciais vão para o JSON sem criptografia. A proteção é só `0600`; no Windows, o `mode` é praticamente ignorado e a leitura não verifica permissões. |
| 2 | Variáveis exportadas gravadas sem aviso | Qualquer `MONGODB_*` do shell vai para o arquivo sem pergunta e substitui o valor antigo. |
| 3 | Não dá para remover variáveis | Valores antigos do arquivo sempre permanecem; exportar vazio faz voltar ao valor do arquivo. |
| 4 | Opções opcionais nunca são perguntadas | `ALLOWED_*`, `QUERY_TIMEOUT_MS`, `ONLY_READ`, `AUTH_MODE`, `AUTH_SOURCE` e opções OIDC só entram via ambiente. Os textos de `ALLOWED_DATABASES`/`ALLOWED_COLLECTIONS` em `descriptions` nunca são usados. |
| 5 | Arquivo inválido bloqueia a regravação | Permissão errada, outro dono, JSON inválido ou symlink fazem `resolveEnvironment` falhar antes de salvar. |
| 6 | Permissões do diretório não garantidas | `0700` só vale para diretórios criados agora; o diretório de destino não é verificado; `MONGODB_MCP_CONFIG` aceita qualquer caminho absoluto. |
| 7 | Sem `fsync` | Queda de energia pode deixar o arquivo vazio ou truncado. Risco baixo. |
| 8 | Erros genéricos | Qualquer falha de E/S vira "Não foi possível salvar…". |
| 9 | Conexão não testada antes de salvar | Credencial errada é gravada normalmente. |
| 10 | Backspace e limite | O limite conta unidades UTF-16; o backspace apaga um code point. Sem impacto prático. |

## 3. Conflito entre configurações de instâncias diferentes

### 3.1 Reprodução

Feita com `env -i`, `MONGODB_MCP_CONFIG` apontando para um diretório temporário e `node dist/interfaces/cli/configure.js --save`:

| Passo | Variáveis passadas | Resultado |
|---|---|---|
| 1 | Config A: `URI=hostA`, `USERNAME=userA`, `PASSWORD=pwA`, `ALLOWED_DATABASES=bancoA` | Salvo |
| 2 | Config B: `URI=hostB`, `AUTH_MODE=none` | **Erro** "Credenciais separadas só são aceitas no modo scram". Usuário e senha vieram do arquivo de A. |
| 3 | Config B com usuário e senha na URI | **Erro** "URI conflita com o modo scram". O `USERNAME` de A força o modo scram. |
| 4 | Config B: `URI=hostB`, `USERNAME=userB` | **Salvo como mistura:** host B, usuário B, **senha de A**, **`bancoA`** |
| 5 | Nenhuma variável | **Salvo sem perguntar nada.** A configuração anterior é regravada. |

Nos passos 2 e 3, a mensagem manda remover variáveis do ambiente, mas o conflito vem do arquivo salvo.

Arquivo final do passo 4:

```json
{
  "MONGODB_URI": "mongodb://hostB:27017",
  "MONGODB_USERNAME": "userB",
  "MONGODB_PASSWORD": "pwA",
  "MONGODB_ALLOWED_DATABASES": "bancoA"
}
```

### 3.2 Gaps

| ID | Gap | Onde |
|---|---|---|
| G1 | O configurador **mescla** em vez de substituir. Cada configuração nova herda senha, `AUTH_MODE`, `AUTH_SOURCE`, `ALLOWED_*`, `ONLY_READ` e OIDC da anterior. **Causa principal.** | `configure.ts` → `resolveEnvironment` antes de `collectEnvironment` |
| G2 | O modo interativo só pergunta o que falta. Com uma URI já salva, nada é perguntado e a configuração antiga é regravada. | `setup.ts` → `collectEnvironment` + `missingConfiguration` |
| G3 | Um único `config.json` por usuário serve todos os projetos, janelas e clientes. Vale o último salvo. | `configurationFilePath` |
| G4 | O servidor relê o arquivo global depois de uma falha (`operations = undefined`) e em todo reinício. Um projeto pode passar a usar o banco salvo por outro projeto sem aviso. | `main.ts` → `getOperations` |
| G5 | Sem `MONGODB_MCP_CONFIG`, cada `MONGODB_*` herdada substitui a do arquivo, uma por uma. Uma mistura que funciona passa sem aviso. | `resolveEnvironment`, `explainConfigurationError` |
| G6 | O servidor ignora o ambiente quando `MONGODB_MCP_CONFIG` está definido, mas o configurador não. Variáveis do banco 1 ainda exportadas vão para o arquivo do banco 2. | `serverEnvironment` só é usado em `main.ts` |
| G7 | `--vscode`/`--copilot` parecem configurar por projeto, mas a janela usa o arquivo global. Além disso, `MONGODB_MCP_ROOT` significa "raiz de instalação" (README), mas o launcher a define como `cwd`; na instalação global isso aponta para a pasta do usuário. | `setup.ts` → `clientEnvironment` |
| G8 | Nada mostra qual configuração está ativa (caminho, host, modo, bancos). | `configure.ts --check`, `main.ts` |
| G9 | Dois configuradores simultâneos leem, mesclam e gravam sem lock (o último `rename` vence). Instâncias OIDC compartilham por padrão o callback `127.0.0.1:8400`. | `saveEnvironment`, `configuration.ts`, `oidc.ts` |
| G10 | `~` não é expandido em `MONGODB_MCP_CONFIG`. Um caminho absoluto digitado errado cria um arquivo novo sem aviso. | `configurationFilePath` |

## 4. Ordem de implementação (aprovada e concluída)

1. **Fase 1:** substituir por padrão (G1, ponto 3), perguntar de novo (G2), mostrar a configuração ativa (G8), mensagem de origem (G5 parcial), etapa opcional de restrições (ponto 4).
2. **Fase 2:** perfis nomeados (G3, G7, G10), isolamento do ambiente (ponto 2, G5, G6), vínculo do servidor com fingerprint completo (G4).
3. **Fase 3:** pontos 5, 6, 7, 8 e 10, `--unset`/`--reset` (ponto 3), lock e porta OIDC (G9).
4. **Fase 4:** cofre do sistema para segredos (ponto 1) e teste de conexão antes de salvar (ponto 9).

As quatro fases foram implementadas nessa ordem e validadas juntas; veja [VALIDACAO.md](./VALIDACAO.md).
