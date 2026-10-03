import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combinarResultados,
  deveBuscarNoEntra,
  ENTRA_MIN_QUERY,
  filtrarLocais,
  selecionadoComoConvidado,
  selecionadoParaPayload
} from "./participant-search";
import type { ExternalParticipant } from "./external-participants-rules";
import { participantsPayload } from "./meeting-adapters";

const externo = (id: string, fullName: string, email: string): ExternalParticipant => ({
  id,
  origin: "pgcp",
  fullName,
  email,
  phone: "11 3333 4444",
  governanceBodies: [],
  topics: [],
  createdAt: "",
  updatedAt: ""
});
const doEntra = (id: string, displayName: string, mail: string) => ({
  id,
  displayName,
  mail,
  userPrincipalName: null,
  jobTitle: null,
  userType: "Member",
  accountEnabled: true
});

const locais = [externo("p1", "Maria Souza", "maria@externo.com"), externo("p2", "Carlos Mendes", "carlos@fornecedor.com")];
const entra = [doEntra("oid-1", "João da Silva", "joao@empresa.com"), doEntra("oid-2", "Ana Oliveira", "ana@empresa.com")];

test("resultados Entra e PGCP aparecem, separados por origem", () => {
  const r = combinarResultados(entra, locais, "a");
  assert.deepEqual(r.entra.map((u) => u.id), ["oid-1", "oid-2"]);
  assert.deepEqual(r.pgcp.map((p) => p.id), ["p1", "p2"]);
});

test("busca local funciona desde a primeira letra; Entra só a partir do mínimo", () => {
  assert.deepEqual(filtrarLocais(locais, "m").map((p) => p.id), ["p1", "p2"]);
  assert.deepEqual(filtrarLocais(locais, "FORNEC").map((p) => p.id), ["p2"]);
  assert.deepEqual(filtrarLocais(locais, "  "), []);
  assert.equal(ENTRA_MIN_QUERY, 3);
  assert.equal(deveBuscarNoEntra("ma"), false);
  assert.equal(deveBuscarNoEntra("mar"), true);
});

test("mesmo e-mail não aparece nas duas origens (Entra prevalece, sem diferenciar maiúsculas)", () => {
  const conflito = [...locais, externo("p3", "João (duplicado)", "JOAO@empresa.com")];
  const r = combinarResultados(entra, conflito, "jo");
  assert.deepEqual(r.entra.map((u) => u.id), ["oid-1", "oid-2"]);
  assert.ok(!r.pgcp.some((p) => p.id === "p3"));
});

test("quem já foi escolhido não é oferecido de novo", () => {
  const r = combinarResultados(entra, locais, "a", { entraIds: ["OID-1"], emails: ["maria@externo.com"] });
  assert.deepEqual(r.entra.map((u) => u.id), ["oid-2"]);
  assert.deepEqual(r.pgcp.map((p) => p.id), ["p2"]);
});

test("participante PGCP entra como attendee por e-mail, sem identidade Microsoft", () => {
  const sel = { origem: "pgcp" as const, participante: locais[0]! };
  const payload = selecionadoParaPayload(sel);
  assert.deepEqual(payload, {
    displayName: "Maria Souza",
    email: "maria@externo.com",
    participantType: "external",
    isConfirmed: false
  });
  assert.equal("entraObjectId" in payload, false);
  const [noConvite] = participantsPayload([selecionadoComoConvidado(sel, "Convidado")]);
  assert.equal(noConvite!.entraObjectId, undefined);
  assert.equal(noConvite!.participantType, "external");
  assert.equal(noConvite!.email, "maria@externo.com");
});

test("participante Entra mantém o fluxo corporativo (identidade Microsoft)", () => {
  const payload = selecionadoParaPayload({ origem: "entra", user: entra[0]! });
  assert.equal(payload.entraObjectId, "oid-1");
  assert.equal(payload.email, "joao@empresa.com");
  assert.equal(payload.participantType, undefined, "tipo derivado pelo servidor, como antes");
});

test("nenhuma pessoa externa ganha App Role, usuário ou identidade Entra", () => {
  const payload = selecionadoParaPayload({ origem: "pgcp", participante: locais[1]! }) as unknown as Record<string, unknown>;
  for (const campo of ["entraObjectId", "entraTenantId", "userId", "appRoles"]) {
    assert.equal(payload[campo], undefined, campo);
  }
});

// --- Sugestões por classificação (027) ------------------------------------

import { sugerirParticipantes, sugeridoParaSelecionado, nomeDoSugerido } from "./participant-search";
import type { DirectoryPerson } from "./external-participants-rules";

const classif = (gs: string[], ts: string[]) => ({
  governanceBodies: gs.map((id) => ({ id, name: id })),
  topics: ts.map((id) => ({ id, title: id }))
});
const pessoa = (id: string, nome: string, gs: string[], ts: string[]): DirectoryPerson => ({
  id, origin: "entra", entraObjectId: `oid-${id}`, displayName: nome, email: `${id}@empresa.com`,
  createdAt: "", updatedAt: "", ...classif(gs, ts)
});
const ext = (id: string, nome: string, gs: string[], ts: string[]) => ({ ...externo(id, nome, `${id}@externo.com`), ...classif(gs, ts) });

const dir = [pessoa("joao", "João", ["exec"], ["fin"]), pessoa("ana", "Ana", ["exec"], []), pessoa("rui", "Rui", ["aud"], ["fin"])];
const exts = [ext("maria", "Maria", ["exec"], ["fin"]), ext("carlos", "Carlos", ["exec"], ["aud"]), ext("lia", "Lia", [], [])];

test("contexto órgão: prioriza relacionados ao órgão (Entra e PGCP)", () => {
  const s = sugerirParticipantes(exts, dir, { governanceBodyId: "exec" });
  assert.deepEqual(s.orgaoETema, []);
  assert.deepEqual(s.orgao.map(nomeDoSugerido), ["Ana", "Carlos", "João", "Maria"]);
});

test("órgão + tema: primeiro quem tem os dois, depois só o órgão", () => {
  const s = sugerirParticipantes(exts, dir, { governanceBodyId: "exec", agendaTopicId: "fin" });
  assert.deepEqual(s.orgaoETema.map(nomeDoSugerido), ["João", "Maria"]);
  assert.deepEqual(s.orgao.map(nomeDoSugerido), ["Ana", "Carlos"]);
});

test("não classificados não são sugeridos, mas continuam pesquisáveis", () => {
  const s = sugerirParticipantes(exts, dir, { governanceBodyId: "exec", agendaTopicId: "fin" });
  assert.ok(![...s.orgaoETema, ...s.orgao].some((x) => nomeDoSugerido(x) === "Lia"));
  assert.deepEqual(combinarResultados([], exts, "lia").pgcp.map((p) => p.id), ["lia"]);
});

test("sem contexto não sugere; já escolhidos não voltam; sugestão não adiciona sozinha", () => {
  assert.deepEqual(sugerirParticipantes(exts, dir, {}), { orgaoETema: [], orgao: [] });
  const s = sugerirParticipantes(exts, dir, { governanceBodyId: "exec" }, { entraIds: ["OID-JOAO"], emails: ["maria@externo.com"] });
  assert.deepEqual(s.orgao.map(nomeDoSugerido), ["Ana", "Carlos"]);
  // Escolher uma sugestão vira a MESMA seleção da busca: Entra por identidade, externo por e-mail.
  const entra = sugeridoParaSelecionado({ origem: "entra", pessoa: dir[0]! });
  assert.equal(selecionadoParaPayload(entra).entraObjectId, "oid-joao");
  const pg = selecionadoParaPayload(sugeridoParaSelecionado({ origem: "pgcp", participante: exts[0]! }));
  assert.equal(pg.entraObjectId, undefined);
  assert.equal(pg.participantType, "external");
});
