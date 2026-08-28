import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { HttpError } from "../http-error.js";
import {
  PAPEL_PADRAO_DO_PARTICIPANTE,
  excluirMeetingParticipant,
  garantirResponsavelComoParticipante,
  participanteDoResponsavel,
} from "./agenda-item-participants.js";

/**
 * INVARIANTE DE NEGOCIO: responsavel de pauta que e PESSOA participa da reuniao.
 *
 * Os testes rodam SEM banco. As funcoes que tocam SQL recebem o `PoolClient` por
 * parametro, entao um cliente falso responde as consultas e guarda o que foi
 * executado — o que permite afirmar tanto o efeito (o INSERT aconteceu) quanto a
 * ausencia dele (nao duplicou, nao removeu ninguem).
 *
 * A ultima secao verifica a FIACAO lendo o fonte, no mesmo espirito de
 * `authz/route-guards.test.ts`: a regressao real e alguem acrescentar um caminho
 * de escrita de pauta e esquecer a garantia. Comentarios sao removidos antes da
 * varredura — senao a prosa desta explicacao passaria por chamada de funcao.
 */

const ATOR = {
  userId: "00000000-0000-4000-8000-000000000001",
  name: "Assessoria",
  entraTenantId: "00000000-0000-4000-8000-0000000000ff",
};
const REUNIAO = "11111111-1111-4111-8111-111111111111";
const OID = "22222222-2222-4222-8222-222222222222";

interface Consulta {
  sql: string;
  params: unknown[];
}

type Resposta = { rows?: unknown[]; rowCount?: number } | undefined;

/** Cliente de banco falso: responde por trecho de SQL e registra tudo. */
function clienteFalso(responder: (sql: string) => Resposta) {
  const consultas: Consulta[] = [];
  const client = {
    async query(sql: string, params: unknown[] = []) {
      consultas.push({ sql, params });
      const resposta = responder(sql) ?? {};
      const rows = resposta.rows ?? [];
      return { rows, rowCount: resposta.rowCount ?? rows.length };
    },
  };
  return { client: client as unknown as PoolClient, consultas };
}

const executou = (consultas: Consulta[], trecho: string): boolean =>
  consultas.some((c) => c.sql.includes(trecho));

// --- quem vira participante (funcao pura) ------------------------------------

test("responsavel com identidade no diretorio vira participante", () => {
  const participante = participanteDoResponsavel({
    responsibleLabel: "  Thiago Rufino  ",
    responsibleEntraObjectId: `  ${OID}  `,
  });

  assert.deepEqual(participante, {
    entraObjectId: OID,
    displayName: "Thiago Rufino",
    roleInMeeting: PAPEL_PADRAO_DO_PARTICIPANTE,
    isConfirmed: false,
  });
  assert.equal(PAPEL_PADRAO_DO_PARTICIPANTE, "Convidado");
});

test("presenca NAO nasce confirmada", () => {
  const participante = participanteDoResponsavel({
    responsibleLabel: "Thiago Rufino",
    responsibleEntraObjectId: OID,
  });
  assert.equal(participante?.isConfirmed, false);
});

test("coletivo, area e texto livre NAO viram participante", () => {
  for (const rotulo of ["Todos", "Comitê de Auditoria", "Diretoria Financeira", "a definir"]) {
    assert.equal(
      participanteDoResponsavel({ responsibleLabel: rotulo }),
      null,
      `nao deveria criar participante para: ${rotulo}`,
    );
  }
});

test("identidade sem rotulo, e rotulo em branco, nao viram participante", () => {
  assert.equal(participanteDoResponsavel({ responsibleEntraObjectId: OID }), null);
  assert.equal(
    participanteDoResponsavel({ responsibleLabel: "   ", responsibleEntraObjectId: OID }),
    null,
  );
  assert.equal(participanteDoResponsavel({}), null);
  assert.equal(
    participanteDoResponsavel({ responsibleLabel: null, responsibleEntraObjectId: null }),
    null,
  );
});

// --- efeito no banco ---------------------------------------------------------

test("responsavel pessoa e ADICIONADO quando ainda nao esta na reuniao", async () => {
  const { client, consultas } = clienteFalso((sql) => {
    if (sql.includes("FROM users")) return { rows: [] };
    if (sql.includes("SELECT id FROM meeting_participants")) return { rows: [] };
    if (sql.includes("INSERT INTO meeting_participants")) return { rows: [{ id: "novo-participante" }] };
    return { rows: [] };
  });

  const resultado = await garantirResponsavelComoParticipante(
    client,
    REUNIAO,
    { responsibleLabel: "Thiago Rufino", responsibleEntraObjectId: OID },
    ATOR,
    "Reunião de Diretoria",
  );

  assert.deepEqual(resultado, { id: "novo-participante", criado: true });

  const insert = consultas.find((c) => c.sql.includes("INSERT INTO meeting_participants"));
  assert.ok(insert, "deveria inserir o participante");
  assert.ok(insert.params.includes("Thiago Rufino"), "grava o nome exibido");
  assert.ok(insert.params.includes(PAPEL_PADRAO_DO_PARTICIPANTE), "usa o papel padrão existente");
  assert.ok(insert.params.includes(OID), "grava a identidade do diretório");
  assert.ok(insert.params.includes(ATOR.entraTenantId), "tenant vem da autenticação, não do corpo");
  // Presença não confirmada é afirmada no teste da regra pura, acima: aqui
  // bastaria olhar a posição do parâmetro, e isso amarraria o teste ao formato
  // do INSERT em vez de ao comportamento.
  assert.equal(insert.params.includes(true), false, "nada entra marcado como confirmado");
});

test("responsavel que JA e participante nao duplica", async () => {
  const { client, consultas } = clienteFalso((sql) => {
    if (sql.includes("FROM users")) return { rows: [] };
    if (sql.includes("SELECT id FROM meeting_participants")) return { rows: [{ id: "ja-existe" }] };
    return { rows: [] };
  });

  const resultado = await garantirResponsavelComoParticipante(
    client,
    REUNIAO,
    { responsibleLabel: "Thiago Rufino", responsibleEntraObjectId: OID },
    ATOR,
    "Reunião de Diretoria",
  );

  assert.deepEqual(resultado, { id: "ja-existe", criado: false });
  assert.equal(executou(consultas, "INSERT INTO meeting_participants"), false);
});

test("responsavel coletivo nao gera consulta nenhuma", async () => {
  const { client, consultas } = clienteFalso(() => ({ rows: [] }));

  const resultado = await garantirResponsavelComoParticipante(
    client,
    REUNIAO,
    { responsibleLabel: "Todos" },
    ATOR,
    "Reunião de Diretoria",
  );

  assert.equal(resultado, null);
  assert.equal(consultas.length, 0);
});

test("deduplicacao consulta identificador estavel, nunca nome", async () => {
  const { client, consultas } = clienteFalso((sql) => {
    if (sql.includes("FROM users")) return { rows: [] };
    if (sql.includes("SELECT id FROM meeting_participants")) return { rows: [{ id: "x" }] };
    return { rows: [] };
  });

  await garantirResponsavelComoParticipante(
    client,
    REUNIAO,
    { responsibleLabel: "Thiago Rufino", responsibleEntraObjectId: OID },
    ATOR,
    "Reunião",
  );

  const busca = consultas.find((c) => c.sql.includes("SELECT id FROM meeting_participants"));
  assert.ok(busca);
  assert.ok(busca.sql.includes("user_id = $2"), "dedup por users.id");
  assert.ok(busca.sql.includes("entra_object_id = $3"), "dedup por oid do Entra");
  assert.equal(busca.sql.includes("display_name"), false, "nome não é chave de deduplicação");
});

// --- remocao: a barreira e do backend ----------------------------------------

test("remover participante que responde por pauta e RECUSADO (409)", async () => {
  const { client, consultas } = clienteFalso((sql) => {
    if (sql.includes("JOIN meeting_agenda_items")) return { rows: [{ title: "Orçamento 2027" }] };
    return { rows: [] };
  });

  await assert.rejects(
    () => excluirMeetingParticipant(client, REUNIAO, "participante-1", ATOR, "Reunião"),
    (erro: unknown) => {
      assert.ok(erro instanceof HttpError);
      assert.equal(erro.status, 409);
      assert.match(erro.message, /Orçamento 2027/);
      return true;
    },
  );

  assert.equal(executou(consultas, "DELETE FROM meeting_participants"), false, "nada é apagado");
});

test("a recusa casa por identidade e nao alcanca outra reuniao", async () => {
  const { client, consultas } = clienteFalso(() => ({ rows: [] }));
  await excluirMeetingParticipant(client, REUNIAO, "participante-1", ATOR, "Reunião");

  const guarda = consultas.find((c) => c.sql.includes("JOIN meeting_agenda_items"));
  assert.ok(guarda);
  assert.ok(guarda.sql.includes("responsible_entra_object_id = mp.entra_object_id"));
  assert.ok(guarda.sql.includes("responsible_entra_tenant_id = mp.entra_tenant_id"));
  assert.ok(guarda.sql.includes("mp.meeting_id = $2"), "não alcança participante de outra reunião");
  assert.deepEqual(guarda.params, ["participante-1", REUNIAO]);
});

test("participante sem pauta sob responsabilidade continua removivel", async () => {
  const { client, consultas } = clienteFalso((sql) => {
    if (sql.includes("JOIN meeting_agenda_items")) return { rows: [] };
    if (sql.includes("DELETE FROM meeting_participants")) return { rows: [], rowCount: 1 };
    return { rows: [] };
  });

  const removidos = await excluirMeetingParticipant(client, REUNIAO, "participante-1", ATOR, "Reunião");

  assert.equal(removidos, 1);
  assert.ok(executou(consultas, "DELETE FROM meeting_participants"));
  assert.ok(executou(consultas, "INSERT INTO audit_logs"), "remoção fica na trilha");
});

// --- fiacao: todo caminho de escrita de pauta aplica a regra ------------------

/** Remove comentarios: a varredura enxerga codigo, nao prosa. */
function semComentarios(fonte: string): string {
  const blocos = new RegExp("/\\*[\\s\\S]*?\\*/", "g");
  const linhas = new RegExp("^[ \\t]*//.*$", "gm");
  return fonte.replace(blocos, "").replace(linhas, "");
}

/** Corpo de uma funcao exportada, ate a proxima declaracao de topo. */
function corpoDaFuncao(fonte: string, assinatura: string): string {
  const inicio = fonte.indexOf(assinatura);
  assert.notEqual(inicio, -1, `função não encontrada: ${assinatura}`);
  const seguinte = fonte.indexOf("\nexport ", inicio + assinatura.length);
  return fonte.slice(inicio, seguinte === -1 ? undefined : seguinte);
}

const fonteDe = (arquivo: string): string =>
  semComentarios(readFileSync(new URL(arquivo, import.meta.url), "utf8"));

test("criar reuniao, adicionar pauta e trocar responsavel aplicam a garantia", () => {
  const caminhos: [string, string][] = [
    ["./create.ts", "export async function createMeeting("],
    ["./update.ts", "export async function addAgendaItem("],
    ["./update.ts", "export async function updateAgendaItem("],
  ];

  for (const [arquivo, assinatura] of caminhos) {
    const corpo = corpoDaFuncao(fonteDe(arquivo), assinatura);
    assert.match(
      corpo,
      /await garantirResponsavelComoParticipante\(/,
      `${assinatura} precisa garantir o responsável como participante`,
    );
  }
});

test("os caminhos que criam participante travam a reuniao", () => {
  const update = fonteDe("./update.ts");
  for (const assinatura of [
    "export async function addAgendaItem(",
    "export async function updateAgendaItem(",
    "export async function addAgendaItemParticipant(",
  ]) {
    assert.match(
      corpoDaFuncao(update, assinatura),
      /exigirReuniaoTravada\(/,
      `${assinatura} precisa do lock da reunião (serializa o find-or-create)`,
    );
  }
  assert.match(update, /FOR UPDATE/, "o lock existe de fato");
});

test("a recusa vive dentro da remocao compartilhada, nao em uma rota so", () => {
  const corpo = corpoDaFuncao(
    fonteDe("./agenda-item-participants.ts"),
    "export async function excluirMeetingParticipant(",
  );
  assert.match(corpo, /await recusarRemocaoDeResponsavel\(/);

  const update = fonteDe("./update.ts");
  for (const assinatura of [
    "export async function removeParticipant(",
    "export async function removeAgendaItemParticipant(",
  ]) {
    assert.match(
      corpoDaFuncao(update, assinatura),
      /excluirMeetingParticipant\(/,
      `${assinatura} precisa remover pela fonte única — é lá que está a recusa`,
    );
  }
});

test("trocar ou remover responsavel NAO remove participante", () => {
  const update = fonteDe("./update.ts");
  for (const assinatura of [
    "export async function updateAgendaItem(",
    "export async function removeAgendaItem(",
  ]) {
    const corpo = corpoDaFuncao(update, assinatura);
    assert.equal(
      /excluirMeetingParticipant\(|DELETE FROM meeting_participants/.test(corpo),
      false,
      `${assinatura} não pode desconvidar ninguém`,
    );
  }
});
