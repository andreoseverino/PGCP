# infra

Artefatos de infraestrutura do PGCP.

| Caminho | Conteúdo |
|---|---|
| [docker-compose.yml](docker-compose.yml) | PostgreSQL 17 de **desenvolvimento local**, publicado só em loopback. Lê as credenciais de `apps/api/.env` |
| [postgres/](postgres/) | Provisionamento dos papéis de menor privilégio e endurecimento de cluster existente — ver [postgres/README.md](postgres/README.md) |

```bash
npm run db:up        # sobe o PostgreSQL local
npm run db:migrate   # aplica as migrations pendentes
npm run db:logs      # acompanha os logs do banco
npm run db:down      # para e remove o container (o volume é preservado)
```

O Docker é conveniência do ambiente **local**. A API depende apenas das
variáveis `DB_*` e funciona com qualquer PostgreSQL padrão; em outros ambientes
o banco é provisionado por fora.

> Os scripts de `postgres/init/` só rodam quando o volume de dados está **vazio**.
> Para endurecer um cluster que já existe, use
> [postgres/harden-existing-cluster.sql](postgres/harden-existing-cluster.sql).

**Ainda não versionado aqui:** manifestos de deploy, configuração de proxy/WAF,
CSP de borda e pipeline de CI/CD. O que precisa existir em produção está listado
em [../docs/producao-hardening.md](../docs/producao-hardening.md) e
[../docs/go-live.md](../docs/go-live.md).
