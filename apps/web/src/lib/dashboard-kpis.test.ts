import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ActionItem, GovernanceBody, Meeting } from "../types";
import { acaoAberta, ataPendente, calcularResumoOperacional, fupVencido, reuniaoNaSemana, somarDias } from "./dashboard-kpis";

const HOJE = "2026-10-01";
const orgao = (id: string, isActive = true) => ({ id, name: id, isActive }) as GovernanceBody;
const reuniao = (id: string, extra: Partial<Meeting>) =>
  ({ id, title: id, date: HOJE, startTime: "10:00", status: "Scheduled", agendaItemsCount: 0, ...extra }) as Meeting;
const fup = (id: string, extra: Partial<ActionItem>) =>
  ({ id, title: id, origin: "", daysLate: 0, status: "Due Today", apiStatus: "open", assignedUser: { name: "", initials: "" }, ...extra }) as ActionItem;

test("reuniões da semana: próximos 7 dias e ainda não realizadas", () => {
  assert.equal(somarDias("2026-12-28", 7), "2027-01-04");
  const r = (date: string, status: Meeting["status"] = "Scheduled") => reuniao("x", { date, status });
  // Futura e hoje ainda pendente contam (agendada, em andamento, legados abertos).
  assert.equal(reuniaoNaSemana(r("2026-10-07"), HOJE), true, "futura (hoje+6)");
  assert.equal(reuniaoNaSemana(r(HOJE), HOJE), true, "hoje, agendada");
  assert.equal(reuniaoNaSemana(r(HOJE, "In Progress"), HOJE), true, "hoje, em andamento");
  assert.equal(reuniaoNaSemana(r("2026-10-03", "Draft"), HOJE), true);
  assert.equal(reuniaoNaSemana(r("2026-10-03", "Needs Approval"), HOJE), true);
  // Realizada/encerrada hoje não conta (não há status de cancelamento no modelo).
  for (const status of ["Done", "Approved", "Closed"] as const) {
    assert.equal(reuniaoNaSemana(r(HOJE, status), HOJE), false, status);
  }
  // Fora da janela.
  assert.equal(reuniaoNaSemana(r("2026-10-08"), HOJE), false, "hoje+7");
  assert.equal(reuniaoNaSemana(r("2026-09-30"), HOJE), false, "ontem");
});

test("atas pendentes: só reunião realizada com Ata não aprovada/encerrada", () => {
  assert.equal(ataPendente(reuniao("a", { status: "Done", minutesStatus: null })), true);
  assert.equal(ataPendente(reuniao("b", { status: "Done", minutesStatus: "draft" })), true);
  assert.equal(ataPendente(reuniao("c", { status: "Done", minutesStatus: "under_review" })), true);
  assert.equal(ataPendente(reuniao("d", { status: "Done", minutesStatus: "approved" })), false);
  assert.equal(ataPendente(reuniao("e", { status: "Done", minutesStatus: "closed" })), false);
  assert.equal(ataPendente(reuniao("f", { status: "Scheduled", minutesStatus: "draft" })), false, "não realizada");
  assert.equal(ataPendente(reuniao("g", { status: "In Progress", minutesStatus: null })), false, "em andamento");
});

test("FUP: vencido = aberto + prazo vencido; concluído, cancelado e futuro não contam", () => {
  assert.equal(fupVencido(fup("v", { dueDate: "2026-09-20", daysLate: 11 })), true);
  assert.equal(fupVencido(fup("c", { dueDate: "2026-09-20", daysLate: 11, apiStatus: "completed", status: "Completed" })), false);
  assert.equal(fupVencido(fup("x", { dueDate: "2026-09-20", daysLate: 11, apiStatus: "cancelled" })), false);
  assert.equal(fupVencido(fup("f", { dueDate: "2026-10-10", daysLate: -9 })), false);
  assert.equal(fupVencido(fup("h", { dueDate: HOJE, daysLate: 0 })), false, "vence hoje não está vencido");
  assert.equal(fupVencido(fup("s", { daysLate: 0 })), false, "sem prazo");
  assert.equal(acaoAberta(fup("o", {})), true);
  assert.equal(acaoAberta(fup("k", { apiStatus: "completed" })), false);
});

const base = {
  hoje: HOJE,
  governanceBodies: [orgao("exec"), orgao("aud"), orgao("antigo", false)],
  meetings: [
    reuniao("m1", { governanceBodyId: "exec", date: "2026-10-03" }),
    reuniao("m2", { governanceBodyId: "aud", date: "2026-10-20" }),
    reuniao("m3", { governanceBodyId: "exec", status: "Done", date: "2026-09-10", minutesStatus: "draft" }),
    reuniao("m4", { governanceBodyId: "aud", status: "Done", date: "2026-09-12", minutesStatus: "approved" }),
    reuniao("m5", { governanceBodyId: "aud", date: "2026-10-02", agendaValidation: { status: "sent" } as Meeting["agendaValidation"] })
  ],
  actionItems: [
    fup("a1", { originMeetingId: "m3", dueDate: "2026-09-20", daysLate: 11 }),
    fup("a2", { originMeetingId: "m4", dueDate: "2026-10-15", daysLate: -14 }),
    fup("a3", { dueDate: "2026-09-01", daysLate: 30 }),
    fup("a4", { originMeetingId: "m3", apiStatus: "completed", status: "Completed", dueDate: "2026-09-01", daysLate: 30 })
  ]
};

test("contexto Todos: números gerais", () => {
  assert.deepEqual(calcularResumoOperacional({ ...base, orgaoContexto: "" }), {
    orgaos: 2, // só ativos
    aprovacoes: 1, // m5 (pautas enviadas à validação opcional); Agenda Anual não conta mais
    fupVencidos: 2, // a1 + a3 (a4 concluído não conta)
    reunioesSemana: 2, // m1, m5
    atasPendentes: 1, // m3
    acoesPendentes: 3 // a1, a2, a3
  });
});

test("contexto de um órgão: só o que tem vínculo com ele (FUP via reunião de origem)", () => {
  assert.deepEqual(calcularResumoOperacional({ ...base, orgaoContexto: "exec" }), {
    orgaos: 1,
    aprovacoes: 0,
    fupVencidos: 1, // a1 (a3 não tem reunião de origem → sem órgão)
    reunioesSemana: 1,
    atasPendentes: 1,
    acoesPendentes: 1
  });
  const aud = calcularResumoOperacional({ ...base, orgaoContexto: "aud" });
  assert.deepEqual([aud.aprovacoes, aud.fupVencidos, aud.reunioesSemana, aud.atasPendentes, aud.acoesPendentes], [1, 0, 1, 0, 1]);
});


const codigo = (arq: string) =>
  readFileSync(new URL(arq, import.meta.url), "utf8")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

test("Visão Geral: 6 cards numa única linha rolável, sem percentual inventado", () => {
  const tela = codigo("../components/DashboardView.tsx");
  assert.ok(!/\+12%|TrendingUp/.test(tela));
  assert.match(tela, /flex flex-nowrap gap-3 overflow-x-auto/);
  const ini = tela.indexOf('aria-labelledby="resumo-operacional-titulo"');
  const secao = tela.slice(ini, tela.indexOf("</section>", ini));
  assert.ok(!/flex-wrap(?!:)|grid-cols-2|grid-cols-3/.test(secao), "sem quebra de linha");
  for (const id of ["orgaos", "aprovacoes", "fup-vencidos", "reunioes-semana", "atas", "acoes"]) {
    assert.ok(tela.includes(`id: "${id}"`), id);
  }
  // Carregando não mostra 0.
  assert.match(tela, /carregando \? null/);
  // FUP vencidos e Ações pendentes: informativos (página de FUP sem filtro de entrada).
  for (const id of ["fup-vencidos", "acoes"]) {
    const ini = tela.indexOf(`id: "${id}"`);
    const bloco = tela.slice(ini, tela.indexOf("}", ini));
    assert.ok(!/onClick/.test(bloco), `${id} não navega`);
  }
  assert.ok(!/onViewAllActionItems(?!\()/.test(tela.slice(tela.indexOf("const cardsResumo"), tela.indexOf("return (", tela.indexOf("const cardsResumo")))));
});
