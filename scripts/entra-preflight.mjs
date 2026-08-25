/**
 * Pré-voo da configuração do Microsoft Entra ID.
 *
 *   node scripts/entra-preflight.mjs
 *
 * Diagnostica os DOIS App Registrations sem exigir login: confere coerência
 * entre `apps/api/.env` e `apps/web/.env`, alcança o tenant e interroga o
 * endpoint de autorização para detectar client id inexistente, redirect URI não
 * registrada e scope não exposto.
 *
 * NÃO imprime valor de segredo nem token. Client ids e tenant aparecem
 * mascarados — são públicos por natureza, mas mascarar evita cópia acidental de
 * relatório para fora.
 *
 * O que ele NÃO prova: que o login funciona. Isso exige uma pessoa concluindo o
 * popup do Microsoft (credencial + MFA) no navegador.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lerEnv(caminho) {
  try {
    return Object.fromEntries(
      readFileSync(join(raiz, caminho), "utf8")
        .split(/\r?\n/)
        .filter((linha) => /^[A-Z_][A-Z0-9_]*=/.test(linha))
        .map((linha) => {
          const i = linha.indexOf("=");
          return [linha.slice(0, i).trim(), linha.slice(i + 1).trim()];
        })
    );
  } catch {
    return null;
  }
}

const mascarar = (v) => (!v ? "(vazia)" : v.length <= 12 ? `<${v.length} chars>` : `${v.slice(0, 8)}…${v.slice(-4)}`);

let problemas = 0;
const ok = (texto, extra = "") => console.log(`  ✓ ${texto}${extra ? "  " + extra : ""}`);
const erro = (texto, comoCorrigir) => {
  problemas++;
  console.log(`  ✗ ${texto}`);
  if (comoCorrigir) console.log(`      → ${comoCorrigir}`);
};

const api = lerEnv("apps/api/.env");
const web = lerEnv("apps/web/.env");

if (!api || !web) {
  console.log("Arquivos de ambiente ausentes. Copie os .env.example para .env em apps/api e apps/web.");
  process.exit(1);
}

// -----------------------------------------------------------------------------
console.log("\n=== 1. Presença e formato ===");

const tenant = api.ENTRA_TENANT_ID;
const apiClientId = api.ENTRA_API_CLIENT_ID;
const spaClientId = api.ENTRA_SPA_CLIENT_ID;
const appIdUri = api.ENTRA_API_APP_ID_URI;
const scopeName = api.ENTRA_API_SCOPE_NAME || "access_as_user";
const redirectUri = web.VITE_ENTRA_REDIRECT_URI;
const apiScope = web.VITE_ENTRA_API_SCOPE;

for (const [nome, valor] of [
  ["ENTRA_TENANT_ID", tenant],
  ["ENTRA_API_CLIENT_ID", apiClientId],
  ["ENTRA_SPA_CLIENT_ID", spaClientId]
]) {
  if (!valor) erro(`${nome} vazia`, "Preencher em apps/api/.env");
  else if (!GUID.test(valor)) erro(`${nome} não é um GUID`, "Copiar do Azure em formato GUID");
  else ok(`${nome} = ${mascarar(valor)}`);
}

if (!appIdUri) erro("ENTRA_API_APP_ID_URI vazia", "Application ID URI da PGCP API, ex.: api://<api-client-id>");
else if (apiClientId && !appIdUri.includes(apiClientId))
  erro("ENTRA_API_APP_ID_URI não contém o client id da API", "Confirmar em Expose an API → Application ID URI");
else ok(`ENTRA_API_APP_ID_URI = ${mascarar(appIdUri)}`);

// -----------------------------------------------------------------------------
console.log("\n=== 2. Coerência entre API e Web ===");

// Comparar dois vazios daria "idêntico" e mascararia a ausência, que a seção 1
// já reportou. Por isso a comparação só ocorre quando há valor dos dois lados.
if (!tenant || !web.VITE_ENTRA_TENANT_ID)
  console.log("  – tenant: comparação pulada (valor ausente)");
else if (tenant !== web.VITE_ENTRA_TENANT_ID)
  erro("tenant divergente entre apps/api/.env e apps/web/.env", "Os dois registros ficam no MESMO tenant");
else ok("tenant idêntico nos dois arquivos");

if (!spaClientId || !web.VITE_ENTRA_SPA_CLIENT_ID)
  console.log("  – SPA client id: comparação pulada (valor ausente)");
else if (spaClientId !== web.VITE_ENTRA_SPA_CLIENT_ID)
  erro("SPA client id divergente", "VITE_ENTRA_SPA_CLIENT_ID deve ser igual a ENTRA_SPA_CLIENT_ID (a API valida azp)");
else ok("SPA client id idêntico nos dois arquivos");

if (apiClientId && spaClientId && apiClientId === spaClientId)
  erro("client id da API igual ao do SPA", "São DOIS App Registrations distintos");
else if (apiClientId && spaClientId) ok("client ids da API e do SPA são distintos");

const scopeEsperado = appIdUri ? `${appIdUri.replace(/\/+$/, "")}/${scopeName}` : null;
if (!apiScope) erro("VITE_ENTRA_API_SCOPE vazia", `Preencher com ${scopeEsperado ?? "api://<api-client-id>/" + scopeName}`);
else if (scopeEsperado && apiScope !== scopeEsperado)
  erro("VITE_ENTRA_API_SCOPE não corresponde", `Esperado: ${scopeEsperado}`);
else ok(`VITE_ENTRA_API_SCOPE = ${apiScope}`);

if (Object.keys(web).some((k) => /SECRET|PASSWORD|PRIVATE|_KEY$/i.test(k)))
  erro("segredo com prefixo VITE_", "VITE_* vai para o bundle do navegador. Mover para apps/api/.env");
else ok("nenhum segredo no ambiente do frontend");

if (problemas > 0) {
  console.log(`\n${problemas} problema(s) de configuração local. Corrija antes de consultar o Azure.\n`);
  process.exit(1);
}

// -----------------------------------------------------------------------------
console.log("\n=== 3. Tenant acessível ===");

const buscar = async (url) => {
  const controle = new AbortController();
  const timer = setTimeout(() => controle.abort(), 10000);
  try {
    return await fetch(url, { signal: controle.signal, redirect: "manual" });
  } finally {
    clearTimeout(timer);
  }
};

try {
  const resposta = await buscar(`https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`);
  if (!resposta.ok) {
    erro(`documento de descoberta respondeu HTTP ${resposta.status}`, "Conferir o ENTRA_TENANT_ID");
  } else {
    const meta = await resposta.json();
    ok("documento de descoberta OIDC publicado");
    if (typeof meta.jwks_uri === "string") ok("jwks_uri presente — a API tem como validar assinatura");
    else erro("jwks_uri ausente no metadata", "Tenant em estado inesperado; abrir chamado com o time de identidade");
    const emissorEsperado = `https://login.microsoftonline.com/${tenant}/v2.0`;
    if (meta.issuer === emissorEsperado) ok("issuer confere com o que a API espera");
    else erro(`issuer divergente: ${meta.issuer}`, `A API espera ${emissorEsperado}`);
  }
} catch {
  erro("não foi possível alcançar o Microsoft Entra ID", "Verificar rede/proxy");
}

// -----------------------------------------------------------------------------
console.log("\n=== 4. App Registrations (sem login) ===");

/**
 * Interroga o endpoint de autorização. A resposta revela erro de registro sem
 * ninguém autenticar: client id inexistente, redirect URI não registrada, scope
 * não exposto. Um formulário de login significa que o registro está coerente.
 */
const AADSTS = {
  AADSTS700016: [
    "aplicação não encontrada no tenant",
    "O SPA client id não existe neste tenant. Conferir VITE_ENTRA_SPA_CLIENT_ID e o tenant."
  ],
  AADSTS50011: [
    "redirect URI não registrada",
    `Registrar exatamente "${redirectUri}" no App Registration do PGCP Web, plataforma Single-page application (NÃO "Web").`
  ],
  AADSTS650053: [
    "scope não reconhecido",
    `A PGCP API não expõe "${scopeName}", ou o Application ID URI difere. Conferir Expose an API.`
  ],
  AADSTS500011: [
    "service principal do recurso não encontrado",
    "O Application ID URI da PGCP API está errado, ou a API não tem service principal neste tenant."
  ],
  AADSTS65001: [
    "consentimento ausente",
    "Registro coerente, porém sem consentimento. Em Authorized client applications da PGCP API, pré-autorizar o client id do SPA — ou conceder consentimento no primeiro login."
  ],
  AADSTS900971: ["requisição sem response_type utilizável", "Provável divergência de plataforma do registro (SPA vs Web)."]
};

const desafio = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"; // PKCE S256, valor público de teste
const parametros = new URLSearchParams({
  client_id: spaClientId,
  response_type: "code",
  redirect_uri: redirectUri,
  response_mode: "fragment",
  scope: `openid profile ${apiScope}`,
  code_challenge: desafio,
  code_challenge_method: "S256",
  state: "preflight",
  nonce: "preflight"
});

try {
  const resposta = await buscar(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize?${parametros}`
  );
  const corpo = await resposta.text();
  const encontrados = Object.keys(AADSTS).filter((codigo) => corpo.includes(codigo));
  const outro = corpo.match(/AADSTS\d{4,6}/);

  if (encontrados.length > 0) {
    for (const codigo of encontrados) {
      const [descricao, correcao] = AADSTS[codigo];
      if (codigo === "AADSTS65001") ok(`registro coerente (${codigo}: ${descricao})`, "→ " + correcao);
      else erro(`${codigo}: ${descricao}`, correcao);
    }
  } else if (outro) {
    erro(`${outro[0]}: erro não catalogado`, "Consultar o código no portal de erros do Entra ID");
  } else if (resposta.status === 200 && /ConvergedSignIn|urlPost|loginfmt/.test(corpo)) {
    ok("endpoint de autorização devolveu formulário de login");
    ok("client id e scope aceitos pelo Entra");
    // Verificado empiricamente: este tenant devolve o formulário de login mesmo
    // para uma redirect_uri inexistente. A validação acontece só no RETORNO do
    // login, então afirmar aqui que a URI está cadastrada seria inventar.
    console.log(
      `  ? redirect URI NÃO verificável nesta fase — o Entra só a valida no retorno do login.\n` +
        `      Confirme manualmente que "${redirectUri}" está em\n` +
        `      PGCP Web → Autenticação → Aplicativo de página única → URIs de redirecionamento.`
    );
  } else if (resposta.status >= 300 && resposta.status < 400) {
    ok(`endpoint de autorização redirecionou (HTTP ${resposta.status}) — sem erro de registro`);
  } else {
    console.log(`  ? resposta inesperada (HTTP ${resposta.status}); nada conclusivo`);
  }
} catch {
  erro("não foi possível consultar o endpoint de autorização", "Verificar rede/proxy");
}

// -----------------------------------------------------------------------------
console.log("\n=== Resultado ===");
if (problemas === 0) {
  console.log("  Configuração coerente. Falta o passo interativo:");
  console.log("  abrir http://localhost:3000, clicar em \"Entrar com Microsoft\" e concluir o login.");
  console.log("  Depois: Configurações → Integrações → Login / Entra ID deve mostrar os três níveis em verde.\n");
} else {
  console.log(`  ${problemas} problema(s) a corrigir.\n`);
}
process.exit(problemas > 0 ? 1 : 0);
