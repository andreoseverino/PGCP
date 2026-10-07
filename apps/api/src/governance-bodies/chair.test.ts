import "../env.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import pool from "../database.js";
import { HttpError } from "../http-error.js";
import { parseInput } from "./service.js";

const ID = "11111111-1111-4111-8111-111111111111";

test("Presidente da Mesa: Entra continua aceito; externo só pelo id do cadastro", () => {
  assert.deepEqual(parseInput({ name: "Comitê", chair: { entraObjectId: ID, displayName: " Ana " } }).chair, {
    entraObjectId: ID,
    displayName: "Ana",
  });
  assert.deepEqual(parseInput({ name: "Comitê", chair: { externalParticipantId: ID.toUpperCase() } }).chair, {
    externalParticipantId: ID,
  });
  assert.equal(parseInput({ name: "Comitê", chair: null }).chair, null);
  assert.equal(parseInput({ name: "Comitê" }).chair, undefined);
});

test("Presidente externo: cliente não escolhe nome, tenant nem mistura as origens", () => {
  for (const chair of [
    { externalParticipantId: ID, displayName: "Forjado" },
    { externalParticipantId: ID, entraObjectId: ID },
    { externalParticipantId: "nao-e-uuid" },
    { externalParticipantId: 42 },
    { externalParticipantId: ID, entraTenantId: ID },
    { externalParticipantId: ID, userId: ID },
  ]) {
    assert.throws(() => parseInput({ name: "Comitê", chair }), HttpError, JSON.stringify(chair));
  }
});

test("Presidente externo NÃO concede acesso: nenhuma escrita em users nem App Role", () => {
  const fonte = readFileSync(new URL("./service.ts", import.meta.url), "utf8");
  assert.ok(!/INSERT INTO users|UPDATE users|app_role/i.test(fonte));
  // Nome do externo vem do cadastro, conferido no servidor (404 se não existir).
  assert.match(fonte, /SELECT full_name FROM external_participants WHERE id = \$1/);
  const externos = readFileSync(new URL("../external-participants/service.ts", import.meta.url), "utf8");
  assert.match(externos, /chair_external_participant_id = \$1[\s\S]*?throw new HttpError\(\s*409/);
});

// Integração com o banco local (pulada sem banco): o CHECK da 035 impede as
// duas origens ao mesmo tempo, e a FK RESTRICT protege o cadastro.
let semBanco: string | false = false;
try {
  const { rows } = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'governance_bodies' AND column_name = 'chair_external_participant_id'",
  );
  if (rows.length === 0) semBanco = "migration 035 não aplicada";
} catch (error) {
  semBanco = `PostgreSQL indisponível (${(error as Error).message})`;
}
after(() => pool.end());

test("integração: Entra e externo ao mesmo tempo é recusado pelo banco", { skip: semBanco }, async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: u } = await client.query<{ id: string }>("SELECT id FROM users LIMIT 1");
    const { rows: ep } = await client.query<{ id: string }>(
      `INSERT INTO external_participants (full_name, email, phone, created_by_user_id)
            VALUES ('Externa Teste', 'externa.teste.chair@parceiro.example', '+55 11 99999-0000', $1) RETURNING id`,
      [u[0]!.id],
    );
    const { rows: gb } = await client.query<{ id: string }>(
      `INSERT INTO governance_bodies (name, chair_external_participant_id, chair_name)
            VALUES ('Órgão Teste Chair Externo', $1, 'Externa Teste') RETURNING id`,
      [ep[0]!.id],
    );
    assert.ok(gb[0]);
    await client.query("SAVEPOINT s");
    await assert.rejects(
      client.query("UPDATE governance_bodies SET chair_entra_tenant_id = $2, chair_entra_object_id = $2 WHERE id = $1", [gb[0].id, ID]),
      /governance_bodies_chair_single_source_check/,
    );
    await client.query("ROLLBACK TO SAVEPOINT s");
    await assert.rejects(client.query("DELETE FROM external_participants WHERE id = $1", [ep[0]!.id]), /foreign key|violates/);
  } finally {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
  }
});
