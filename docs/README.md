# docs

Documentação do projeto: decisões de arquitetura, guias de processo e notas técnicas.

## Segurança e produção

**Ponto de entrada:** [`security.md`](security.md) é a **fonte principal de
verdade** sobre segurança, hardening e prontidão de produção — um agente novo
entende todo o contexto lendo só ela.

| Documento | Conteúdo |
| --- | --- |
| [security.md](security.md) | **Fonte de verdade** — auditoria, correções, hardening PostgreSQL, `audit_logs` append-only, hardening de produção, rate limiting, Entra/RBAC/Graph, CORS, headers/CSP, logs, secrets, proxy/WAF, estado de readiness e **contexto para agentes futuros** |
| [go-live.md](go-live.md) | Checklist operacional de go-live (12 passos, em ordem de execução) — itens externos pendentes |
| [producao-hardening.md](producao-hardening.md) | Detalhe técnico de configuração de produção: CSP/headers, proxy/WAF, Log Analytics, rate limiting |
| [runbook-entra-app-registration.md](runbook-entra-app-registration.md) | Passo a passo dos App Registrations do Entra |
| [runbook-exchange-calendar.md](runbook-exchange-calendar.md) · [handoff-exchange-rbac.md](handoff-exchange-rbac.md) | Exchange Online RBAC / calendário |

O procedimento de provisionamento dos papéis do PostgreSQL está em
[`../infra/postgres/README.md`](../infra/postgres/README.md).

## Domínio e integrações

| Documento | Conteúdo |
| --- | --- |
| [modelo-de-dados.md](modelo-de-dados.md) | Modelagem do domínio e decisões de schema |
| [integracoes.md](integracoes.md) | Integrações, variáveis de ambiente, permissões do App Registration e o que ainda não está implementado |

A documentação operacional (como rodar o projeto) está no
[README.md](../README.md) da raiz.
