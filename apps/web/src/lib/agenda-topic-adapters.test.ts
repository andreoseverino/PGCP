import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTopicFupPatch,
  buildTopicPayload,
  ensureResponsibleTopicParticipant,
  isResponsibleTopicParticipant,
  topicParticipantsToPayload,
  type TopicParticipant,
} from "./agenda-topic-adapters";

const MARIA = "11111111-1111-4111-8111-111111111111";
const JOAO = "22222222-2222-4222-8222-222222222222";

test("edição hidrata os participantes persistidos do detalhe da API", () => {
  const persisted: TopicParticipant[] = [
    {
      id: "p1",
      userId: null,
      userName: null,
      displayName: "Maria",
      email: "maria@example.com",
      entraTenantId: "tenant",
      entraObjectId: MARIA,
    },
    {
      id: "p2",
      userId: "user-2",
      userName: "João",
      displayName: null,
      email: null,
      entraTenantId: "tenant",
      entraObjectId: JOAO,
    },
  ];

  assert.deepEqual(topicParticipantsToPayload(persisted), [
    { entraObjectId: MARIA, displayName: "Maria", email: "maria@example.com" },
    { userId: "user-2", entraObjectId: JOAO, displayName: "João" },
  ]);
});

test("responsável aparece entre participantes sem duplicar identidade Entra", () => {
  const one = ensureResponsibleTopicParticipant([], "Maria", MARIA);
  assert.deepEqual(one, [{ entraObjectId: MARIA, displayName: "Maria" }]);

  const again = ensureResponsibleTopicParticipant(one, "Maria atualizada", MARIA.toUpperCase());
  assert.deepEqual(again, one);
});

test("responsável é reconhecido por oid, nunca por displayName", () => {
  assert.equal(
    isResponsibleTopicParticipant({ entraObjectId: MARIA, displayName: "Homônimo" }, MARIA),
    true,
  );
  assert.equal(
    isResponsibleTopicParticipant({ entraObjectId: JOAO, displayName: "Maria" }, MARIA),
    false,
  );
});

test("PATCH distingue participants ausente de participants vazio", () => {
  const absent = buildTopicPayload({ title: "Pauta" });
  assert.equal(Object.hasOwn(absent, "participants"), false);

  const empty = buildTopicPayload({ title: "Pauta", participants: [] });
  assert.equal(Object.hasOwn(empty, "participants"), true);
  assert.deepEqual(empty.participants, []);
});

test("bandeira FUP: PATCH só com generatesActionItem — nenhum campo não relacionado (nem null)", () => {
  assert.deepEqual(buildTopicFupPatch(true), { generatesActionItem: true });
  assert.deepEqual(buildTopicFupPatch(false), { generatesActionItem: false });
});

test("formulário Novo/Editar tema: sem FUP no corpo (criação usa default; edição preserva o gravado)", () => {
  const corpo = buildTopicPayload({
    title: "Resultado Financeiro",
    description: "Análise trimestral",
    durationMinutes: 90,
    responsibleLabel: "Usuário X",
    responsibleEntraObjectId: MARIA,
    typeId: "tipo",
    natureId: "natureza",
    isCircularTheme: true
  });
  assert.equal(Object.hasOwn(corpo, "generatesActionItem"), false);
  assert.deepEqual(
    { ...corpo },
    {
      title: "Resultado Financeiro",
      description: "Análise trimestral",
      estimatedDurationMinutes: 90,
      responsibleLabel: "Usuário X",
      responsibleEntraObjectId: MARIA,
      agendaTopicTypeId: "tipo",
      agendaTopicNatureId: "natureza",
      isCircularTheme: true
    }
  );
});
