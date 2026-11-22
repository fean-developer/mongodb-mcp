# MongoDB MCP somente leitura

Servidor MCP em TypeScript/Node.js que permite a clientes como o GitHub Copilot consultar bancos, coleções e documentos no MongoDB.

O servidor oferece apenas tools de leitura, sem ferramentas de escrita, comandos arbitrários ou agregação. Por padrão, também bloqueia comandos de escrita antes de chegarem ao MongoDB, mesmo que o usuário tenha permissão para escrever. As consultas respeitam as permissões do MongoDB e as restrições configuradas.

## Tools disponíveis

| Tool | O que faz |
|---|---|
| `listDatabases` | Lista os bancos autorizados. |
| `listCollections` | Lista as coleções autorizadas de um banco. |
| `find` | Busca documentos por filtro, com projeção, ordenação e paginação. |
| `findOne` | Busca um documento que corresponda ao filtro. |
| `countDocuments` | Conta os documentos que correspondem ao filtro. |
| `distinct` | Retorna os valores distintos de um campo nos documentos que correspondem ao filtro. |

## Instalação e configuração

Para instalar, configurar e começar a usar, siga o [tutorial para iniciantes](docs/TUTORIAL-INICIANTES.md).

Para detalhes de autenticação, restrições e outras opções, consulte o [tutorial avançado](docs/TUTORIAL-AVANCADO.md).
