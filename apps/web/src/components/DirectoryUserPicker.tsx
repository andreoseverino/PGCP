import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, Loader2, Search, X } from "lucide-react";
import {
  DIRECTORY_MIN_QUERY,
  describeDirectoryError,
  directoryEmail,
  directoryUserKind,
  searchDirectoryUsers,
  type DirectoryUser
} from "../lib/directory";

/** Espera antes de consultar. Evita uma chamada por tecla digitada. */
const DEBOUNCE_MS = 400;

interface DirectoryUserPickerProps {
  language: "en" | "pt";
  /** Pessoa escolhida. Exibida como chip, com botão de limpar. */
  selected?: DirectoryUser | null;
  /** Rótulo da escolha atual quando só existe o nome (valor legado, sem `id`). */
  selectedLabel?: string | null;
  onSelect: (user: DirectoryUser) => void;
  onClear?: () => void;
  /** Ids já escolhidos noutro lugar — aparecem marcados e não repetem. */
  alreadyChosenIds?: string[];
  placeholder?: string;
  /** Mantém a lista aberta após escolher. Útil para seleção múltipla. */
  keepOpenOnSelect?: boolean;
}

type Estado =
  | { tipo: "inicial" }
  | { tipo: "curto" }
  | { tipo: "carregando" }
  | { tipo: "resultado"; users: DirectoryUser[] }
  | { tipo: "erro"; mensagem: string };

/**
 * Seleção de pessoas a partir do diretório corporativo.
 *
 * Consome exclusivamente `searchDirectoryUsers()` — nenhum componente chama
 * `/directory/users` diretamente, e o navegador nunca fala com o Microsoft
 * Graph: quem detém o token de aplicação é a API do PGCP.
 *
 * NÃO grava nada. Devolve o objeto do diretório inteiro e deixa o consumidor
 * decidir o que persistir: quem escolhe pode precisar do `id`, do nome, ou de
 * ambos, e essa decisão não pertence ao picker.
 */
export default function DirectoryUserPicker({
  language,
  selected,
  selectedLabel,
  onSelect,
  onClear,
  alreadyChosenIds = [],
  placeholder,
  keepOpenOnSelect = false
}: DirectoryUserPickerProps) {
  const pt = language === "pt";
  const [termo, setTermo] = useState("");
  const [estado, setEstado] = useState<Estado>({ tipo: "inicial" });

  /** Consulta em andamento, para cancelar quando outra começa. */
  const emAndamento = useRef<AbortController | null>(null);

  useEffect(() => {
    const busca = termo.trim();

    if (busca.length === 0) {
      emAndamento.current?.abort();
      setEstado({ tipo: "inicial" });
      return;
    }

    if (busca.length < DIRECTORY_MIN_QUERY) {
      emAndamento.current?.abort();
      setEstado({ tipo: "curto" });
      return;
    }

    const timer = setTimeout(() => {
      /*
       * Aborta a anterior antes de abrir a próxima. É o que impede a corrida:
       * se "And" demorar mais que "Andre", a resposta de "And" chega abortada
       * e nunca sobrescreve a mais recente.
       */
      emAndamento.current?.abort();
      const controller = new AbortController();
      emAndamento.current = controller;

      setEstado({ tipo: "carregando" });

      searchDirectoryUsers(busca, controller.signal)
        .then((resposta) => {
          if (controller.signal.aborted) return;
          setEstado({ tipo: "resultado", users: resposta.users });
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted) return;
          setEstado({ tipo: "erro", mensagem: describeDirectoryError(error, language) });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [termo, language]);

  useEffect(() => () => emAndamento.current?.abort(), []);

  const escolher = (user: DirectoryUser) => {
    onSelect(user);
    if (!keepOpenOnSelect) {
      setTermo("");
      setEstado({ tipo: "inicial" });
    }
  };

  const rotuloEscolhido = selected?.displayName ?? selectedLabel ?? null;

  // Escolha feita e sem seleção múltipla: mostra o chip em vez da busca.
  if (rotuloEscolhido && !keepOpenOnSelect) {
    return (
      <div className="flex items-center gap-2 w-full bg-slate-50 border border-slate-205 rounded-xl px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-slate-800 truncate">{rotuloEscolhido}</p>
          {selected && (
            <p className="text-[10px] text-slate-400 font-semibold truncate">
              {[directoryEmail(selected), selected.jobTitle].filter(Boolean).join(" · ")}
            </p>
          )}
          {!selected && selectedLabel && (
            /* Valor legado: texto salvo antes do diretório real (pode ser uma
               área ou um coletivo, não necessariamente uma pessoa). */
            <p className="text-[10px] text-slate-400 font-semibold italic">
              {pt ? "Valor existente — não vinculado ao diretório" : "Existing value — not linked to the directory"}
            </p>
          )}
        </div>
        {onClear && (
          <button
            type="button"
            onClick={onClear}
            title={pt ? "Trocar" : "Change"}
            className="p-1 text-slate-400 hover:text-[#00658d] rounded transition cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          placeholder={placeholder ?? (pt ? "Buscar no diretório por nome ou e-mail..." : "Search directory by name or e-mail...")}
          className="w-full bg-slate-50/50 border border-slate-200/50 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#00658d]/20 focus:border-[#00658d] transition-all"
        />
      </div>

      {estado.tipo === "curto" && (
        <p className="text-[10.5px] text-slate-400 font-semibold px-1">
          {pt ? `Informe ao menos ${DIRECTORY_MIN_QUERY} caracteres.` : `Type at least ${DIRECTORY_MIN_QUERY} characters.`}
        </p>
      )}

      {estado.tipo === "carregando" && (
        <div className="flex items-center gap-2 text-slate-400 px-1 py-2">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          <span className="text-[10.5px] font-semibold">{pt ? "Consultando..." : "Searching..."}</span>
        </div>
      )}

      {estado.tipo === "erro" && (
        <div
          role="alert"
          className="flex gap-2 p-2.5 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[10.5px] font-semibold"
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span className="min-w-0">{estado.mensagem}</span>
        </div>
      )}

      {estado.tipo === "resultado" && estado.users.length === 0 && (
        <p className="text-[10.5px] text-slate-400 font-semibold italic px-1 py-2">
          {pt ? "Ninguém encontrado no diretório." : "No one found in the directory."}
        </p>
      )}

      {estado.tipo === "resultado" && estado.users.length > 0 && (
        <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
          {estado.users.map((user) => {
            const email = directoryEmail(user);
            const tipo = directoryUserKind(user, language);
            const jaEscolhido = alreadyChosenIds.includes(user.id);
            /* Conta desabilitada no diretório aparece para consulta, mas não
               pode ser escolhida: atribuir responsabilidade a quem não tem
               acesso criaria pendência sem dono. */
            const desabilitado = user.accountEnabled === false;

            return (
              <button
                key={user.id}
                type="button"
                onClick={() => escolher(user)}
                disabled={desabilitado || jaEscolhido}
                className={`w-full text-left p-2.5 rounded-xl border transition flex items-center justify-between gap-3 ${
                  desabilitado
                    ? "bg-slate-50/60 border-slate-100 opacity-70 cursor-not-allowed"
                    : jaEscolhido
                      ? "bg-[#00658d]/5 border-[#00658d]/35 cursor-default"
                      : "bg-white border-slate-200 hover:border-[#00658d] hover:bg-slate-50/60 cursor-pointer"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-xs font-extrabold text-slate-900 truncate">
                      {user.displayName ?? (pt ? "(sem nome)" : "(no name)")}
                    </span>
                    {tipo && (
                      <span className="text-[8.5px] font-extrabold uppercase tracking-wider text-slate-400">
                        {tipo}
                      </span>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-400 font-semibold truncate">
                    {[email, user.jobTitle].filter(Boolean).join(" · ") || "—"}
                  </p>
                  {desabilitado && (
                    <span className="inline-block mt-1 text-[8.5px] font-extrabold uppercase tracking-wider text-amber-700">
                      {pt ? "Desabilitado no diretório" : "Disabled in directory"}
                    </span>
                  )}
                </div>
                {jaEscolhido && <Check className="w-3.5 h-3.5 text-[#00658d] shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
