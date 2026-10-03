import React, { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { describeDirectoryError, searchDirectoryUsers, type DirectoryUser } from "../lib/directory";
import { enderecoDoDiretorio } from "../lib/corporate-email";
import {
  listDirectoryPeople,
  listExternalParticipants,
  type DirectoryPerson,
  type ExternalParticipant
} from "../lib/external-participants";
import {
  combinarResultados,
  deveBuscarNoEntra,
  ENTRA_MIN_QUERY,
  nomeDoSugerido,
  rotuloClassificacao,
  sugeridoParaSelecionado,
  sugerirParticipantes,
  type ContextoSugestao,
  type ParticipanteSelecionado,
  type Sugerido
} from "../lib/participant-search";

/**
 * Seleção de PARTICIPANTE de reunião: Microsoft Entra ID + externos do PGCP.
 *
 * Único componente que junta as duas origens (regras em
 * `lib/participant-search.ts`). Externos são filtrados localmente desde a
 * primeira letra; o Entra só é consultado a partir de 3 letras, com debounce
 * — nada do diretório é baixado inteiro nem copiado.
 *
 * Só para PARTICIPAR. Responsável, organizador e demais funções que exigem
 * identidade corporativa continuam no `DirectoryUserPicker`.
 *
 * SUGESTÕES (027): ao focar sem digitar, mostra quem está classificado no
 * órgão (e no tema) do contexto. Só sugere — nada entra sem clique — e a busca
 * geral continua valendo para qualquer pessoa.
 */

interface ParticipantPickerProps {
  language: "en" | "pt";
  onSelect: (s: ParticipanteSelecionado) => void;
  /** Já escolhidos — não são oferecidos de novo. */
  jaEscolhidos?: { entraIds?: string[]; emails?: string[] };
  placeholder?: string;
  /** Mostra a orientação sobre as duas origens (usar no seletor principal). */
  showHint?: boolean;
  disabled?: boolean;
  /** Órgão/tema para priorizar sugestões, com rótulos para o título do grupo. */
  sugestao?: ContextoSugestao & { rotuloOrgao?: string; rotuloTema?: string };
}

const DEBOUNCE_MS = 400;

export default function ParticipantPicker({
  language,
  onSelect,
  jaEscolhidos,
  placeholder,
  showHint = false,
  disabled = false,
  sugestao
}: ParticipantPickerProps) {
  const pt = language === "pt";
  const [termo, setTermo] = useState("");
  const [aberto, setAberto] = useState(false);
  const [locais, setLocais] = useState<ExternalParticipant[]>([]);
  const [classificados, setClassificados] = useState<DirectoryPerson[]>([]);
  const [entra, setEntra] = useState<DirectoryUser[]>([]);
  const [buscandoEntra, setBuscandoEntra] = useState(false);
  const [erroEntra, setErroEntra] = useState<string | null>(null);
  const caixa = useRef<HTMLDivElement>(null);

  // Externos: uma leitura por abertura da tela. Sem permissão (403): lista vazia.
  useEffect(() => {
    const c = new AbortController();
    listExternalParticipants(undefined, c.signal).then(setLocais).catch(() => setLocais([]));
    // Só as pessoas do diretório JÁ classificadas (nunca o tenant).
    listDirectoryPeople(c.signal).then(setClassificados).catch(() => setClassificados([]));
    return () => c.abort();
  }, []);

  useEffect(() => {
    setErroEntra(null);
    if (!deveBuscarNoEntra(termo)) {
      setEntra([]);
      setBuscandoEntra(false);
      return;
    }
    const c = new AbortController();
    setBuscandoEntra(true);
    const t = setTimeout(() => {
      searchDirectoryUsers(termo, c.signal)
        .then((r) => setEntra(r.users))
        .catch((e) => {
          if ((e as Error).name === "AbortError") return;
          setEntra([]);
          setErroEntra(describeDirectoryError(e, language));
        })
        .finally(() => setBuscandoEntra(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      c.abort();
    };
  }, [termo, language]);

  useEffect(() => {
    const fechar = (e: MouseEvent) => {
      if (caixa.current && !caixa.current.contains(e.target as Node)) setAberto(false);
    };
    document.addEventListener("mousedown", fechar);
    return () => document.removeEventListener("mousedown", fechar);
  }, []);

  const resultado = useMemo(
    () => combinarResultados(entra, locais, termo, jaEscolhidos),
    [entra, locais, termo, jaEscolhidos]
  );

  const sugeridos = useMemo(
    () => (sugestao ? sugerirParticipantes(locais, classificados, sugestao, jaEscolhidos) : { orgaoETema: [], orgao: [] }),
    [locais, classificados, sugestao, jaEscolhidos]
  );
  const classificacaoEntra = useMemo(
    () => new Map(classificados.map((p) => [p.entraObjectId.toLowerCase(), p])),
    [classificados]
  );

  const escolher = (s: ParticipanteSelecionado) => {
    onSelect(s);
    setTermo("");
    setAberto(false);
  };

  const semNada = resultado.entra.length === 0 && resultado.pgcp.length === 0;
  const grupo = (titulo: string) => (
    <p className="px-3 pt-2 pb-1 text-[9.5px] font-extrabold uppercase tracking-wider text-slate-400">{titulo}</p>
  );

  return (
    <div ref={caixa} className="relative">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
        <input
          type="text"
          value={termo}
          disabled={disabled}
          onChange={(e) => {
            setTermo(e.target.value);
            setAberto(true);
          }}
          onFocus={() => setAberto(true)}
          placeholder={placeholder ?? (pt ? "Pesquisar participante..." : "Search participant...")}
          aria-label={pt ? "Pesquisar participante" : "Search participant"}
          className="w-full pl-9 pr-8 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none focus:ring-1 focus:ring-[#00658d] disabled:opacity-50"
        />
        {buscandoEntra && <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 animate-spin" />}
      </div>

      {showHint && (
        <p className="mt-1 text-[10px] text-slate-400 font-semibold">
          {pt
            ? "A busca inclui pessoas do Microsoft Entra ID e participantes externos cadastrados no PGCP."
            : "Search includes Microsoft Entra ID people and external participants registered in PGCP."}
        </p>
      )}

      {aberto && !termo.trim() && (sugeridos.orgaoETema.length > 0 || sugeridos.orgao.length > 0) && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-72 overflow-y-auto">
          {([
            [
              sugeridos.orgaoETema,
              sugestao?.governanceBodyId
                ? `${pt ? "Sugeridos para" : "Suggested for"} ${sugestao?.rotuloOrgao ?? ""} ${pt ? "e" : "and"} ${sugestao?.rotuloTema ?? ""}`
                : `${pt ? "Sugeridos para" : "Suggested for"} ${sugestao?.rotuloTema ?? ""}`
            ],
            [sugeridos.orgao, `${pt ? "Sugeridos para" : "Suggested for"} ${sugestao?.rotuloOrgao ?? ""}`]
          ] as Array<[Sugerido[], string]>).map(([lista, titulo]) =>
            lista.length === 0 ? null : (
              <div key={titulo}>
                {grupo(titulo)}
                {lista.map((s) => {
                  const c = s.origem === "entra" ? s.pessoa : s.participante;
                  return (
                    <button key={`${s.origem}:${c.id}`} type="button" onClick={() => escolher(sugeridoParaSelecionado(s))}
                      className="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                      <span className="block text-[12px] font-bold text-slate-800">{nomeDoSugerido(s)}</span>
                      <span className="block text-[10px] text-slate-500">
                        {s.origem === "entra" ? "Microsoft Entra ID" : pt ? "PGCP / Externo" : "PGCP / External"}
                        {rotuloClassificacao(c) ? ` · ${rotuloClassificacao(c)}` : ""}
                      </span>
                    </button>
                  );
                })}
              </div>
            )
          )}
          <p className="px-3 py-2 text-[10px] text-slate-400 font-semibold">
            {pt ? "Digite para buscar outras pessoas (Entra ID e externos)." : "Type to search other people."}
          </p>
        </div>
      )}

      {aberto && termo.trim() && (
        <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-72 overflow-y-auto">
          {resultado.entra.length > 0 && (
            <>
              {grupo("Microsoft Entra ID")}
              {resultado.entra.map((u) => (
                <button key={`ms:${u.id}`} type="button" onClick={() => escolher({ origem: "entra", user: u })}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                  <span className="block text-[12px] font-bold text-slate-800">{u.displayName ?? enderecoDoDiretorio(u)}</span>
                  <span className="block text-[10px] text-slate-500">
                    {enderecoDoDiretorio(u) ?? "—"}
                    {classificacaoEntra.get(u.id.toLowerCase()) && rotuloClassificacao(classificacaoEntra.get(u.id.toLowerCase())!)
                      ? ` · ${rotuloClassificacao(classificacaoEntra.get(u.id.toLowerCase())!)}`
                      : ""}
                  </span>
                </button>
              ))}
            </>
          )}
          {resultado.pgcp.length > 0 && (
            <>
              {grupo(pt ? "PGCP / Externo" : "PGCP / External")}
              {resultado.pgcp.map((p) => (
                <button key={`pgcp:${p.id}`} type="button" onClick={() => escolher({ origem: "pgcp", participante: p })}
                  className="w-full text-left px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
                  <span className="block text-[12px] font-bold text-slate-800">{p.fullName}</span>
                  <span className="block text-[10px] text-slate-500">
                    {p.email}{rotuloClassificacao(p) ? ` · ${rotuloClassificacao(p)}` : ""}
                  </span>
                </button>
              ))}
            </>
          )}
          {!deveBuscarNoEntra(termo) && (
            <p className="px-3 py-2 text-[10px] text-slate-400 font-semibold">
              {pt
                ? `Digite ${ENTRA_MIN_QUERY} letras ou mais para buscar também no Microsoft Entra ID.`
                : `Type ${ENTRA_MIN_QUERY}+ letters to also search Microsoft Entra ID.`}
            </p>
          )}
          {erroEntra && <p className="px-3 py-2 text-[10px] text-amber-600 font-semibold">{erroEntra}</p>}
          {semNada && deveBuscarNoEntra(termo) && !buscandoEntra && !erroEntra && (
            <p className="px-3 py-2 text-[11px] text-slate-400 font-semibold">{pt ? "Ninguém encontrado." : "No one found."}</p>
          )}
        </div>
      )}
    </div>
  );
}
