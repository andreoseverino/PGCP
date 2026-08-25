# packages/contracts

Pasta reservada para contratos e tipos compartilhados entre `apps/web` e `apps/api`.

**Ainda não implementado.** Hoje os tipos da aplicação vivem em
[apps/web/src/types.ts](../../apps/web/src/types.ts) e continuam lá até que exista
um backend consumindo os mesmos contratos.

Quando esta pasta for criada de fato, deverá conter seu próprio `package.json`
e ser adicionada à lista `workspaces` do `package.json` da raiz.
