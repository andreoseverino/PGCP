import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Meeting } from "../types";
import { formularioDaReuniao, montarPatchDaEdicao } from "./edit-meeting";
import { localToInstant } from "./meeting-adapters";

const reuniao = {
  id: "m1",
  title: "09:00 | Cielo | Reunião Ordinária do Comitê (ONLINE)",
  sessionType: "ordinary",
  description: "<p>Objetivo</p>",
  date: "2026-10-20",
  startTime: "09:00",
  endTime: "11:00",
  timeZone: "America/Sao_Paulo",
  governanceBodyId: "g1",
  recurrence: "Single",
  modality: "online",
  physicalLocation: null,
  category: "Comitê"
} as unknown as Meeting;

test("abrir e salvar sem mudar nada: PATCH vazio (nenhuma chamada, nenhuma versão)", () => {
  assert.deepEqual(montarPatchDaEdicao(reuniao, formularioDaReuniao(reuniao)), {});
  // Descrição equivalente (mesmo HTML saneado) também não é mudança.
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...formularioDaReuniao(reuniao), description: "<P>Objetivo</P>" }), {});
});

test("só os campos alterados vão ao servidor", () => {
  const f = formularioDaReuniao(reuniao);
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, startTime: "10:00" }), {
    startAt: localToInstant("2026-10-20", "10:00", "America/Sao_Paulo")
  });
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, description: "<p><strong>Novo</strong></p><script>x</script>" }), {
    description: "<p><strong>Novo</strong></p>"
  });
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, description: "" }), { description: null });
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, modality: "in_person", physicalLocationId: "sede" }), {
    modality: "in_person",
    physicalLocationId: "sede"
  });
  // Com tipo, o título é do servidor: nunca vai `title`.
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, sessionType: "extraordinary", title: "forjado" }), { sessionType: "extraordinary" });
  // Legado sem tipo: título livre.
  const legado = { ...reuniao, sessionType: null } as unknown as Meeting;
  assert.deepEqual(montarPatchDaEdicao(legado, { ...formularioDaReuniao(legado), title: "  Novo título " }), { title: "Novo título" });
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("UMA implementação de edição: Pipeline e Calendário usam o mesmo EditMeetingModal", () => {
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  const app = codigo("../App.tsx");
  assert.match(detalhe, /<EditMeetingModal/);
  assert.match(app, /<EditMeetingModal/);
  assert.ok(!/editedDescription|setEditedTitle|apiUpdateMeeting\(meeting\.id/.test(detalhe), "sem o formulário antigo");
  const modal = codigo("../components/EditMeetingModal.tsx");
  assert.match(modal, /montarPatchDaEdicao\(meeting, form\)/);
  assert.match(modal, /updateMeeting\(meeting\.id, patch\)/);
  assert.match(modal, /<RichTextEditor/);
});

test("Calendário: editar só com permissão de agendar (cortesia; o servidor exige a App Role)", () => {
  const cal = codigo("../components/CalendarView.tsx");
  assert.match(cal, /\{canSchedule && onEditMeeting && \(/);
  assert.match(cal, /onClick=\{\(\) => onEditMeeting\(m\)\}/);
  const app = codigo("../App.tsx");
  assert.match(app, /onEditMeeting=\{\(m\) => void editarPeloCalendario\(m\)\}/);
  assert.match(app, /setMeetingEmEdicao\(meetingFromApi\(await getMeeting\(meet\.id\)\)\)/);
  assert.match(app, /canSchedule=\{usuarioPodeAgendar\}\s*onNewMeeting/);
});

test("exibição da descrição sempre saneada (sem HTML cru da API)", () => {
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  assert.match(detalhe, /<RichTextView html=\{meeting\.description\}/);
  const editor = codigo("../components/RichTextEditor.tsx");
  // Único dangerouslySetInnerHTML: o do RichTextView, com o HTML saneado.
  assert.equal((editor.match(/dangerouslySetInnerHTML/g) ?? []).length, 1);
  assert.match(editor, /const seguro = descricaoComoHtml\(html\);/);
  assert.match(editor, /dangerouslySetInnerHTML=\{\{ __html: seguro \}\}/);
});

// --- Participantes na edição (lista completa, uma operação) -------------------

const comParticipantes = {
  ...reuniao,
  participants: [
    { participantId: "p1", name: "Ana", role: "Membro", initials: "A", confirmed: false, entraObjectId: "oid-ana", email: "ana@cielo.example" },
    { participantId: "p2", name: "Externa", role: "Convidada", initials: "E", confirmed: false, email: "ext@parceiro.example" }
  ]
} as unknown as Meeting;

test("participantes: mesma lista não gera PATCH; reunião sem lista carregada não envia participantes", () => {
  assert.deepEqual(montarPatchDaEdicao(comParticipantes, formularioDaReuniao(comParticipantes)), {});
  const f = formularioDaReuniao(reuniao);
  assert.equal(f.participants, null);
  assert.deepEqual(montarPatchDaEdicao(reuniao, { ...f, description: "<p>x</p>" }), { description: "<p>x</p>" });
});

test("participantes: adicionar, remover e editar descrição vão JUNTOS num PATCH só", () => {
  const f = formularioDaReuniao(comParticipantes);
  const patch = montarPatchDaEdicao(comParticipantes, {
    ...f,
    description: "<p>Nova</p>",
    participants: [
      f.participants![0]!,
      { name: "Nova Externa", role: "Convidada", confirmed: false, email: "nova@parceiro.example" },
      { name: "Bruno", role: "Membro", confirmed: false, entraObjectId: "oid-bruno", email: "bruno@cielo.example" }
    ]
  });
  assert.equal(patch.description, "<p>Nova</p>");
  assert.deepEqual(patch.participants![0], { id: "p1" });
  assert.equal((patch.participants![1] as { participantType?: string }).participantType, "external");
  assert.equal((patch.participants![2] as { entraObjectId?: string }).entraObjectId, "oid-bruno");
  assert.equal(patch.participants!.length, 3, "p2 fora da lista = removida");
  // Só remover também é mudança.
  assert.deepEqual(montarPatchDaEdicao(comParticipantes, { ...f, participants: [f.participants![1]!] }).participants, [{ id: "p2" }]);
});

test("modal de edição usa o MESMO componente de participantes do agendamento; organizador segue fixo", () => {
  const modal = readFileSync(new URL("../components/EditMeetingModal.tsx", import.meta.url), "utf8");
  assert.match(modal, /<ParticipantsField/);
  assert.ok(!/DirectoryUserPicker|onOrganizerChange/.test(modal), "organizador não é editável");
  const campos = readFileSync(new URL("../components/MeetingInviteFields.tsx", import.meta.url), "utf8");
  assert.equal((campos.match(/<ParticipantPicker/g) ?? []).length, 1, "um só bloco de participantes");
  assert.match(campos, /export function ParticipantsField\(/);
  const novo = readFileSync(new URL("../components/NewMeetingModal.tsx", import.meta.url), "utf8");
  assert.match(novo, /<ParticipantsField/, "Nova reunião usa o mesmo bloco");
});

test("edição: formato na coluna esquerda (antes da descrição); organizador fixo no topo da direita", () => {
  const modal = readFileSync(new URL("../components/EditMeetingModal.tsx", import.meta.url), "utf8");
  const iModalidade = modal.indexOf("<ModalityFields");
  const iDescricao = modal.indexOf('ariaLabel={en ? "Meeting description"');
  const iOrganizador = modal.indexOf('id="editOrganizer"');
  const iParticipantes = modal.indexOf("<ParticipantsField");
  assert.ok(iModalidade > 0 && iModalidade < iDescricao && iDescricao < iOrganizador && iOrganizador < iParticipantes);
  assert.match(modal, /id="editOrganizer"[\s\S]{0,200}readOnly/, "organizador continua só leitura");
});

test("modal de edição não mostra recorrência; o valor gravado não é enviado nem alterado", () => {
  const modal = readFileSync(new URL("../components/EditMeetingModal.tsx", import.meta.url), "utf8");
  assert.ok(!/editRecurrence|alterar\("recurrence"/.test(modal));
  assert.equal("recurrence" in montarPatchDaEdicao(reuniao, formularioDaReuniao(reuniao)), false);
});
