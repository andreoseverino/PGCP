import { Meeting } from "../types";

/**
 * Busca de reuniões por palavra-chave — usada tanto pela barra flutuante do
 * topo (App.tsx) quanto pela aba "Busca Rápida" (QuickSearchView), para as
 * duas nunca divergirem sobre o que "bate" com a busca.
 */
export function searchMeetings(meetings: Meeting[], query: string): Meeting[] {
  const termo = query.trim().toLowerCase();
  if (!termo) return [];

  return meetings.filter(
    (m) =>
      m.title.toLowerCase().includes(termo) ||
      m.description.toLowerCase().includes(termo) ||
      m.organizer.toLowerCase().includes(termo) ||
      m.agenda?.some(
        (a) => a.title.toLowerCase().includes(termo) || a.author.toLowerCase().includes(termo)
      )
  );
}
