# Runbook — Exchange Online RBAC para o calendário do PGCP

**Objetivo:** permitir que o PGCP **crie e atualize eventos de calendário
somente em mailboxes autorizadas**, usando *Exchange Online RBAC for
Applications*.

Este documento reproduz, passo a passo, a configuração validada em homologação.
Segue o mesmo procedimento no ambiente corporativo.

> **Nenhum valor real deste ou de qualquer ambiente aparece aqui.** Todos os
> identificadores são placeholders. **Não** acrescente client secret, token,
> senha, certificado, e-mail real, tenant id, app id ou object id a este
> arquivo.

---

## 1. Duas capacidades diferentes — não confundir

O PGCP fala com o calendário de duas formas, por motivos diferentes. Trocá-las é
o erro mais caro aqui.

| | **A. Ver o próprio calendário** | **B. Administrar calendário de organizador** |
|---|---|---|
| Quem usa | **todos** os usuários do PGCP | o PGCP, em nome da operação |
| Permissão | `Calendars.Read` **Delegated** | **`Application Calendars.ReadWrite`** |
| Concedida onde | App Registration (Entra) | **Exchange Online RBAC** |
| Fluxo | On-Behalf-Of (usuário na sessão) | client credentials (app-only) |
| Chamada | `GET /me/calendarView` | `POST` / `PATCH /users/{oid}/events` |
| Alcance | a própria caixa, por natureza | limitado pelo **Resource Scope** |

**A** já funciona só com a permissão delegada — não passa por este runbook.
**B** é o assunto daqui.

### Por que app-only, e não On-Behalf-Of, para agendar

Criar evento na caixa de outra pessoa não pode depender de a sessão dela estar
aberta: o organizador nem está logado quando a assessora agenda, e retry e
reprocessamento precisam funcionar sem ninguém presente. Por isso app-only — e,
como permissão de aplicação alcançaria todo o tenant, o **Resource Scope** é o
que devolve o limite.

---

## 2. Três papéis, três controles

| Papel | Quem é | Onde é controlado |
|---|---|---|
| **Ator** | quem opera o PGCP e cadastra a reunião | App Role `PGCP.Assessoria` (Entra) |
| **Organizador** | pessoa em cuja caixa o evento nasce | **Resource Scope** (Exchange) |
| **Convidado** | quem recebe o convite | nenhuma autorização especial |

O caso real: **a assessora cadastra a reunião do Presidente.** Ela é o ator, ele
é o organizador.

> **A caixa que entra no Resource Scope é a do ORGANIZADOR** — quem terá a
> reunião na própria agenda. **Não** a de quem opera o sistema. Autorizar a caixa
> da assessora não faz a integração funcionar: o PGCP não escreve na agenda dela.

Na prática, **o Resource Scope define quem pode ser escolhido como organizador**.

### O escopo NÃO limita quem pode ser convidado

> **Convidados não precisam estar dentro do Resource Scope.**

O escopo controla **em quais caixas o PGCP escreve**. O PGCP escreve em uma só: a
do organizador. Os convidados entram como `attendees` **dentro desse evento** —
o PGCP nunca toca na caixa deles, e é o próprio Exchange que entrega o convite.

Consequência prática, importante ao dimensionar o escopo corporativo:

| Papel | Precisa estar no Resource Scope? |
|---|---|
| Organizador | **sim** — o evento nasce na caixa dele |
| Convidado interno | **não** |
| Convidado externo (fora do tenant) | **não** |

Ou seja: um escopo com **poucas caixas de organizadores** já atende reuniões com
qualquer número de convidados, de dentro ou de fora da organização. Não amplie o
escopo por causa da lista de participantes — validado em homologação, com um
convidado fora do escopo recebendo o convite normalmente.

As três camadas são independentes e obrigatórias no modelo final:

```
ator        → App Role PGCP.Assessoria   quem pode mandar o PGCP agir
organizador → Exchange Resource Scope      em qual caixa o PGCP escreve
convidado   → attendee do evento           nenhuma autorização especial
```

Usuário sem `PGCP.Assessoria` é barrado pelo PGCP antes de chegar ao Exchange;
organizador fora do escopo é barrado pelo Exchange; convidado não é barrado por
nenhum dos dois.

---

## 3. Pré-requisitos

| Item | Observação |
|---|---|
| Acesso administrativo ao Exchange Online | perfil com permissão de gerenciamento de função |
| App Registration **PGCP API** existente no Entra | já criado nas etapas de identidade |
| `<APP-ID>` | *Application (client) ID* do App Registration **PGCP API** |
| `<SP-OBJECT-ID>` | *Object ID* da **Enterprise Application** (service principal) |
| `<PGCP-SP-NAME>` | nome do service principal no Exchange, ex.: `PGCP-API` |
| `<MAILBOX-HOMOLOG>` | caixa autorizada para homologação |
| `<MAILBOX-ENTRA-OBJECT-ID>` | *Object ID* **no Entra** dessa mesma pessoa |
| `<MAILBOX-CONTROLE>` | caixa **fora** do escopo, só para provar o limite |
| `<SCOPE-NAME>` | nome do Resource Scope, ex.: `PGCP-Calendario-Homologacao` |

> ### ⚠ `<SP-OBJECT-ID>` não é o Object ID do App Registration
>
> São dois objetos distintos no Entra:
>
> | Objeto | Onde | Papel |
> |---|---|---|
> | **App Registration** | *App registrations* → PGCP API | a definição do aplicativo |
> | **Enterprise Application** (service principal) | *Enterprise applications* → PGCP API | a instância dele **neste tenant** |
>
> Cada um tem o próprio *Object ID*, e o Exchange quer o da **Enterprise
> Application**. O `<APP-ID>` (client id) é o mesmo nos dois — só o Object ID
> difere. Trocar os dois é a causa mais comum de falha nesta configuração.

---

## 4. Preparar o PowerShell

Os passos 4.1 e 4.2 são **condicionais** — só quando o módulo ainda não está
instalado na máquina. O 4.3 é obrigatório em toda execução.

### 4.1 (condicional) Provedor NuGet

Necessário quando `Install-Module` reclama de provedor ausente:

```powershell
Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force
```

### 4.2 (condicional) Atualizar o PowerShellGet

Necessário em máquinas com a versão de fábrica do Windows PowerShell 5.1:

```powershell
Install-Module -Name PowerShellGet -Scope CurrentUser -Force -AllowClobber
```

> **Feche e reabra o PowerShell** depois deste comando — a versão nova só entra
> em vigor numa sessão limpa. Conferir:
>
> ```powershell
> Get-Module -ListAvailable PowerShellGet | Select-Object Name, Version
> ```

### 4.3 (obrigatório) Módulo do Exchange Online e conexão

```powershell
Install-Module -Name ExchangeOnlineManagement -Scope CurrentUser

Connect-ExchangeOnline
```

Confirmar a sessão antes de seguir:

```powershell
Get-ConnectionInformation |
  Select-Object UserPrincipalName, TokenStatus
```

`TokenStatus` precisa estar **`Active`**. Sem isso, os comandos seguintes falham
de formas pouco explicativas.

---

## 5. Registrar o PGCP no Exchange Online

O Exchange mantém a própria referência ao service principal do Entra.

**Consultar primeiro** — se já existir, **não** criar de novo:

```powershell
Get-ServicePrincipal |
  Where-Object { $_.DisplayName -eq "<PGCP-SP-NAME>" }
```

Só se não retornar nada:

```powershell
New-ServicePrincipal `
  -AppId    "<APP-ID>" `
  -ObjectId "<SP-OBJECT-ID>" `
  -DisplayName "<PGCP-SP-NAME>"
```

---

## 6. Conferir a identidade da mailbox

O filtro do escopo usa o Object ID do Entra, não o endereço. Confirmar que os
dois lados falam da mesma pessoa:

```powershell
Get-EXOMailbox `
  -Identity "<MAILBOX-HOMOLOG>" `
  -Properties ExternalDirectoryObjectId |
  Format-List DisplayName, PrimarySmtpAddress, ExternalDirectoryObjectId
```

> **Regra de parada.** O `ExternalDirectoryObjectId` devolvido tem de ser
> exatamente `<MAILBOX-ENTRA-OBJECT-ID>` — o Object ID da mesma pessoa no Entra.
>
> **Se não bater, PARE.** Um escopo apontando para o objeto errado autoriza a
> caixa errada, e o erro só apareceria muito depois.

---

## 7. Criar o Resource Scope

```powershell
New-ManagementScope `
  -Name "<SCOPE-NAME>" `
  -RecipientRestrictionFilter "ExternalDirectoryObjectId -eq '<MAILBOX-ENTRA-OBJECT-ID>'"
```

Conferir:

```powershell
Get-ManagementScope "<SCOPE-NAME>" |
  Format-List Name, ScopeRestrictionType, RecipientFilter, Exclusive
```

### Por que `ExternalDirectoryObjectId`, e não `PrimarySmtpAddress`

A documentação da Microsoft alerta que um filtro por `PrimarySmtpAddress` também
casa com endereços presentes em `EmailAddresses` — **inclusive aliases**. Um
alias criado depois, ou herdado de outra caixa, ampliaria o escopo em silêncio,
sem que ninguém tenha mudado a regra.

`ExternalDirectoryObjectId` é a identidade do objeto no diretório: não tem alias,
não muda quando o endereço muda, e é **o mesmo identificador que o PGCP usa** para
endereçar o organizador (`meetings.organizer_entra_object_id`). Os dois lados
concordam sobre quem é a pessoa.

O endereço continua útil para os testes e para leitura humana — o que ele não
deve ser é a chave do filtro.

> **Escopo mínimo primeiro.** Em homologação, **uma única caixa**. Ampliar para
> grupo, departamento ou atributo customizado é decisão da governança, tomada
> depois de o smoke test provar o comportamento.

---

## 8. Conferir que a função existe

```powershell
Get-ManagementRole "Application Calendars.ReadWrite" |
  Format-List Name
```

É o mínimo necessário: criar e atualizar evento na caixa do organizador. Não é
preciso leitura de correio, envio de e-mail nem acesso a caixas compartilhadas.

---

## 9. Criar a atribuição

```powershell
New-ManagementRoleAssignment `
  -App  "<SP-OBJECT-ID>" `
  -Role "Application Calendars.ReadWrite" `
  -CustomResourceScope "<SCOPE-NAME>"
```

A atribuição amarra três coisas:

```
  -App                  QUEM age          o service principal do PGCP
  -Role                 O QUE pode fazer  criar/atualizar evento de calendário
  -CustomResourceScope  ONDE pode agir    as caixas dentro do escopo
```

Sem `-CustomResourceScope`, a atribuição vale para **todas** as caixas do tenant
— exatamente o que este desenho evita.

---

## 10. Provar o escopo — os dois testes

**Ambos** são obrigatórios. Só o positivo não valida nada: prova que a permissão
existe, não que ela está limitada.

### 10.1 Positivo — deve dar `InScope = True`

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<SP-OBJECT-ID>" `
  -Resource "<MAILBOX-HOMOLOG>" |
  Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope
```

### 10.2 Negativo — deve dar `InScope = False`

```powershell
Test-ServicePrincipalAuthorization `
  -Identity "<SP-OBJECT-ID>" `
  -Resource "<MAILBOX-CONTROLE>" |
  Format-Table RoleName, GrantedPermissions, AllowedResourceScope, ScopeType, InScope
```

> Uma configuração em que a caixa de homologação funciona **mas a de controle
> também** não está validada: significa que o escopo não está limitando nada.

> **`InScope = False` significa "não pode ser ORGANIZADOR".** A mesma pessoa
> continua podendo ser **convidada** para qualquer reunião — o convite não passa
> por este escopo. Não confunda o resultado negativo com "esta pessoa está fora
> do sistema".

`Test-ServicePrincipalAuthorization` valida **apenas** o Exchange RBAC. A regra
do §11 é verificada separadamente, no Entra.

---

## 11. ⚠ Regra crítica do App Registration

> **NÃO conceder `Calendars.ReadWrite` do tipo Application (tenant-wide) no App
> Registration** enquanto este desenho usar Exchange Application RBAC para
> restringir mailboxes.

As duas autorizações são **aditivas**. Um grant tenant-wide no Entra passa por
cima do Resource Scope e devolve à aplicação acesso a **todas** as caixas — que é
exatamente o que o escopo existe para impedir. O resultado é pior do que não ter
escopo nenhum: a configuração *parece* restrita e não é.

Conferir no portal, em *App registrations → PGCP API → API permissions*: não deve
existir `Calendars.ReadWrite` do tipo **Application**.

`Calendars.Read` **Delegated** é outra coisa e **deve** permanecer — é ela que
sustenta o "cada um vê o próprio calendário".

---

## 12. Checklist do ambiente corporativo

Preencher com os valores do ambiente de destino — **não** copiar identificadores
de outro ambiente.

### Entra ID

- [ ] App Registration corporativo do **PGCP API** conferido
- [ ] `Calendars.Read` **Delegated** configurada e com consentimento concedido
- [ ] App Role **`PGCP.Assessoria`** criado no manifesto da API
      (`allowedMemberTypes: ["User"]`, habilitado)
- [ ] Grupo corporativo de assessoria **atribuído ao App Role** na Enterprise
      Application — conferir que a atribuição aponta para `PGCP.Assessoria`, e
      **não** para *Default Access*
- [ ] **`Calendars.ReadWrite` Application NÃO concedida** (§11)

### Exchange Online

- [ ] PGCP API registrado como service principal no Exchange
- [ ] `ExternalDirectoryObjectId` da caixa conferido contra o Object ID do Entra
- [ ] Resource Scope criado para os organizadores permitidos
- [ ] `Application Calendars.ReadWrite` atribuída **com** `-CustomResourceScope`
- [ ] Caixa **dentro** do escopo → `InScope = True`
- [ ] Caixa **fora** do escopo → `InScope = False`

### PGCP

- [ ] Smoke test de **criação**: evento aparece na caixa do organizador, com
      organizer, título, data e fuso corretos
- [ ] Smoke test de **atualização**: alteração marca `stale`; ressincronizar faz
      PATCH no **mesmo** evento, sem duplicata
- [ ] Convite chega ao participante pelo próprio evento do calendário —
      **sem** `Mail.Send`, e sem exigir que o convidado esteja no Resource Scope

---

## 13. Diagnóstico rápido

| Sintoma | Causa provável |
|---|---|
| `403 ErrorAccessDenied` do Graph | caixa fora do Resource Scope, ou atribuição ausente no Exchange |
| `403 Authorization_RequestDenied` | falta permissão **no Entra** — camada diferente, não mexer no Exchange |
| Botão "Nova Reunião" não aparece | usuário sem `PGCP.Assessoria`; conferir se a atribuição não ficou em *Default Access* |
| "Calendars.Read não concedida" ao abrir a Visão Geral | falta consentimento da permissão **delegada** |
| `Test-ServicePrincipalAuthorization` dá `True` na caixa de controle | escopo não está limitando; conferir `-CustomResourceScope` na atribuição |
| Evento criado na caixa errada | organizador errado na reunião, ou `ExternalDirectoryObjectId` divergente (§6) |
| Convidado não recebeu o convite | verificar o endereço do participante no PGCP — **não** é o escopo: convidado não precisa estar nele |

O código do erro distingue as camadas: `ErrorAccessDenied` vem do **Exchange**;
`Authorization_RequestDenied` vem do **Entra**.
