import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AVISO_TEAMS_CONTINGENCIA,
  montarAttendees,
  CAMPOS_QUE_DESATUALIZAM,
  exigeResincronizacao,
  montarEvento,
  planejarChamadaDoEvento,
  type ReuniaoParaCalendario,
} from "./mapper.js";
import type { LocalFisico } from "../meetings/locations.js";

/**
 * Convite Outlook/Teams por modalidade (025) e reuso do evento existente.
 * Puro: sem banco e sem Graph.
 */

const base: ReuniaoParaCalendario = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Comitê Executivo",
  description: null,
  startAt: new Date("2027-01-20T12:00:00Z"),
  endAt: new Date("2027-01-20T14:00:00Z"),
  timezone: "America/Sao_Paulo",
  meetingLink: null,
  onlineMeetingProvider: "teamsForBusiness",
};

/** Cópia do local como fica gravada na reunião (038). */
const MATRIZ: LocalFisico = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  name: "Sede Matriz",
  street: "Rua de Teste",
  number: "100",
  complement: "10º andar",
  neighborhood: "Centro",
  city: "Cidade",
  state: "SP",
  postalCode: "01310100",
};
/** Local importado do catálogo antigo: só nome (backfill da 038). */
const LEOPOLDO_SEM_ENDERECO: LocalFisico = {
  id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  name: "Sede Leopoldo",
  street: null,
  number: null,
  complement: null,
  neighborhood: null,
  city: null,
  state: null,
  postalCode: null,
};

test("online cria Teams e não envia local físico", () => {
  const evento = montarEvento({ ...base, modality: "online", physicalLocation: null }, []);
  assert.equal(evento.isOnlineMeeting, true);
  assert.equal(evento.onlineMeetingProvider, "teamsForBusiness");
  assert.equal(evento.location, undefined);
  assert.ok(!evento.body.content.includes(AVISO_TEAMS_CONTINGENCIA));
});

test("reunião legada (sem modalidade) mantém o payload anterior", () => {
  const evento = montarEvento(base, []);
  assert.equal(evento.isOnlineMeeting, true);
  assert.equal(evento.location, undefined);
  assert.equal(evento.body.content, "");
});

test("presencial TAMBÉM cria Teams, como contingência", () => {
  const evento = montarEvento({ ...base, modality: "in_person", physicalLocation: MATRIZ }, []);
  assert.equal(evento.isOnlineMeeting, true, "Teams não pode sumir no presencial");
  assert.equal(evento.onlineMeetingProvider, "teamsForBusiness");
  assert.ok(evento.body.content.includes(AVISO_TEAMS_CONTINGENCIA));
  assert.ok(evento.body.content.includes("Reunião presencial"));
});

test("presencial envia nome e endereço do local (cópia da reunião) no evento e no convite", () => {
  const evento = montarEvento({ ...base, modality: "in_person", physicalLocation: MATRIZ }, []);
  assert.equal(
    evento.location?.displayName,
    "Sede Matriz — Rua de Teste, 100, 10º andar — Centro, Cidade/SP, CEP 01310-100",
  );
  assert.deepEqual(evento.location?.address, {
    street: "Rua de Teste, 100, 10º andar, Centro",
    city: "Cidade",
    state: "SP",
    postalCode: "01310-100",
  });
  assert.ok(evento.body.content.includes("Rua de Teste, 100"));
  assert.equal(evento.location?.locationType, "default", "sem geocodificação/coordenadas");
});

test("endereço com HTML vai escapado no corpo do convite", () => {
  const evento = montarEvento(
    { ...base, modality: "in_person", physicalLocation: { ...MATRIZ, name: "<b>Sala</b> & Co" } },
    [],
  );
  assert.ok(!evento.body.content.includes("<b>Sala</b>"));
  assert.ok(evento.body.content.includes("&lt;b&gt;Sala&lt;/b&gt; &amp; Co"));
});

test("presencial sem endereço (local importado) leva só o nome — nada inventado", () => {
  const evento = montarEvento({ ...base, modality: "in_person", physicalLocation: LEOPOLDO_SEM_ENDERECO }, []);
  assert.equal(evento.location?.displayName, "Sede Leopoldo");
  assert.equal(evento.location?.address, undefined);
});

test("evento existente: PATCH no mesmo id, sem transactionId (não duplica)", () => {
  const evento = montarEvento(base, [], { idempotencyKey: "chave-fixa" });
  const chamada = planejarChamadaDoEvento("oid-organizador", "evento-123", evento);
  assert.equal(chamada.method, "PATCH");
  assert.equal(chamada.path, "/users/oid-organizador/events/evento-123");
  assert.equal("transactionId" in chamada.body, false);
});

test("sem evento: POST com a chave de idempotência fixa", () => {
  const evento = montarEvento(base, [], { idempotencyKey: "chave-fixa" });
  const chamada = planejarChamadaDoEvento("oid-organizador", null, evento);
  assert.equal(chamada.method, "POST");
  assert.equal(chamada.path, "/users/oid-organizador/events");
  assert.equal(chamada.body.transactionId, "chave-fixa");
});

test("trocar data, horário, modalidade ou local desatualiza o evento; pauta/tema não", () => {
  for (const campo of ["startAt", "endAt", "modality", "physicalLocationId"]) {
    assert.ok(exigeResincronizacao([campo]), `${campo} deveria reprojetar o convite`);
  }
  assert.ok(!exigeResincronizacao(["status", "recurrence"]));
  assert.ok(!(CAMPOS_QUE_DESATUALIZAM as readonly string[]).includes("agendaItems"));
});

test("regressão: Presencial (Sede Matriz) -> Online remove o local físico do MESMO evento", () => {
  const matriz = MATRIZ;
  const antes = planejarChamadaDoEvento(
    "oid-organizador",
    "evento-123",
    montarEvento({ ...base, modality: "in_person", physicalLocation: matriz }, [], { idempotencyKey: "k" }),
  );
  assert.equal(antes.method, "PATCH");
  assert.match(antes.body.location!.displayName, /Sede Matriz/);

  // Alteração da reunião para Online: próxima sincronização reprojeta o evento.
  const depois = planejarChamadaDoEvento(
    "oid-organizador",
    "evento-123",
    montarEvento({ ...base, modality: "online", physicalLocation: null }, [], { idempotencyKey: "k" }),
  );
  assert.equal(depois.method, "PATCH", "reutiliza o evento; nunca cria outro");
  assert.equal(depois.path, "/users/oid-organizador/events/evento-123");
  assert.deepEqual(depois.body.location, { displayName: "", locationType: "default" });
  assert.deepEqual(depois.body.locations, []);
  assert.equal(depois.body.isOnlineMeeting, true, "Teams preservado");
  assert.equal(depois.body.onlineMeetingProvider, "teamsForBusiness");
  assert.equal(depois.body.start.timeZone, "America/Sao_Paulo", "timezone preservado");
  assert.equal("transactionId" in depois.body, false);
  assert.ok(!depois.body.body.content.includes("Sede Matriz"));
});

test("criação online (POST) não envia remoção de local — não há local anterior", () => {
  const chamada = planejarChamadaDoEvento("oid", null, montarEvento({ ...base, modality: "online" }, []));
  assert.equal(chamada.body.location, undefined);
  assert.equal(chamada.body.locations, undefined);
});

test("participante externo (só e-mail, sem identidade Entra) vira attendee do convite", () => {
  const { attendees, semEndereco } = montarAttendees([
    {
      participantId: "p1",
      displayName: "Convidada Externa",
      email: "convidada@parceiro.com.br",
      userPrincipalName: null,
      userId: null,
      entraTenantId: null,
      entraObjectId: null,
    },
  ]);
  assert.deepEqual(semEndereco, []);
  assert.equal(attendees[0]!.emailAddress.address, "convidada@parceiro.com.br");
});
