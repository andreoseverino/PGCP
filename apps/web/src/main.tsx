import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MsalProvider } from '@azure/msal-react';
import App from './App.tsx';
import './index.css';
import {
  acquireApiToken,
  initializeMsal,
  isEntraConfigured,
  isMockLoginAllowed,
  msalInstance,
} from './auth/msal';
import { setAccessTokenProvider } from './lib/api';

/**
 * FAIL-FAST de build de producao inseguro.
 *
 * Um bundle de PRODUCAO (`import.meta.env.PROD`) nunca pode oferecer o login
 * mockado. Isso so seria possivel se o Entra nao estivesse configurado no
 * build — exatamente a combinacao perigosa. Em vez de renderizar a tela com o
 * bypass de teste, a aplicacao para e mostra um erro claro: preferimos NAO
 * subir a subir insegura. Em dev (`import.meta.env.DEV`) o modo de teste segue
 * normal.
 */
function assertBuildDeProducaoSeguro(): void {
  if (import.meta.env.PROD && isMockLoginAllowed()) {
    const alvo = document.getElementById('root');
    if (alvo) {
      alvo.textContent =
        'Configuração inválida: build de produção com login de teste habilitado. ' +
        'Configure o Microsoft Entra ID (VITE_ENTRA_*) e refaça o build.';
    }
    throw new Error(
      'Build de produção com mock login habilitado (Entra não configurado). Inicialização abortada.',
    );
  }
}

/**
 * Inicializacao antes de renderizar.
 *
 * O MSAL v5 exige `initialize()` antes de qualquer operacao, e o provedor de
 * token precisa estar registrado antes da primeira chamada autenticada — por
 * isso os dois acontecem aqui, e nao dentro de um componente.
 *
 * `MsalProvider` so envolve a arvore quando o Entra esta configurado. Sem
 * configuracao, a aplicacao segue no caminho de desenvolvimento e nenhuma
 * dependencia de autenticacao e montada.
 */
async function bootstrap(): Promise<void> {
  assertBuildDeProducaoSeguro();

  const root = createRoot(document.getElementById('root')!);

  if (!isEntraConfigured() || !msalInstance) {
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    return;
  }

  await initializeMsal();

  // A camada de API passa a saber obter token sem conhecer o MSAL.
  setAccessTokenProvider(acquireApiToken);

  root.render(
    <StrictMode>
      <MsalProvider instance={msalInstance}>
        <App />
      </MsalProvider>
    </StrictMode>,
  );
}

void bootstrap();
