import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  acaoNaTrocaDeOrgao,
  chaveDoConvidado,
  convidadosDoGrupo,
  jaNaLista,
  listaIntocada,
  somarSemDuplicar
} from "./group-participants";
import { buildNewMeetingPayload, type NewMeetingForm } from "./new-meeting";
import type { MembroDoGrupo } from "./participation-groups-rules";

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

const grupo: MembroDoGrupo[] = [
  { id: "g1", nome: "Ana", email: "ana@cielo.example", origem: "cielo", entraObjectId: "oid-ana" },
  { id: "g2", nome: "Bruno", email: "bruno@cielo.example", origem: "cielo", entraObjectId: "oid-bruno" },
  { id: "g3", nome: "Carla Externa", email: "carla@parceiro.example", origem: "externo", entraObjectId: null }
];

test("órgão escolhido: internos pelo oid, externo pelo e-mail, todos marcados 'do órgão'", () => {
  const lista = convidadosDoGrupo(grupo, "pt");
  assert.deepEqual(lista.map((p) => [p.name, p.entraObjectId, p.email, p.doOrgao]), [
    ["Ana", "oid-ana", "ana@cielo.example", true],
    ["Bruno", "oid-bruno", "bruno@cielo.example", true],
    ["Carla Externa", undefined, "carla@parceiro.example", true]
  ]);
});

test("duplicidade: mesma pessoa (oid) ou mesmo e-mail (externo repetido, sem caixa)", () => {
  const lista = convidadosDoGrupo(grupo, "pt");
  assert.ok(jaNaLista(lista, { name: "Outro nome", entraObjectId: "OID-ANA" }));
  assert.ok(jaNaLista(lista, { name: "Carla", email: "CARLA@parceiro.example" }));
  assert.ok(!jaNaLista(lista, { name: "Dani", entraObjectId: "oid-dani", email: "dani@cielo.example" }));
  assert.equal(chaveDoConvidado({ name: "X", email: " A@B.com " }), "mail:a@b.com");
  assert.equal(somarSemDuplicar(lista, [{ ...lista[0]! }, { name: "Dani", role: "", confirmed: false, entraObjectId: "oid-dani", doOrgao: true as const }]).length, 4);
});

test("troca de órgão na Nova reunião: 1º órgão soma; lista intocada substitui; ajustada à mão pergunta", () => {
  const doA = convidadosDoGrupo(grupo, "pt");
  assert.equal(acaoNaTrocaDeOrgao([{ name: "Organizador", entraObjectId: "oid-org" }], null), "somar");
  assert.equal(acaoNaTrocaDeOrgao(doA, doA), "substituir");
  assert.equal(acaoNaTrocaDeOrgao([...doA].reverse(), doA), "substituir", "ordem não importa");
  const semBruno = doA.filter((p) => p.name !== "Bruno");
  assert.equal(acaoNaTrocaDeOrgao(semBruno, doA), "confirmar", "removeu alguém");
  assert.equal(acaoNaTrocaDeOrgao([...doA, { name: "Dani", entraObjectId: "oid-dani" }], doA), "confirmar", "adicionou alguém");
  assert.ok(listaIntocada([], null));
});

test("criar usa EXATAMENTE a lista mostrada e avisa o servidor para não recolocar o grupo", () => {
  const lista = convidadosDoGrupo(grupo, "pt").filter((p) => p.name !== "Bruno");
  const form: NewMeetingForm = {
    sessionType: "ordinary",
    date: "2030-01-10",
    startTime: "09:00",
    endTime: "10:00",
    timezone: "America/Sao_Paulo",
    governanceBodyId: "g",
    modality: "online",
    physicalLocationId: "",
    participants: lista,
    participantsIncludeGroup: true
  };
  const payload = buildNewMeetingPayload(form);
  assert.equal(payload.participantsIncludeGroup, true);
  assert.deepEqual(payload.participants.map((p) => p.displayName), ["Ana", "Carla Externa"]);
  assert.equal(payload.participants[1]!.participantType, "external");
  assert.ok(!("doOrgao" in payload.participants[0]!), "marca de UX não vai ao servidor");
  assert.equal(buildNewMeetingPayload({ ...form, participantsIncludeGroup: false }).participantsIncludeGroup, undefined);
});

test("Nova reunião (tela): carrega o grupo ao escolher o órgão, pergunta antes de substituir e marca a flag", () => {
  const modal = codigo("../components/NewMeetingModal.tsx");
  assert.match(modal, /onChange=\{\(e\) => escolherOrgao\(e\.target\.value\)\}/);
  assert.match(modal, /listGovernanceBodyGroupMembers\(novoId\)/);
  assert.match(modal, /if \(pedido !== pedidoDoGrupo\.current\) return;/, "resposta antiga é ignorada");
  assert.match(modal, /"Ao trocar o órgão, a lista de participantes pode ser atualizada\. A lista atual será substituída pelos participantes do novo órgão\. Deseja continuar\?"/);
  assert.match(modal, /participantsIncludeGroup: grupo\?\.orgaoId === governanceBodyId && !trocaPendente/);
  // Recalcular só na troca EXPLÍCITA de órgão: nenhum efeito recarrega o grupo por outro campo.
  assert.equal((modal.match(/escolherOrgao\(/g) ?? []).length, 2, "só no select e no órgão inicial");
  assert.match(modal, /"Participantes vinculados ao órgão são adicionados automaticamente\. Você pode ajustar esta lista para esta reunião sem alterar o cadastro do órgão\."/);
});

test("Editar reunião (tela): abrir não recalcula; trocar órgão pergunta e só ACRESCENTA", () => {
  const modal = codigo("../components/EditMeetingModal.tsx");
  assert.equal((modal.match(/listGovernanceBodyGroupMembers\(/g) ?? []).length, 1, "só dentro da troca de órgão");
  const troca = modal.slice(modal.indexOf("const trocarOrgao"), modal.indexOf("const nomeDoOrgao") > 0 ? modal.indexOf("const nomeDoOrgao") : undefined);
  assert.match(troca, /novoId === meeting\.governanceBodyId\) return;/);
  assert.match(modal, /onChange=\{\(e\) => trocarOrgao\(e\.target\.value\)\}/);
  assert.match(modal, /participants: somarSemDuplicar\(f\.participants \?\? \[\], trocaPendente\)/);
  assert.match(modal, /"Você está alterando o órgão da reunião\. Deseja atualizar a lista de participantes com base no novo órgão\?/);
  assert.ok(!/useEffect\([^)]*listGovernanceBodyGroupMembers/.test(modal));
});

test("participantes: aviso de duplicado e selo 'Do órgão' no MESMO componente das duas telas", () => {
  const campos = codigo("../components/MeetingInviteFields.tsx");
  assert.match(campos, /if \(jaNaLista\(participants, novo\)\) \{\s*setDuplicado\(true\);/);
  assert.match(campos, /MSG_JA_PARTICIPA\[language\]/);
  assert.match(campos, /\{p\.doOrgao && \(/);
  assert.match(campos, /pt \? "Do órgão" : "From body"/);
});
