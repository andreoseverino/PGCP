/**
 * Pessoas do MODO DE TESTE — exclusivo do login mock de desenvolvimento.
 *
 * Só chega à tela quando `isMockLoginAllowed()` e verdadeiro, ou seja, quando o
 * Entra ID NAO esta configurado nesta instalacao. Com Entra ligado, `App.tsx`
 * passa uma lista vazia e nada aqui e alcancavel.
 *
 * ISOLADO DE PROPOSITO. Estes nomes nao alimentam participante, responsavel,
 * signatario, usuario administrativo, FUP nem auditoria: no fluxo conectado,
 * pessoa vem de `users`, do Microsoft Graph ou de snapshot real gravado no
 * PostgreSQL. Este arquivo e a unica fronteira em que nome ficticio existe fora
 * de fixture de teste — e ele nao cruza para dado de negocio.
 *
 * Antes vivia em `initialData.ts`, junto de reunioes, pautas, FUPs, trilha de
 * auditoria, categorias e configuracoes de demonstracao. Todo o resto foi
 * removido na etapa 4.12; sobrou isto, aqui, com nome que diz o que e.
 */
export const mockTestPeople: { id: string; name: string; email: string; jobTitle?: string }[] = [
  { id: "test-1", name: "Sarah Jenkins", email: "sarah.jenkins@cielo.com.br" },
  { id: "test-2", name: "M. Davis", email: "m.davis@cielo.com.br" },
  { id: "test-3", name: "L. Chen", email: "l.chen@cielo.com.br" },
  { id: "test-4", name: "R. Smith", email: "r.smith@cielo.com.br" },
  { id: "test-5", name: "Marcus Smith", email: "marcus.smith@cielo.com.br" },
  { id: "test-6", name: "A. Executive", email: "a.executive@cielo.com.br" },
  { id: "test-7", name: "Marina Rios", email: "marina.rios@cielo.com.br" },
  { id: "test-8", name: "Carlos Silva", email: "carlos.silva@cielo.com.br" }
];

