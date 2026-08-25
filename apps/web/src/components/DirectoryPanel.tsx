import React, { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Search, Users } from "lucide-react";
import {
  DIRECTORY_MIN_QUERY,
  describeDirectoryError,
  directoryEmail,
  directoryUserKind,
  searchDirectoryUsers,
  type DirectoryUser
} from "../lib/directory";
import { getInitials } from "../lib/user";

interface DirectoryPanelProps {
  language: "en" | "pt";
}

/** Espera antes de consultar. Evita uma chamada por tecla digitada. */
const DEBOUNCE_MS = 400;

type Estado =
  | { tipo: "inicial" }
  | { tipo: "curto" }
  | { tipo: "carregando" }
  | { tipo: "resultado"; users: DirectoryUser[]; truncated: boolean }
  | { tipo: "erro"; mensagem: string };

/**
 * Diretório de Usuários — consulta em TEMPO REAL ao Microsoft Graph.
 *
 * Substitui a antiga tabela local de "usuários sincronizados", que era mock:
 * agendamento decorativo, "última sincronização" fixa no código e um botão de
 * sincronizar que só exibia um alerta.
 *
 * Somente leitura. Nada é gravado — nem no PostgreSQL, nem em localStorage.
 * O único mecanismo que cria usuários no PGCP continua sendo o JIT do login.
 */
export default function DirectoryPanel({ language }: DirectoryPanelProps) {
  const pt = language === "pt";
  const [termo, setTermo] = useState("");
  const [estado, setEstado] = useState<Estado>({ tipo: "inicial" });

  /** Requisição em andamento, para cancelar quando uma nova começa. */
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
       * Cancela a consulta anterior antes de abrir a próxima. É isso que
       * impede a corrida visual: se "And" demorar mais que "Andre", a resposta
       * de "And" chega abortada e nunca sobrescreve a mais recente.
       */
      emAndamento.current?.abort();
      const controller = new AbortController();
      emAndamento.current = controller;

      setEstado({ tipo: "carregando" });

      searchDirectoryUsers(busca, controller.signal)
        .then((resposta) => {
          if (controller.signal.aborted) return;
          setEstado({ tipo: "resultado", users: resposta.users, truncated: resposta.truncated });
        })
        .catch((error: unknown) => {
          // Cancelamento é esperado: quem abortou já pediu outra busca.
          if (controller.signal.aborted) return;
          setEstado({ tipo: "erro", mensagem: describeDirectoryError(error, language) });
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [termo, language]);

  // Desmontar não pode deixar requisição pendente atualizando estado morto.
  useEffect(() => () => emAndamento.current?.abort(), []);

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-extrabold text-slate-900 flex items-center gap-2">
          <Users className="w-5 h-5 text-[#00658d]" />
          {pt ? "Diretório de Usuários" : "User Directory"}
        </h3>
        <p className="text-slate-500 font-medium text-xs mt-1 max-w-2xl leading-relaxed">
          {pt
            ? "Consulta em tempo real ao diretório corporativo via Microsoft Graph. Nenhuma cópia dos usuários é armazenada no PGCP — apenas pessoas com vínculo real no sistema ganham registro próprio."
            : "Real-time lookup against the corporate directory via Microsoft Graph. No copy of the directory is stored in PGCP."}
        </p>
      </div>

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="search"
          value={termo}
          onChange={(e) => setTermo(e.target.value)}
          placeholder={pt ? "Buscar por nome ou e-mail..." : "Search by name or e-mail..."}
          aria-label={pt ? "Buscar no diretório corporativo" : "Search the corporate directory"}
          className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-xs text-slate-800 placeholder:text-slate-400 focus:bg-white focus:outline-none focus:ring-1 focus:ring-[#00658d] focus:border-[#00658d] transition-all font-medium"
        />
      </div>

      {estado.tipo === "inicial" && (
        <p className="text-xs text-slate-400 font-semibold italic py-10 text-center">
          {pt
            ? "Pesquise por nome ou e-mail para consultar o diretório corporativo."
            : "Search by name or e-mail to query the corporate directory."}
        </p>
      )}

      {estado.tipo === "curto" && (
        <p className="text-xs text-slate-400 font-semibold italic py-10 text-center">
          {pt
            ? `Informe ao menos ${DIRECTORY_MIN_QUERY} caracteres.`
            : `Type at least ${DIRECTORY_MIN_QUERY} characters.`}
        </p>
      )}

      {estado.tipo === "carregando" && (
        <div className="py-10 flex items-center justify-center gap-2.5 text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-xs font-semibold">{pt ? "Consultando o diretório..." : "Querying directory..."}</span>
        </div>
      )}

      {estado.tipo === "erro" && (
        <div
          role="alert"
          className="flex gap-2.5 p-3.5 rounded-xl bg-red-50 border border-red-100 text-red-800 text-[11px] font-semibold"
        >
          <AlertCircle className="w-4 h-4 shrink-0 mt-px" />
          <span className="min-w-0">{estado.mensagem}</span>
        </div>
      )}

      {estado.tipo === "resultado" && estado.users.length === 0 && (
        <p className="text-xs text-slate-400 font-semibold italic py-10 text-center">
          {pt ? "Nenhuma pessoa encontrada no diretório." : "No one found in the directory."}
        </p>
      )}

      {estado.tipo === "resultado" && estado.users.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-xs font-bold text-slate-800 uppercase tracking-wide flex items-center gap-1.5">
              {pt ? "Resultados" : "Results"}
              <span className="px-2 py-0.5 rounded-full text-[10px] bg-slate-100 text-[#00658d] font-extrabold">
                {estado.users.length}
              </span>
            </h4>
            {estado.truncated && (
              <span className="text-[10px] text-slate-400 font-semibold">
                {pt ? "Muitos resultados — refine a busca." : "Too many results — refine your search."}
              </span>
            )}
          </div>

          <div className="overflow-x-auto border border-slate-100 rounded-2xl w-full">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-250 text-slate-400 font-bold uppercase tracking-wider">
                  <th className="py-2.5 px-4">{pt ? "Nome" : "Name"}</th>
                  <th className="py-2.5 px-4">{pt ? "E-mail" : "E-mail"}</th>
                  <th className="py-2.5 px-4">{pt ? "Cargo" : "Job title"}</th>
                  <th className="py-2.5 px-4">{pt ? "Tipo" : "Type"}</th>
                  <th className="py-2.5 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                {estado.users.map((u) => {
                  const email = directoryEmail(u);
                  const tipo = directoryUserKind(u, language);

                  return (
                    <tr key={u.id} className="hover:bg-slate-50/50">
                      <td className="py-2.5 px-4">
                        <div className="flex items-center gap-2.5 min-w-0">
                          {/* Iniciais: foto do Graph fica para microtarefa própria. */}
                          <span className="w-7 h-7 shrink-0 rounded-full bg-[#c6e7ff]/40 text-[#00658d] flex items-center justify-center text-[10px] font-extrabold uppercase select-none">
                            {u.displayName ? getInitials(u.displayName) : "?"}
                          </span>
                          <span className="text-[#001e2d] font-bold truncate">
                            {u.displayName ?? (pt ? "(sem nome)" : "(no name)")}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 px-4 text-slate-500 font-mono text-[11px] truncate">
                        {email ?? "—"}
                      </td>
                      <td className="py-2.5 px-4 text-slate-500 truncate">{u.jobTitle ?? "—"}</td>
                      <td className="py-2.5 px-4">
                        {/* Sem `userType` do Graph, nada é exibido — não se chuta classificação. */}
                        {tipo ? (
                          <span className="text-[10px] font-extrabold uppercase tracking-wider text-slate-500">
                            {tipo}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4">
                        {u.accountEnabled === false ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-800 text-[9.5px] font-extrabold uppercase tracking-wider whitespace-nowrap">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                            {pt ? "Desabilitado no diretório" : "Disabled in directory"}
                          </span>
                        ) : u.accountEnabled === true ? (
                          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800 text-[9.5px] font-extrabold uppercase tracking-wider">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            {pt ? "Ativo" : "Active"}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-[10px] text-slate-400 font-semibold leading-relaxed">
            {pt
              ? "O status acima é o da conta no diretório corporativo, e não o do usuário no PGCP — são controles independentes."
              : "The status above reflects the corporate directory account, not the PGCP user — they are independent controls."}
          </p>
        </div>
      )}
    </div>
  );
}
