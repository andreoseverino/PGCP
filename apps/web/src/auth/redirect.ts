/**
 * Ponte de redirect do MSAL v5.
 *
 * Único ponto de entrada de `auth/redirect.html`. Executa exclusivamente o
 * repasse da resposta de autenticação para a janela principal.
 *
 * POR QUE ESTA PÁGINA EXISTE
 *
 * No MSAL Browser v5 o fluxo de popup deixou de sondar a URL da janela filha.
 * `PopupClient.waitForPopupResponse` aguarda uma mensagem num `BroadcastChannel`
 * — no código da biblioteca, o comentário é literal: "Wait for the redirect
 * bridge response". Quem publica nesse canal é `broadcastResponseToMainFrame`.
 *
 * Antes, `VITE_ENTRA_REDIRECT_URI` apontava para a raiz da aplicação: o Entra
 * devolvia o code para `/`, o popup carregava o PGCP inteiro, ninguém publicava
 * no canal, e a janela principal ficava esperando até estourar
 * `popupBridgeTimeout` (erro `timed_out`) com o popup aberto na tela de login.
 *
 * Esta página não importa nada da aplicação — nem React, nem `msal.ts`, nem
 * CSS. `broadcastResponseToMainFrame` lê a resposta da própria URL, então não
 * há `PublicClientApplication` para configurar aqui.
 *
 * Serve também ao `logoutPopup`, que em v5 igualmente aguarda a ponte.
 */

import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

broadcastResponseToMainFrame().catch((error: unknown) => {
  /*
   * A biblioteca já limpa hash e query string antes de propagar o erro, então
   * nada da resposta permanece na barra de endereços.
   *
   * Registramos apenas o nome do erro: a mensagem pode conter fragmentos da
   * resposta de autenticação, e authorization code não vai para o console.
   */
  const nome = error instanceof Error ? error.name : "Error";
  console.error(`[auth/redirect] falha ao repassar a resposta de autenticação (${nome})`);

  const aviso = document.querySelector("p");
  if (aviso) {
    aviso.textContent =
      "Não foi possível concluir a autenticação. Feche esta janela e tente novamente.";
  }
});
