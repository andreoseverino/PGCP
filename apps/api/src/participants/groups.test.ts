import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { HttpError } from "../http-error.js";
import { parseNovoMembro } from "./groups.js";

const OID = "aaaaaaaa-1111-4111-8111-111111111111";
const EXT = "bbbbbbbb-2222-4222-8222-222222222222";
const fonte = (arq: string) => readFileSync(new URL(arq, import.meta.url), "utf8");

test("grupo do órgão: corpo fechado — só a pessoa escolhida (diretório OU externo)", () => {
  assert.deepEqual(parseNovoMembro({ entraObjectId: OID.toUpperCase() }), { entraObjectId: OID });
  assert.deepEqual(parseNovoMembro({ externalParticipantId: EXT }), { externalParticipantId: EXT });
  for (const corpo of [
    {},
    { entraObjectId: OID, externalParticipantId: EXT },
    { entraObjectId: "nao-e-uuid" },
    { externalParticipantId: 42 },
    // Mass assignment: nome, e-mail, tenant, órgão e papel nunca vêm do cliente.
    { entraObjectId: OID, displayName: "Forjado" },
    { externalParticipantId: EXT, governanceBodyId: OID },
    { entraObjectId: OID, entraTenantId: OID },
    { entraObjectId: OID, appRole: "PGCP.Admin" },
    [],
    null,
  ]) {
    assert.throws(() => parseNovoMembro(corpo), HttpError, JSON.stringify(corpo));
  }
});

test("grupo do órgão: na criação, depois dos manuais e antes dos temas", () => {
  const create = fonte("../meetings/create.ts");
  const ini = create.indexOf("export async function inserirReuniao(");
  const corpo = create.slice(ini);
  const manuais = corpo.indexOf("for (const p of participantes)");
  const grupo = corpo.indexOf("await incluirGrupoDoOrgao(client, meetingId, input.governanceBodyId, actor, input.title)");
  const temas = corpo.indexOf("for (const item of input.agendaItems)");
  assert.ok(manuais > 0 && grupo > manuais && temas > grupo, "manuais → grupo → temas");
  // Edição/PATCH/Agenda Anual não reprocessam o grupo inteiro.
  for (const arq of ["../meetings/update.ts", "../annual-agendas/service.ts", "./groups.ts"]) {
    assert.ok(!/incluirGrupoDoOrgao\(/.test(fonte(arq)), arq);
  }
});

test("entrar no grupo: reuniões ABERTAS existentes recebem a pessoa; sair do grupo não mexe em reunião", () => {
  const grupos = fonte("./groups.ts");
  // Mesma regra da etapa "Realizada" do Pipeline; passadas não encerradas também ficam de fora.
  assert.match(grupos, /m\.status NOT IN \('done', 'approved', 'closed'\)/);
  assert.match(grupos, /m\.end_at >= now\(\) OR m\.status = 'in_progress'/);
  const adicionar = grupos.slice(grupos.indexOf("export async function adicionarAoGrupoDoOrgao("), grupos.indexOf("export async function removerDoGrupoDoOrgao("));
  assert.match(adicionar, /FOR UPDATE/, "reuniões travadas na mesma transação");
  assert.match(adicionar, /incluirMembroDoGrupo\(client, reuniao\.id, pessoa, ator, reuniao\.title\)/);
  assert.match(adicionar, /mantida\(s\) fora por exceção/, "auditoria conta as exceções");
  const remover = grupos.slice(grupos.indexOf("export async function removerDoGrupoDoOrgao("));
  assert.ok(!/meeting_participants|incluirMembroDoGrupo|excluirMeetingParticipant/.test(remover));
});

test("exceção por reunião: remover registra; automático respeita; inclusão explícita apaga", () => {
  const aip = fonte("../meetings/agenda-item-participants.ts");
  const excluir = aip.slice(aip.indexOf("export async function excluirMeetingParticipant("), aip.indexOf("export async function vincularParticipanteNaPauta("));
  assert.match(excluir, /registrarExclusao\(/);
  assert.ok(!/participant_governance_bodies|agenda_topic_participants/.test(excluir), "remover da reunião não toca nos grupos");

  const inserir = aip.slice(aip.indexOf("export async function inserirMeetingParticipant("), aip.indexOf("export async function findOrCreateMeetingParticipant("));
  assert.match(inserir, /limparExclusao\(/);

  const copia = aip.slice(aip.indexOf("export async function snapshotTopicParticipantsIntoItem("), aip.indexOf("export async function incluirMembroDoGrupo("));
  assert.match(copia, /if \(await estaExcluidaDaReuniao\(client, meetingId, identidade\)\) continue;/);
  const grupo = aip.slice(aip.indexOf("export async function incluirMembroDoGrupo("));
  assert.match(grupo, /if \(await estaExcluidaDaReuniao\(client, meetingId, identidade\)\) return "excluida";/);
  // Nunca dois convites para o mesmo endereço; externo sem identidade Microsoft.
  assert.match(grupo, /lower\(email\) = lower\(\$2\)/);
  assert.match(grupo, /\{ displayName: m\.nome, email: m\.email \?\? undefined, participantType: "external" \}/);
  assert.match(grupo, /incluirMembroDoGrupo\(\s*client,\s*meetingId,/, "criação usa o mesmo helper");
  // Só pessoas do diretório do tenant de quem cria.
  assert.match(grupo, /dp\.entra_tenant_id = \$2/);

  // Remover do TEMA continua só desvinculando (sem exceção, sem sair da reunião).
  const update = fonte("../meetings/update.ts");
  const doTema = update.slice(update.indexOf("export async function removeAgendaItemParticipant("), update.indexOf("export function parseAgendaItemParticipantInput("));
  assert.ok(!/registrarExclusao|excluirMeetingParticipant/.test(doTema));
});
