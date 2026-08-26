# packages/contracts

Pasta reservada para contratos e tipos compartilhados entre `apps/web` e `apps/api`.

**Ainda não implementado.** Hoje o contrato existe, mas **duplicado nas duas
pontas**: a API define os tipos de request/response dentro de cada módulo de
`apps/api/src`, e o frontend redeclara o formato da resposta nos adaptadores de
`apps/web/src/lib/*-adapters.ts`, que traduzem o payload da API para o modelo de
tela em [apps/web/src/types.ts](../../apps/web/src/types.ts).

Essa duplicação é a razão de a pasta existir: hoje uma mudança de contrato
precisa ser aplicada manualmente nos dois lados, e nada além do code review
impede que elas divirjam.

Extrair os contratos para cá é uma melhoria de manutenção, não uma correção — os
dois lados estão alinhados no momento. Quando for feita, esta pasta deverá ter
seu próprio `package.json` e ser adicionada à lista `workspaces` do
`package.json` da raiz.
