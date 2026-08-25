# Hardening de produção — PGCP

Controles de segurança para o go-live. Separa o que vive **na aplicação** (já
implementado, versionado) do que vive na **infraestrutura de borda** (reverse
proxy / API Gateway / WAF / host estático), que deve ser configurado no
ambiente e **validado** com os testes indicados.

> PostgreSQL de menor privilégio: ver [infra/postgres/README.md](../infra/postgres/README.md). Fechado e fora do escopo deste documento.

---

## 1. Rate limiting

**Estratégia em duas camadas, sem duplicação.**

### Borda (infra) — volumétrico por IP
Fica no reverse proxy / API Gateway / WAF, que vê o IP e roda antes da aplicação:
- limite por IP e por burst (ex.: 100 req / 10 s por IP, ajustar ao tráfego real);
- proteção contra automação anônima / scraping / DDoS (o WAF cobre isso);
- teto global de requisições.

A aplicação **não** reimplementa isso — seria duplicar um controle que a borda
faz melhor (e por IP, que o app nem sempre enxerga corretamente atrás de proxy).

### Aplicação — por principal autenticado (`oid`)
Implementado. Só onde **conhecer a identidade** importa — proteger recurso
compartilhado que a borda não sabe proteger. Arquivos: `apps/api/src/security/rate-limit.ts`,
`apps/api/src/security/limiters.ts`.

| Rota | Limite (por `oid`) | Porquê |
|---|---|---|
| `GET /directory/users` | 40 / 10 s | Busca no **Microsoft Graph** — cota de throttling é do **tenant**. Um usuário não pode degradar o Graph para todos. Typeahead com debounce ≈ 3–4 req/s; 40/10 s dá folga e corta enumeração roteirizada. |
| `GET /calendar/me` | 30 / 10 s | Agenda própria via Graph (OBO). Cobre recargas sem martelar o Graph. |
| `POST /integrations/:id/test` | 10 / 60 s | Admin; dispara probe de rede (banco, OIDC, Graph, DocuSign). Evita virar scanner contra hosts externos. |

Resposta ao estourar: **HTTP 429** `{code:"rate_limited"}` + `Retry-After` +
cabeçalhos `RateLimit-Limit/Remaining/Reset` (draft IETF). Chave = `oid` →
isolamento entre usuários. Estado em memória por processo.

**Limitação (documentada):** o contador é por instância. Com múltiplas
instâncias, o teto por principal vale por instância; o limite volumétrico
**autoritativo** é o da borda. Se um dia for necessário limite por principal
*global* entre instâncias, trocar o store por Redis (a interface do middleware
já isola isso). Para o cenário atual (app interno, gated por Entra), a proteção
por instância à cota do Graph é suficiente.

**Validação:** testes em `apps/api/src/security/rate-limit.test.ts` (normal,
estouro, isolamento, cabeçalhos, recuperação após janela).

---

## 2. Configuração obrigatória de produção

**Fail-fast implementado** (`apps/api/src/config/production-guard.ts`): com
`NODE_ENV=production`, a API **aborta a inicialização** se detectar configuração
perigosa. Testes: `production-guard.test.ts` + validação manual dos 5 cenários.

Checklist do `.env` de produção da API:

| Variável | Valor exigido | Fail-fast? |
|---|---|---|
| `NODE_ENV` | `production` | — |
| `ENTRA_TENANT_ID` / `ENTRA_API_CLIENT_ID` / `ENTRA_SPA_CLIENT_ID` | preenchidos | **sim** (aborta se faltar) |
| `ENTRA_API_CLIENT_SECRET` | segredo do cofre (para Graph app-only/OBO) | não (integrações ficam inativas sem ele) |
| `CORS_ORIGIN` | origem(ns) `https://` real(is), **sem** localhost, **sem** `*` | **sim** |
| `DB_SSL` | `true` | **sim** |
| `DB_USER` | `pcgp_app` (runtime, menor privilégio) | — |
| `DB_MIGRATION_USER` | `pcgp_admin` (migrations) | — |
| `PORT` | conforme o host | — |

Frontend (build de produção): as três `VITE_ENTRA_*` preenchidas. Isso **desliga
automaticamente o mock login** (`isMockLoginAllowed()` exige Entra ausente).
Além disso, `apps/web/src/main.tsx` tem **fail-fast**: um bundle
`import.meta.env.PROD` que ainda permitisse mock login (Entra não configurado no
build) **não renderiza** — mostra erro e aborta. `VITE_ALLOW_MOCK_LOGIN` deve
ser removida do `.env` de produção de qualquer forma.

---

## 3. CORS

Implementado e correto (`apps/api/src/server.ts`):
- **allowlist explícita** por `CORS_ORIGIN`, nunca `*`;
- reflete a origem só se estiver na lista; `Vary: Origin`;
- métodos exatos (`GET, POST, PATCH, PUT, DELETE, OPTIONS`);
- headers exatos (`Authorization, Content-Type`);
- **sem** `Access-Control-Allow-Credentials` — a API é **bearer token**, não usa
  cookie; habilitar credentials seria ampliar superfície sem necessidade;
- preflight `OPTIONS` → 204.

Em produção, o fail-fast (§2) recusa `localhost`, `http://` e `*` no `CORS_ORIGIN`.

**Validação:** origem permitida recebe `Access-Control-Allow-Origin`; origem não
listada não recebe (verificado ao vivo).

---

## 4. Headers de segurança e CSP

### API (implementado, `server.ts`)
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, `X-Powered-By` removido, em toda resposta.

### Frontend — **configurar no host estático / reverse proxy**
O frontend é um bundle estático (Vite); estes headers pertencem ao host que o
serve. **CSP não foi embutida como `<meta>`** de propósito: uma CSP incorreta
quebra o fluxo MSAL, e o fluxo real de login não é validável no ambiente de
desenvolvimento. Configurar como **cabeçalhos HTTP**:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' https://fonts.gstatic.com;
  img-src 'self' data:;
  connect-src 'self' https://SUA-API.exemplo.com https://login.microsoftonline.com;
  frame-src 'self' https://login.microsoftonline.com;
  object-src 'none';
  base-uri 'self';
  form-action 'self' https://login.microsoftonline.com;
  frame-ancestors 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

**Nuances críticas do MSAL (confirmadas na doc oficial `@azure/msal-browser`):**
- `acquireTokenSilent` usa um **iframe oculto** que carrega
  `login.microsoftonline.com` e depois a página **same-origin** `auth/redirect.html`.
  Por isso `connect-src` **e** `frame-src` precisam de `https://login.microsoftonline.com`.
- **NÃO** aplicar `X-Frame-Options: DENY` nem `frame-ancestors 'none'` **na
  página `auth/redirect.html`** — isso bloqueia o iframe silencioso (mesmo
  same-origin) e quebra o SSO silencioso. Para `redirect.html`, use no máximo
  `frame-ancestors 'self'` (e não envie `X-Frame-Options`). Para `index.html`, é
  o normal (`frame-ancestors 'none'` protege contra clickjacking, pois o app
  principal nunca é enquadrado).
- `style-src 'unsafe-inline'` é necessário: Tailwind/motion/recharts injetam
  estilos inline. `script-src` fica `'self'` (Vite empacota tudo; sem inline).
- `connect-src` deve incluir a **URL real da API** (`VITE_API_URL`). O navegador
  **não** chama o Microsoft Graph — todo Graph nasce na API — então `graph.microsoft.com`
  **não** entra no `connect-src` (menor privilégio).
- `HSTS` só com HTTPS garantido na borda.

---

## 5. Cookies, sessão e tokens

Arquitetura: **stateless, bearer token**. Não há cookie de sessão, nem
`express-session`, nem `res.cookie` — verificado. Portanto `HttpOnly`/`Secure`/
`SameSite` **não se aplicam** (não há cookie a proteger).

- Token de acesso: gerido pelo **MSAL** em `sessionStorage` (`cacheLocation`).
  Nenhum código da aplicação grava access token em `localStorage`. `localStorage`
  guarda só preferências (idioma) e nada sensível.
- Token **nunca** em URL / query string (o MSAL usa Authorization Code + PKCE; a
  ponte `redirect.html` limpa hash/query).
- Token **nunca** em log: verificado — os dois `console` que citam "token"
  registram apenas a **mensagem de erro** (falha de aquisição/validação), nunca
  o token nem partes dele.
- Logout: `logoutPopup` encerra a sessão MSAL; sessão local em `sessionStorage`
  some ao fechar o navegador.
- API guarda o token bruto só em `req.entraAccessToken` (para OBO do calendário),
  que **morre com a requisição** — nunca persistido, logado ou devolvido.

Nada a alterar. Manter a disciplina em revisões futuras.

---

## 6. Microsoft Entra ID (revisão)

Backend valida corretamente (`apps/api/src/entra/verify.ts`), sem alteração:
- **assinatura** (`jose` + JWKS remoto por tenant, RS256, rotação de chave);
- **issuer** (`login.microsoftonline.com/{tid}/v2.0`);
- **audience** (`aud` = client id da API — reconferido após o `jose`);
- **tenant** (`tid`);
- **`oid`** (identidade; rejeita token sem `oid`);
- **`azp`** (só o SPA do PGCP pode obter token para a API);
- **scope** (`scp` contém `access_as_user`);
- **expiração/nbf** (`jose`, com `clockTolerance` de 60 s).

Autorização:
- **RBAC não depende do frontend** — cada rota revalida no servidor;
- App Roles vêm **exclusivamente** do claim `roles` assinado; nenhum papel é
  derivado de e-mail, `jobTitle`, nome ou grupo consultado à parte;
- App Roles são a única fonte de autorização funcional.

Arquitetura correta. Nada a mudar.

---

## 7. Microsoft Graph — permissões (revisão)

Modelo já é de **menor privilégio** (ver [docs/integracoes.md](integracoes.md)):

| Capacidade PGCP | Tipo | Permissão | Endpoint | Onde é concedida |
|---|---|---|---|---|
| Diretório (busca de pessoas) | Application | `User.Read.All` | `GET /users?$search` | App Registration da API (Entra) |
| Meu calendário | Delegated (OBO) | `Calendars.Read` | `GET /me/calendarView` | App Registration da API (Entra) |
| Sincronizar reunião / Teams | Application | `Calendars.ReadWrite` | `POST/PATCH /users/{id}/events` | **Exchange Online RBAC for Applications** (escopo de mailbox), **não** Entra tenant-wide |
| SPA (navegador) | — | **nenhuma** | — | zero permissão de Graph |

Confirmações:
- SPA não tem **nenhuma** permissão de Graph; todo Graph nasce na API.
- Calendário app-only vem do **Exchange RBAC** com **Resource Scope** de
  mailbox — **não** conceder `Calendars.ReadWrite` (Application) tenant-wide no
  Entra (passaria por cima do escopo). Documentado em `graph/client.ts` e
  `integracoes.md`.
- Mail e Teams-messages: **adiados**, sem permissão concedida — nada a reduzir.

Sem permissão excessiva identificada. Nada a remover.

---

## 8. Reverse proxy / WAF (recomendação independente de fornecedor)

A tecnologia de hospedagem ainda não está fixada — a recomendação é por
**controle**, não por produto. Implementar na borda:

| Controle | Onde | Validação |
|---|---|---|
| HTTPS obrigatório + redirect HTTP→HTTPS | proxy/host | `curl -I http://…` → 301/308 para https |
| HSTS (`max-age` longo, `includeSubDomains`) | proxy/host | header presente em resposta HTTPS |
| Rate limit por IP + burst | proxy/WAF | teste de carga por IP recebe 429 |
| Limite de body | proxy | (a API já impõe limite JSON; a borda reforça) |
| Timeout de requisição | proxy | requisição lenta é cortada |
| Bloqueio de métodos não usados (TRACE, CONNECT) | proxy | `curl -X TRACE` → 405 |
| Headers de segurança do frontend + CSP (§4) | host estático/proxy | headers presentes |
| **API não exposta direta à internet** | rede | API só acessível via proxy; porta 3333 não pública |
| Encaminhar `X-Forwarded-For`/`X-Request-Id` | proxy | app loga IP/correlation corretos |
| WAF (OWASP CRS) | WAF | regras gerenciadas ativas |

Notas:
- Se a borda encaminhar `X-Forwarded-For`, configurar `app.set('trust proxy', …)`
  para a API ler o IP real (hoje **não** setado — decisão consciente até o número
  de hops do proxy ser conhecido; o rate limit por principal não depende de IP).
- A API já devolve/aceita `X-Request-Id` — o proxy deve **gerá-lo na borda** e
  propagá-lo.

---

## 9. Observabilidade de segurança / Log Analytics

**Preparado na aplicação**, pronto para conectar:
- **Correlation id**: `apps/api/src/security/request-id.ts` — cada requisição tem
  `X-Request-Id` (reaproveita o do proxy se válido, senão gera UUID), devolvido
  no header e presente em todo log.
- **Log estruturado de segurança**: `apps/api/src/security/security-log.ts` —
  uma linha JSON por evento (`kind:"security"`), em stdout, **sem token/segredo**.
  Já emite: **autenticação recusada / token inválido** (401), **acesso sem App
  Role** (403), **rate limit** (429), **teste de integração**, **erro inesperado**
  (500). Todos com `requestId`, `principalOid`, `route` (sem querystring) e `code`.
- **Login bem-sucedido** e **alteração administrativa** já vão para a trilha de
  governança `audit_logs` (PostgreSQL), na transação do ato — não duplicados no
  stdout.

Cobertura dos eventos pedidos:

| Evento | Onde |
|---|---|
| login bem-sucedido | `audit_logs` (`/me`) |
| login recusado / token inválido | security-log (`entra/middleware`) |
| usuário sem App Role / 403 | security-log (`authz/app-roles`) |
| tentativa sem autorização / 401 | security-log (`entra/middleware`) |
| rate limit acionado | security-log (`rate-limit`) |
| alteração administrativa | `audit_logs` (cada operação de domínio) |
| teste de integração | security-log (`integrations/routes`) |
| erro no Graph | log da API (`graph/client`), sem token |
| erro inesperado | security-log (handler final, com `requestId`) |

**A conectar (externo):** exportar para o Log Analytics/Application Insights.
Opções, sem código novo obrigatório:
1. o coletor do host lê **stdout** (as linhas `kind:"security"` já saem prontas) —
   caminho mais simples em contêiner;
2. ou o exportador OpenTelemetry/Application Insights na API (slot
   `APPLICATIONINSIGHTS_CONNECTION_STRING` já previsto no catálogo de integrações),
   Etapa 8. **Nunca** enviar token, secret, cookie ou connection string.

Alertas sugeridos no Log Analytics: pico de 401/403 por `principalOid` ou IP;
`rate_limit` recorrente; `unexpected_error`; `missing_app_role` repetido (tentativa
de escalada).

---

## 10. Secrets

- `.gitignore` cobre `.env*` (exceto `.env.example`): o `.env` real **nunca** é
  versionado.
- **Nenhum** valor de segredo hardcoded em código, docs, scripts, `docker-compose`
  ou `.env.example` — verificado. Só há `config.clientSecret` (leitura de config).
- Frontend: `VITE_*` são públicos por natureza (tenant/client ids) — **não** são
  segredos; nenhum segredo com prefixo `VITE_`.

**Ação de rotação (externa):** o `apps/api/.env` local de desenvolvimento contém
um `ENTRA_API_CLIENT_SECRET` real e as senhas de banco de dev. Antes do go-live:
- **rotacionar** o `ENTRA_API_CLIENT_SECRET` e emitir o segredo de produção
  direto no cofre (Key Vault), nunca em arquivo;
- senhas de banco de produção próprias, no cofre (ver PostgreSQL README);
- garantir que nenhum `.env` real chegue a imagem de contêiner ou artefato.

---

## Ações externas antes do go-live (resumo)

1. **Provisionar Postgres de produção** com os 3 papéis (README do infra) e
   senhas de cofre; `DB_SSL=true`, `sslmode=verify-full`.
2. **Segredos no cofre**: rotacionar `ENTRA_API_CLIENT_SECRET`; senhas de banco.
3. **Borda**: HTTPS+HSTS, rate limit por IP, WAF, headers/CSP do frontend (§4/§8),
   API não exposta direta, `X-Request-Id` gerado no proxy.
4. **`.env` de produção** conforme §2 (o fail-fast recusa configuração perigosa).
5. **Exchange Online RBAC** do calendário com Resource Scope de mailbox (não
   conceder Calendars.ReadWrite tenant-wide no Entra).
6. **Log Analytics**: conectar stdout `kind:"security"` + `audit_logs`; criar
   alertas.
7. **Remover** `VITE_ALLOW_MOCK_LOGIN` do ambiente de produção.
