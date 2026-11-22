# Spec — Fase 4: cofre de segredos e teste de conexão antes de salvar

> **Status: CONCLUÍDO** em 2026-11-22 (versão 2.0.0). Resultado dos testes em [VALIDACAO.md](./VALIDACAO.md); estado e arquivos alterados em [STATE.md](./STATE.md).
> Cobre: pontos 1 e 9.
> Dependências: fase 1. Usa perfis (fase 2) e `--reset`/`--unset` (fase 3), se já existirem.

## 1. Objetivo

- Tirar senha e URI com credenciais do JSON em texto puro sempre que o sistema operacional oferecer um cofre.
- Permitir testar a conexão antes de gravar, para não salvar configurações que não funcionam.

## 2. Parte A — Cofre de segredos (ponto 1)

### REQ-4.1 — Quais valores vão para o cofre

- `MONGODB_PASSWORD`, sempre que houver cofre disponível.
- `MONGODB_URI`, quando contiver senha no userinfo (`ConnectionString.password !== ''`).
- As demais variáveis continuam no JSON. Elas não são segredos e precisam aparecer no resumo seguro.

### REQ-4.2 — Backends, sem dependência nativa

Interface `SecretStore { available(), get(id), set(id, valor), delete(id) }`, com implementações que chamam ferramentas do sistema:

| Sistema | Backend | Observação |
|---|---|---|
| Linux | `secret-tool` (libsecret / Secret Service), atributos `service=mongodb-readonly-mcp` e `id=<uuid>` | O valor vai pelo **stdin** do `secret-tool store`, nunca pelo argv. Exige sessão D-Bus com o chaveiro desbloqueado. |
| macOS | `security` (Keychain) | `add-generic-password -w <valor>` expõe o valor no argv (visível no `ps`). Usar `security -i` com o comando enviado pelo stdin. |
| Windows | DPAPI de escopo do usuário via PowerShell (`ConvertTo-SecureString`/`ConvertFrom-SecureString`), valor pelo stdin | O texto cifrado fica no próprio JSON. Só o mesmo usuário na mesma máquina consegue decifrar. |
| Qualquer um, sem cofre | Arquivo em texto (comportamento atual) | Só com consentimento explícito, ou `--secret-store=file`. |

Nova opção `--secret-store=auto|keyring|file`. O padrão é `auto`: usa o cofre se `available()`; senão, pergunta se pode gravar em texto. Com `--save`, falha se não houver cofre e a opção não for `file`.

### REQ-4.3 — Formato do arquivo (versão 2)

```json
{
  "version": 2,
  "variables": { "MONGODB_AUTH_MODE": "scram", "MONGODB_USERNAME": "app", "MONGODB_URI": "mongodb://host:27017/" },
  "secrets": { "MONGODB_PASSWORD": { "store": "libsecret", "id": "0b8f…" } }
}
```

- `store`: `libsecret`, `keychain`, `dpapi`. No `dpapi`, há o campo `ciphertext` em vez de `id`.
- O leitor aceita a versão 1 (objeto plano atual) e a 2. O configurador sempre grava a 2 quando há cofre e a 1 quando o modo é `file`, para manter compatibilidade com versões antigas do servidor.
- Os ids são UUIDs novos a cada gravação. Os antigos são apagados do cofre depois do `rename`.

### REQ-4.4 — Leitura no servidor

- Os segredos são resolvidos na carga da configuração, antes do fingerprint (fase 2). O fingerprint continua calculado sobre os valores reais.
- Falha do cofre (indisponível, bloqueado, item ausente) gera `ConfigurationError` sem detalhes do valor: `Não foi possível ler o segredo MONGODB_PASSWORD do cofre <store>. Desbloqueie o chaveiro ou reconfigure com --secret-store=file.`
- Saídas das ferramentas externas nunca são repassadas em mensagens.

### REQ-4.5 — ACL no Windows

- Depois de gravar, aplicar `icacls <arquivo> /inheritance:r /grant:r <usuário>:F`.
- A leitura não verifica ACL (fora do escopo; documentar a limitação).

## 3. Parte B — Teste antes de salvar (ponto 9)

### REQ-4.6 — Verificação reutilizável

Extrair a lógica do `--check` atual para `verifyConnection(configuration): Promise<{ mode, readOnly, databases: number }>`, usada pelo `--check` e pela gravação.

### REQ-4.7 — Novas combinações

- `--check` sozinho: comportamento atual (verifica a configuração salva).
- `--save --check`: monta a configuração em memória, verifica e **só grava se passar**.
- Interativo: antes do consentimento de gravação, perguntar `Testar a conexão antes de salvar? [S/n]`.
- Se a verificação falhar: não gravar e mostrar a mensagem atual de falha. `--force` grava mesmo assim, com o aviso `Configuração salva sem conexão verificada.`

### REQ-4.8 — OIDC

- O teste abre o navegador. No modo interativo, avisar antes: `O teste fará login OIDC no navegador.`
- Com `--save --check` sem TTY, no modo OIDC, falhar com a orientação de testar em um terminal interativo.
- Tokens obtidos no teste não são persistidos (mesma regra do servidor).

## 4. Design técnico

| Arquivo | Mudança |
|---|---|
| novo `src/infrastructure/secret-store.ts` | Interface, três backends, detecção de disponibilidade, `spawn` com valores só pelo stdin e timeout |
| `src/infrastructure/configuration-store.ts` | Leitura e escrita da versão 2; resolução de segredos; remoção dos ids antigos |
| novo `src/application/verify-connection.ts` (ou em `configure.ts`) | `verifyConnection` |
| `src/interfaces/cli/configure.ts` | `--secret-store`, `--force`, `--save --check`, pergunta de teste |
| `README.md` | Cofre por sistema, limitação em WSL/SSH/containers sem chaveiro, novo formato, `--save --check` |

## 5. Critérios de aceite

1. Com cofre disponível, o JSON gravado não contém a senha nem uma URI com senha.
2. O servidor carrega a configuração versão 2 e conecta.
3. Arquivos versão 1 continuam funcionando sem migração.
4. Com cofre indisponível e `--save`, sem `--secret-store=file`, a gravação falha com mensagem clara.
5. Nenhum valor secreto aparece no argv de processos filhos (verificado nos testes pelo mock de `spawn`).
6. `--save --check` com credencial errada não grava nada; com `--force`, grava e avisa.
7. `--reset` e `--unset MONGODB_PASSWORD` removem o item do cofre.

## 6. Testes

- Backends testados com executáveis falsos no `PATH` (scripts que gravam o stdin num arquivo temporário), verificando argv e stdin.
- Leitura das versões 1 e 2, ids órfãos, falha do cofre.
- `--save --check` com o MongoDB de `test/integration` (quando disponível) e com adaptador falso nos testes unitários.

## 7. Compatibilidade e riscos

- **Risco alto:** o servidor MCP iniciado pelo VS Code em WSL, SSH ou container frequentemente não tem sessão D-Bus nem chaveiro desbloqueado. Nesse caso `auto` volta para texto puro com consentimento, e o servidor precisa de mensagem clara se o chaveiro sumir depois.
- Servidores de versões antigas não leem a versão 2. Atualizar o servidor antes de reconfigurar.
- Dependência de ferramentas externas (`secret-tool`, `security`, `powershell`), detectadas em tempo de execução.

## 8. Decisões (resolvidas)

> Todas as recomendações abaixo foram aplicadas na implementação. Na D4.1, a aprovação cobriu as duas partes; A e B foram implementadas juntas, e a parte A foi validada no WSL (libsecret real e DPAPI via `powershell.exe`).

| ID | Decisão | Recomendação |
|---|---|---|
| D4.1 | Fazer a parte A (cofre) agora ou adiar e manter só texto puro com `0600` | Fazer a parte B primeiro (baixo risco). Fazer a parte A depois de validar o ambiente real de execução (WSL/VS Code) |
| D4.2 | Formato versão 2 aninhado ou manter objeto plano com referências como valor (por exemplo `"keyring:<id>"`) | Versão 2 aninhada; um valor plano poderia colidir com uma senha real que comece com `keyring:` |
| D4.3 | Comportamento padrão de `auto` sem cofre | Perguntar no interativo; falhar no `--save` sem `--secret-store=file` |
| D4.4 | Padrão da pergunta "Testar a conexão antes de salvar?" | `S` (sim) |
