import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  addParticipantOnce,
  enderecoDoDiretorio,
  papelPadraoDoParticipante,
  participanteDoResponsavel,
  pautasSobResponsabilidade
} from "./participants";

/**
 * REFLEXO na tela da invariável "responsável de pauta que é pessoa participa da
 * reunião". A garantia de verdade é do backend
 * (`api/src/meetings/agenda-item-participants.ts`); o que se prova aqui é que a
 * tela de agendamento — onde a reunião ainda não existe e não há resposta do
 * servidor para absorver — aplica exatamente a MESMA regra, com os mesmos
 * limites.
 *
 * Sem React: as regras vivem em funções puras justamente para poderem ser
 * afirmadas sem montar componente.
 */

const OID_THIAGO = "22222222-2222-4222-8222-222222222222";
const OID_MURILO = "33333333-3333-4333-8333-333333333333";

// --- endereço corporativo ---------------------------------------------------

test("diretório prioriza mail válido e usa UPN como fallback", () => {
  assert.equal(
    enderecoDoDiretorio({ mail: "caixa@empresa.com", userPrincipalName: "login@empresa.com" }),
    "caixa@empresa.com"
  );
  assert.equal(
    enderecoDoDiretorio({ mail: null, userPrincipalName: "login@empresa.com" }),
    "login@empresa.com"
  );
  assert.equal(
    enderecoDoDiretorio({ mail: "inválido", userPrincipalName: "login@empresa.com" }),
    "login@empresa.com"
  );
  assert.equal(enderecoDoDiretorio({ mail: "inválido", userPrincipalName: null }), undefined);
});

// --- quem vira participante --------------------------------------------------

test("responsável do diretório vira participante, com papel padrão e sem presença", () => {
  assert.deepEqual(
    participanteDoResponsavel({ author: "  Thiago Rufino  ", authorEntraObjectId: OID_THIAGO }, "pt"),
    { name: "Thiago Rufino", role: "Convidado", confirmed: false, entraObjectId: OID_THIAGO }
  );

  assert.equal(
    participanteDoResponsavel({ author: "Thiago Rufino", authorEntraObjectId: OID_THIAGO }, "en")?.role,
    "Participant"
  );
  assert.equal(papelPadraoDoParticipante("pt"), "Convidado");
});

test('"Todos", área, comitê e texto livre NÃO viram participante', () => {
  for (const rotulo of ["Todos", "Comitê de Auditoria", "Diretoria Financeira", "a definir"]) {
    assert.equal(
      participanteDoResponsavel({ author: rotulo }, "pt"),
      null,
      `não deveria criar participante para: ${rotulo}`
    );
  }
});

test("identidade sem nome, e nome em branco, não viram participante", () => {
  assert.equal(participanteDoResponsavel({ authorEntraObjectId: OID_THIAGO }, "pt"), null);
  assert.equal(participanteDoResponsavel({ author: "   ", authorEntraObjectId: OID_THIAGO }, "pt"), null);
  assert.equal(participanteDoResponsavel({}, "pt"), null);
});

test("incluir o mesmo responsável duas vezes não duplica", () => {
  const pautas = [
    { author: "Thiago Rufino", authorEntraObjectId: OID_THIAGO },
    { author: "Thiago Rufino", authorEntraObjectId: OID_THIAGO },
    { author: "Todos" }
  ];

  let lista: ReturnType<typeof participanteDoResponsavel>[] = [];
  for (const pauta of pautas) {
    const responsavel = participanteDoResponsavel(pauta, "pt");
    if (responsavel) lista = addParticipantOnce(lista as never[], responsavel as never);
  }

  assert.equal(lista.length, 1);
});

test("quem já é participante mantém papel e presença que a tela definiu", () => {
  const existente = {
    name: "Thiago Rufino",
    role: "Presidente",
    confirmed: true,
    entraObjectId: OID_THIAGO
  };
  const responsavel = participanteDoResponsavel(
    { author: "Thiago Rufino", authorEntraObjectId: OID_THIAGO },
    "pt"
  );

  const lista = addParticipantOnce([existente], responsavel as typeof existente);

  assert.deepEqual(lista, [existente], "não sobrescreve quem já estava na lista");
});

// --- pautas sob responsabilidade (etiquetas + trava da remoção) --------------

test("casa por identidade do diretório, não por semelhança de nome", () => {
  const pautas = [
    { title: "Orçamento", author: "Thiago Rufino", authorEntraObjectId: OID_THIAGO },
    { title: "Riscos", author: "Murilo Cowboy", authorEntraObjectId: OID_MURILO },
    { title: "Encerramento", author: "Todos" }
  ];

  const doThiago = pautasSobResponsabilidade(pautas, {
    name: "Thiago Rufino",
    entraObjectId: OID_THIAGO
  });

  assert.deepEqual(
    doThiago.map((p) => p.title),
    ["Orçamento"]
  );
});

test("homônimos com identidades diferentes são pessoas diferentes", () => {
  const pautas = [{ title: "Orçamento", author: "Ana Souza", authorEntraObjectId: OID_THIAGO }];

  assert.deepEqual(
    pautasSobResponsabilidade(pautas, { name: "Ana Souza", entraObjectId: OID_MURILO }),
    []
  );
});

test("nome só decide quando falta identidade nos dois lados (legado)", () => {
  const pautas = [{ title: "Ata anterior", author: "Ana Souza" }];

  assert.equal(pautasSobResponsabilidade(pautas, { name: "ana souza" }).length, 1);
  // Com identidade de um lado só, o nome ainda é o único dado comum: é o
  // comportamento legado de `isSameParticipant`, preservado de propósito.
  assert.equal(
    pautasSobResponsabilidade(pautas, { name: "Ana Souza", entraObjectId: OID_MURILO }).length,
    1
  );
});

test("substring de nome não vincula pauta a quem não responde por ela", () => {
  const pautas = [{ title: "Orçamento", author: "Ana Paula Souza", authorEntraObjectId: OID_THIAGO }];

  assert.deepEqual(pautasSobResponsabilidade(pautas, { name: "Ana", entraObjectId: OID_MURILO }), []);
});

test("pauta sem responsável não prende ninguém", () => {
  const pautas = [{ title: "Abertura", author: "" }, { title: "Livre" }];

  assert.deepEqual(pautasSobResponsabilidade(pautas, { name: "Thiago Rufino", entraObjectId: OID_THIAGO }), []);
});

// --- fiação: nenhuma tela volta a casar por nome ------------------------------

/** Remove comentários: a varredura enxerga código, não prosa. */
function semComentarios(fonte: string): string {
  const blocos = /\/\*[\s\S]*?\*\//g;
  const linhas = /^[ \t]*\/\/.*$/gm;
  return fonte.replace(blocos, "").replace(linhas, "");
}

test("nenhuma tela associa pauta e participante por substring de nome", () => {
  const telas = ["../components/ScheduleMeetingModal.tsx", "../components/MeetingDetailView.tsx"];

  for (const tela of telas) {
    const fonte = semComentarios(readFileSync(new URL(tela, import.meta.url), "utf8"));

    assert.ok(
      fonte.includes("pautasSobResponsabilidade("),
      `${tela} deve usar a regra de identidade compartilhada`
    );

    const porNome = fonte
      .split("\n")
      .filter((linha) => linha.includes("author") && linha.includes("toLowerCase().includes("));

    assert.deepEqual(porNome, [], `${tela} voltou a casar responsável por substring de nome`);
  }
});
