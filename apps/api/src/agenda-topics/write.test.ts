import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import {
  exigirParticipanteRemovivelDaBiblioteca,
  parseAgendaTopicInput,
  reconciliarParticipantesDaBiblioteca,
} from "./write.js";

/**
 * Contrato de escrita da Biblioteca (`agenda_topics`) para o PADRÃO de tema
 * circular. Funções puras: sem banco, sem rede.
 *
 * O eixo é distinto do efetivo da reunião (`meeting_agenda_items`, testado em
 * meetings/create.test.ts): aqui é só o valor-padrão que será copiado no vínculo.
 */

test("parseAgendaTopicInput aceita isCircularTheme boolean e ausência (default)", () => {
  assert.equal(parseAgendaTopicInput({ title: "P", isCircularTheme: true }).isCircularTheme, true);
  assert.equal(parseAgendaTopicInput({ title: "P", isCircularTheme: false }).isCircularTheme, false);
  // Ausente => undefined (o INSERT aplica o default false da coluna).
  assert.equal(parseAgendaTopicInput({ title: "P" }).isCircularTheme, undefined);
});

test("parseAgendaTopicInput recusa isCircularTheme não-boolean (string/número/objeto)", () => {
  for (const v of ["true", "sim", 1, 0, {}, [], "false"]) {
    assert.throws(
      () => parseAgendaTopicInput({ title: "P", isCircularTheme: v }),
      HttpError,
      `deveria recusar: ${JSON.stringify(v)}`,
    );
  }
});

test("parseAgendaTopicInput (parcial) aceita só isCircularTheme, true e false", () => {
  assert.equal(parseAgendaTopicInput({ isCircularTheme: true }, true).isCircularTheme, true);
  assert.equal(parseAgendaTopicInput({ isCircularTheme: false }, true).isCircularTheme, false);
});

test("parseAgendaTopicInput mantém allowlist fechada (mass assignment bloqueado)", () => {
  // Campo desconhecido é RECUSADO, não ignorado — inclusive junto do novo campo.
  assert.throws(
    () => parseAgendaTopicInput({ title: "P", isCircularTheme: true, sourceMeetingId: "x" }),
    HttpError,
  );
  assert.throws(() => parseAgendaTopicInput({ title: "P", ownerUserId: "x" }), HttpError);
});

test("PATCH distingue participants ausente de lista vazia", () => {
  const absent = parseAgendaTopicInput({ title: "P" }, true);
  assert.equal(absent.participants, undefined);

  const empty = parseAgendaTopicInput({ participants: [] }, true);
  assert.deepEqual(empty.participants, []);
});

interface QueryLog {
  sql: string;
  params: unknown[];
}

function fakeClient(rowsFor: (sql: string) => unknown[] = () => []) {
  const queries: QueryLog[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      const rows = rowsFor(sql);
      return { rows, rowCount: rows.length };
    },
  };
  return { client: client as unknown as PoolClient, queries };
}

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MARIA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JOAO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TOPIC = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("reconciliação adiciona selecionados, remove ausentes e evita duplicidade", async () => {
  let nextId = 0;
  const { client, queries } = fakeClient((sql) => {
    if (sql.includes("INSERT INTO agenda_topic_participants")) {
      nextId += 1;
      return [{ id: `p${nextId}` }];
    }
    return [];
  });

  await reconciliarParticipantesDaBiblioteca(
    client,
    TOPIC,
    [
      { entraObjectId: MARIA, displayName: "Maria" },
      { entraObjectId: JOAO, displayName: "João" },
      { entraObjectId: MARIA, displayName: "Maria repetida" },
    ],
    TENANT,
    { label: "Maria", entraTenantId: TENANT, entraObjectId: MARIA },
  );

  assert.equal(
    queries.filter((query) => query.sql.includes("DELETE FROM agenda_topic_participants")).length,
    1,
  );
  const inserts = queries.filter((query) => query.sql.includes("INSERT INTO agenda_topic_participants"));
  assert.equal(inserts.length, 2, "Maria e João, sem duplicar Maria como responsável");
  assert.ok(inserts.every((query) => query.sql.includes("ON CONFLICT DO NOTHING")));
  assert.ok(inserts.some((query) => query.params.includes(MARIA)));
  assert.ok(inserts.some((query) => query.params.includes(JOAO)));
});

test("participants=[] remove opcionais mas reinsere o responsável", async () => {
  const { client, queries } = fakeClient((sql) =>
    sql.includes("INSERT INTO agenda_topic_participants") ? [{ id: "responsavel" }] : [],
  );

  await reconciliarParticipantesDaBiblioteca(
    client,
    TOPIC,
    [],
    TENANT,
    { label: "Maria", entraTenantId: TENANT, entraObjectId: MARIA },
  );

  assert.equal(queries[0]!.sql.includes("DELETE FROM agenda_topic_participants"), true);
  const inserts = queries.filter((query) => query.sql.includes("INSERT INTO agenda_topic_participants"));
  assert.equal(inserts.length, 1);
  assert.ok(inserts[0]!.params.includes(MARIA));
});

test("backend recusa remover o responsável e restringe a busca ao topicId", async () => {
  const { client, queries } = fakeClient(() => [{ title: "Orçamento", is_responsible: true }]);

  await assert.rejects(
    exigirParticipanteRemovivelDaBiblioteca(client, TOPIC, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.deepEqual(queries[0]!.params, [TOPIC, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);
  assert.match(queries[0]!.sql, /p\.agenda_topic_id = t\.id/);
  assert.match(queries[0]!.sql, /coalesce\(p\.entra_object_id, u\.entra_object_id\)/);
});

test("create e PATCH aplicam a garantia; PATCH ausente preserva a coleção", () => {
  const source = readFileSync(new URL("./write.ts", import.meta.url), "utf8");
  assert.match(source, /createAgendaTopic[\s\S]*reconciliarParticipantesDaBiblioteca\(/);
  assert.match(source, /if \(input\.participants !== undefined\)[\s\S]*reconciliarParticipantesDaBiblioteca\(/);
  assert.match(source, /else \{[\s\S]*garantirResponsavelNaBiblioteca\(/);
});

test("migration 022 só acrescenta vínculos por identidade e é idempotente", () => {
  const sql = readFileSync(
    new URL("../../migrations/022_backfill_agenda_responsible_participants.sql", import.meta.url),
    "utf8",
  );
  const executable = sql.replace(/--.*$/gm, "");

  assert.match(executable, /INSERT INTO meeting_agenda_item_participants/);
  assert.match(executable, /mp\.meeting_id = ai\.meeting_id/);
  assert.match(executable, /mp\.entra_tenant_id = ai\.responsible_entra_tenant_id/);
  assert.match(executable, /mp\.entra_object_id = ai\.responsible_entra_object_id/);
  assert.match(executable, /INSERT INTO agenda_topic_participants/);
  assert.equal((executable.match(/ON CONFLICT DO NOTHING/g) ?? []).length, 2);
  assert.doesNotMatch(executable, /\bDELETE\b|\bUPDATE\b|\bDROP\b|\bALTER\b/i);
});

/*
 * Semântica do PATCH (`parseAgendaTopicInput(body, true)` + UPDATE dinâmico em
 * `updateAgendaTopic`, que só grava as chaves presentes): campo OMITIDO fica
 * como está; campo `null` APAGA. A bandeira FUP da Biblioteca depende disso.
 */
test("PATCH da bandeira FUP: só generatesActionItem chega ao UPDATE", () => {
  for (const marcado of [true, false]) {
    const saida = parseAgendaTopicInput({ generatesActionItem: marcado }, true);
    assert.deepEqual(saida, { generatesActionItem: marcado });
  }
});

test("PATCH com null é limpeza explícita (por isso a bandeira não envia nulls)", () => {
  const saida = parseAgendaTopicInput(
    { generatesActionItem: true, description: null, estimatedDurationMinutes: null, agendaTopicTypeId: null },
    true,
  );
  assert.equal(saida.description, null);
  assert.equal(saida.estimatedDurationMinutes, null);
  assert.equal(saida.agendaTopicTypeId, null);
  // E o UPDATE grava toda chave diferente de undefined.
  const fonte = readFileSync(new URL("./write.ts", import.meta.url), "utf8");
  assert.match(fonte, /if \(valor !== undefined\) bind\(coluna, valor\);/);
});

test("criação sem generatesActionItem usa o default false", () => {
  assert.equal(parseAgendaTopicInput({ title: "Novo tema" }).generatesActionItem, undefined);
  const fonte = readFileSync(new URL("./write.ts", import.meta.url), "utf8");
  assert.match(fonte, /input\.generatesActionItem \?\? false,/);
});
