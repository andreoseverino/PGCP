/**
 * SNAPSHOT da Agenda Anual — o conteúdo exatamente como foi enviado ao
 * aprovador (028). Puro: monta e compara, sem banco.
 *
 * Reunião -> Pauta -> Tema, das MESMAS entidades da reunião
 * (`meetings`, `meeting_agendas`, `meeting_agenda_items`): o snapshot é uma
 * fotografia delas, nunca uma estrutura paralela editável.
 *
 * `formato` versiona o JSON: leitores futuros sabem como interpretar versões
 * antigas sem migrar dados aprovados.
 */

import { cronogramaDosTemas } from "../meetings/schedule.js";
import { horaLocal } from "../meetings/title.js";

export const FORMATO_DO_SNAPSHOT = 1;

export interface TemaNoSnapshot {
  id: string;
  title: string;
  /*
   * Cronograma enviado (campos opcionais: snapshots anteriores não os têm).
   * Ordem = posição global na reunião; horários calculados por
   * `meetings/schedule.ts` a partir do início da reunião.
   */
  durationMinutes?: number | null;
  inicio?: string;
  fim?: string | null;
  participantes?: string[];
  /** Ficha do tema no envio (opcional: snapshots anteriores não a têm). */
  responsavel?: string | null;
  tipo?: string | null;
  natureza?: string | null;
  circular?: boolean;
  descricao?: string | null;
  /**
   * Participantes com e-mail e e-mail do responsável, como estavam no envio
   * (opcionais: snapshots anteriores só têm `participantes`, os nomes). O
   * documento aprovado sai SÓ daqui — nada é buscado depois (nem no Graph).
   */
  pessoas?: PessoaNoSnapshot[];
  responsavelEmail?: string | null;
}

export interface PessoaNoSnapshot {
  nome: string;
  email: string | null;
}

export interface PautaNoSnapshot {
  id: string;
  title: string;
  temas: TemaNoSnapshot[];
}

export interface ReuniaoNoSnapshot {
  /** `null` = data planejada ainda sem reunião (legado da reserva). */
  meetingId: string | null;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  /** Opcional: snapshots anteriores (antes do Calendário congelar) não têm. */
  modality?: "online" | "in_person";
  pautas: PautaNoSnapshot[];
  /** Temas sem pauta (itens anteriores a 025). */
  temasSemPauta: TemaNoSnapshot[];
}

export interface SnapshotDaAgenda {
  formato: typeof FORMATO_DO_SNAPSHOT;
  agenda: {
    id: string;
    title: string;
    year: number;
    governanceBody: { id: string; name: string };
  };
  geradoEm: string;
  reunioes: ReuniaoNoSnapshot[];
}

// --- Entrada (linhas do banco, já no formato da aplicação) --------------------

export interface ReuniaoDaAgenda {
  id: string;
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
  modality?: "online" | "in_person";
}

export interface PautaDaReuniao {
  id: string;
  meetingId: string;
  title: string;
  position: number;
}

export interface TemaDaReuniao {
  id: string;
  meetingId: string;
  /** `meeting_agenda_id`; `null` = tema sem pauta. */
  agendaId: string | null;
  title: string;
  position: number;
  durationMinutes?: number | null;
  /** Nomes dos participantes vinculados AO TEMA (não à reunião). */
  participantes?: string[];
  responsavel?: string | null;
  tipo?: string | null;
  natureza?: string | null;
  circular?: boolean;
  descricao?: string | null;
  pessoas?: PessoaNoSnapshot[];
  responsavelEmail?: string | null;
}

export interface DataPlanejadaSemReuniao {
  title: string;
  startAt: string;
  endAt: string;
  timezone: string;
}

const porPosicao = <T extends { position: number; id: string }>(a: T, b: T) =>
  a.position - b.position || a.id.localeCompare(b.id);

/** Monta a fotografia. Ordem: reuniões por início; pautas e temas por posição. */
export function montarSnapshot(dados: {
  agenda: SnapshotDaAgenda["agenda"];
  reunioes: readonly ReuniaoDaAgenda[];
  pautas: readonly PautaDaReuniao[];
  temas: readonly TemaDaReuniao[];
  datasSemReuniao?: readonly DataPlanejadaSemReuniao[];
  agora?: Date;
}): SnapshotDaAgenda {
  const reunioes: ReuniaoNoSnapshot[] = dados.reunioes.map((r) => {
    const pautasDaReuniao = dados.pautas.filter((p) => p.meetingId === r.id).sort(porPosicao);
    const idsDasPautas = new Set(pautasDaReuniao.map((p) => p.id));
    const temasDaReuniao = dados.temas.filter((t) => t.meetingId === r.id).sort(porPosicao);
    // Horários na ordem GLOBAL da reunião (a mesma do Pipeline).
    const horarios = new Map(
      cronogramaDosTemas(
        horaLocal(r.startAt, r.timezone),
        temasDaReuniao.map((t) => ({ id: t.id, durationMinutes: t.durationMinutes ?? null })),
      ).map((h) => [h.id, h]),
    );
    const tema = (t: TemaDaReuniao): TemaNoSnapshot => ({
      id: t.id,
      title: t.title,
      durationMinutes: t.durationMinutes ?? null,
      inicio: horarios.get(t.id)!.inicio,
      fim: horarios.get(t.id)!.fim,
      participantes: t.participantes ?? [],
      ...(t.responsavel !== undefined ? { responsavel: t.responsavel } : {}),
      ...(t.tipo !== undefined ? { tipo: t.tipo } : {}),
      ...(t.natureza !== undefined ? { natureza: t.natureza } : {}),
      ...(t.circular !== undefined ? { circular: t.circular } : {}),
      ...(t.descricao !== undefined ? { descricao: t.descricao } : {}),
      ...(t.pessoas !== undefined ? { pessoas: t.pessoas } : {}),
      ...(t.responsavelEmail !== undefined ? { responsavelEmail: t.responsavelEmail } : {}),
    });
    return {
      meetingId: r.id,
      title: r.title,
      startAt: r.startAt,
      endAt: r.endAt,
      timezone: r.timezone,
      ...(r.modality !== undefined ? { modality: r.modality } : {}),
      pautas: pautasDaReuniao.map((p) => ({
        id: p.id,
        title: p.title,
        temas: temasDaReuniao.filter((t) => t.agendaId === p.id).map(tema),
      })),
      temasSemPauta: temasDaReuniao
        .filter((t) => !t.agendaId || !idsDasPautas.has(t.agendaId))
        .map(tema),
    };
  });

  for (const d of dados.datasSemReuniao ?? []) {
    reunioes.push({ meetingId: null, ...d, pautas: [], temasSemPauta: [] });
  }

  reunioes.sort((a, b) => a.startAt.localeCompare(b.startAt) || (a.meetingId ?? "").localeCompare(b.meetingId ?? ""));

  return {
    formato: FORMATO_DO_SNAPSHOT,
    agenda: dados.agenda,
    geradoEm: (dados.agora ?? new Date()).toISOString(),
    reunioes,
  };
}

/** Totais do conteúdo (resumo da tela e do PDF). */
export function totaisDoSnapshot(s: Pick<SnapshotDaAgenda, "reunioes">): { reunioes: number; pautas: number; temas: number } {
  let pautas = 0;
  let temas = 0;
  for (const r of s.reunioes) {
    pautas += r.pautas.length;
    temas += r.temasSemPauta.length + r.pautas.reduce((n, p) => n + p.temas.length, 0);
  }
  return { reunioes: s.reunioes.length, pautas, temas };
}

/** Lê um snapshot persistido. Formato desconhecido: erro explícito, nunca adivinhar. */
export function lerSnapshot(valor: unknown): SnapshotDaAgenda {
  const s = valor as Partial<SnapshotDaAgenda> | null;
  if (!s || s.formato !== FORMATO_DO_SNAPSHOT || !Array.isArray(s.reunioes) || !s.agenda) {
    throw new Error("Formato de snapshot da Agenda Anual não reconhecido.");
  }
  return s as SnapshotDaAgenda;
}
