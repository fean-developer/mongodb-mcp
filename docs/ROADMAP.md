# Roadmap

**V2**

- `aggregateReadOnly` com estágios permitidos, validação recursiva de subpipelines e bloqueio de `$out`, `$merge` e coleções não autorizadas.
- Provedores OIDC adicionais e identidades de aplicação.
- Inspeção de schema com amostragem limitada.
- `explain` para consultas autorizadas, inicialmente com `queryPlanner`.

**V3**

- Transporte MCP Streamable HTTP e implantação centralizada.
- Observabilidade sanitizada e rate limiting por identidade.
- Autenticação e autorização corporativa dos clientes MCP, separadas da identidade que o servidor usa para acessar o MongoDB.
