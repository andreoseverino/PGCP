import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { consultaDaExportacao, validarExportacao } from "./calendar-export-rules";
import { buildNewMeetingPayload, type NewMeetingForm } from "./new-meeting";

test("exportação: todo o calendário x período; órgão do contexto; só parâmetros aceitos", () => {
  assert.equal(consultaDaExportacao({ formato: "pdf", abrangencia: "todo", dateFrom: "2026-01-01", dateTo: "2026-12-31" }), "format=pdf");
  assert.equal(
    consultaDaExportacao({ formato: "xlsx", abrangencia: "periodo", dateFrom: "2026-01-01", dateTo: "2026-03-31", governanceBodyId: "g1" }),
    "format=xlsx&dateFrom=2026-01-01&dateTo=2026-03-31&governanceBodyId=g1"
  );
  assert.equal(consultaDaExportacao({ formato: "pdf", abrangencia: "todo", governanceBodyId: "" }), "format=pdf");
});

test("exportação: período exige as duas datas, em ordem", () => {
  assert.equal(validarExportacao({ formato: "pdf", abrangencia: "todo" }, "pt"), null);
  assert.match(validarExportacao({ formato: "pdf", abrangencia: "periodo", dateFrom: "2026-01-01" }, "pt")!, /data inicial e a final/);
  assert.match(validarExportacao({ formato: "pdf", abrangencia: "periodo", dateFrom: "2026-02-01", dateTo: "2026-01-01" }, "pt")!, /não pode ser depois/);
});

const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Exportar e relatórios: menu único no cabeçalho global; comitê inicial = contexto global", () => {
  const menu = codigo("../components/ExportMenu.tsx");
  assert.match(menu, /<CalendarExportModal[\s\S]*?governanceBodyId=\{orgaoContexto\}/);
  const modal = codigo("../components/CalendarExportModal.tsx");
  assert.match(modal, /"Todo o calendário"/);
  assert.match(modal, /"Intervalo de datas"/);
  // Só PDF na tela; comitê escolhível no próprio modal.
  assert.ok(!modal.includes("Excel"));
  assert.match(modal, /id="expComite"/);
  assert.match(modal, /"Todos os comitês"/);
  // Dois itens: calendário (lista) e cronograma (grade anual, PDF).
  assert.match(menu, /"Exportar Agenda Anual"/);
  assert.match(menu, /"Exportar cronograma"/);
  assert.match(menu, /<CronogramaExportModal[\s\S]*?governanceBodyId=\{orgaoContexto\}[\s\S]*?ano=\{ano\}/);
  // No cabeçalho (desktop, ao lado da busca) e na barra do celular; não mais no Calendário.
  const app = codigo("../App.tsx");
  assert.equal(app.match(/<ExportMenu /g)?.length, 2);
  assert.ok(!/Exportar (calendário|cronograma)|ExportModal/.test(codigo("../components/CalendarView.tsx")));
  const cronograma = codigo("../components/CronogramaExportModal.tsx");
  assert.match(cronograma, /<ModalShell/);
  assert.match(codigo("./calendar-export.ts"), /\/meetings\/export\/schedule\?/);
});

const form: NewMeetingForm = {
  sessionType: "ordinary",
  date: "2026-10-20",
  startTime: "09:00",
  endTime: "11:00",
  timezone: "America/Sao_Paulo",
  governanceBodyId: "g1",
  modality: "online",
  physicalLocationId: "",
  participants: []
};

test("nova reunião: descrição saneada vai no POST; vazia não vai", () => {
  assert.equal(buildNewMeetingPayload({ ...form, description: '<p onclick="x"><b>Oi</b></p><script>1</script>' }).description, "<p><strong>Oi</strong></p>");
  // Sem texto: nada vai no corpo (undefined some do JSON).
  assert.equal(JSON.parse(JSON.stringify(buildNewMeetingPayload({ ...form, description: "<p><br></p>" }))).description, undefined);
  assert.equal(JSON.parse(JSON.stringify(buildNewMeetingPayload(form))).description, undefined);
  const modal = codigo("../components/NewMeetingModal.tsx");
  assert.match(modal, /montarDescricaoInicial\(/);
  assert.match(modal, /if \(!descricaoEditada\) setDescription\(template\);/);
  assert.match(modal, /<RichTextEditor/);
});

test("detalhe da reunião: botão Exportar gera o dossiê (PDF) pela API", () => {
  const detalhe = codigo("../components/MeetingDetailView.tsx");
  assert.match(detalhe, /onClick=\{\(\) => void exportarDossie\(\)\}/);
  assert.match(detalhe, /await exportarDossieDaReuniao\(meeting\.id\)/);
  assert.match(codigo("./calendar-export.ts"), /\/meetings\/\$\{meetingId\}\/export\/pdf/);
});
