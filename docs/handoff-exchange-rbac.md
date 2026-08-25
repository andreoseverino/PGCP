# Handoff — Exchange Online RBAC for Applications (calendário do PGCP)

**Para:** administração do Exchange Online / Microsoft 365
**De:** projeto PGCP — Plataforma Corporativa de Gestão de Pautas
**Assunto:** autorizar a API do PGCP a criar e atualizar eventos de calendário
em um conjunto **restrito** de caixas, para homologação

> Este documento não contém segredo algum e não deve receber nenhum. Não inclua
> aqui client secret, token, senha ou certificado.

---

## 1. O que está sendo pedido — e o que **não** está

| | |
|---|---|
| ✅ Pedido | Papel **`Application Calendars.ReadWrite`** atribuído ao service principal do PGCP **no Exchange Online**, limitado por um **Resource Scope** |
| ❌ **Não** pedido | `Calendars.ReadWrite` (Application) no **App Registration do Entra** |

> **Nota — há duas capacidades de calendário, e só uma é assunto deste handoff.**
>
> **A. Ler o próprio calendário** (todos os usuários): `Calendars.Read`
> **Delegated**, no App Registration, por On-Behalf-Of. A pessoa está na sessão e
> só alcança a própria caixa — não passa pelo Exchange RBAC e **não** é pedido
> aqui.
>
> **B. Criar/alterar evento em calendário de terceiro** (esta solicitação):
> `Application Calendars.ReadWrite` pelo Exchange RBAC, com Resource Scope.

Esta distinção é o ponto central do handoff.

### Quem é quem — e por que a caixa a autorizar é a do organizador

O PGCP separa três papéis que **não** são a mesma pessoa:

| Papel | Quem é | Onde é controlado |
|---|---|---|
| **Ator** | quem opera o sistema e cadastra a reunião | App Role `PGCP.Assessoria`, no Entra |
| **Organizador** | pessoa em cuja caixa o evento é criado | **Resource Scope do Exchange** |
| **Convidado** | quem recebe o convite | não exige autorização alguma |

O caso real: **a assessora cadastra a reunião do Presidente.** A assessora é o
ator; o Presidente é o organizador. O evento nasce no calendário **dele**, com
ele como *organizer* Microsoft.

> **Consequência direta para esta configuração.** A caixa que entra no Resource
> Scope é a **do organizador** — o Presidente, o Diretor, quem terá a reunião na
> própria agenda. **Não** é a caixa de quem opera o PGCP.
>
> Autorizar a caixa da assessora não faria a integração funcionar: o PGCP não
> escreve na agenda dela.

Na prática, **o Resource Scope é o que define quem pode ser escolhido como
organizador**. A tela oferece o diretório inteiro, mas só as caixas dentro do
escopo aceitam o evento — qualquer outra é recusada pelo Exchange, e o PGCP
mostra a falha honestamente em vez de fingir que o convite saiu.

As duas autorizações são **aditivas**. Um grant tenant-wide no Entra passaria por
cima do Resource Scope do Exchange e devolveria à aplicação acesso a **todas** as
caixas do tenant — exatamente o que o escopo existe para impedir. Por isso o
consentimento no App Registration **não deve ser concedido**, nem agora nem
depois.

### Estado verificado do App Registration

Inspeção do service principal feita pelo projeto (leitura, sem alteração):

| Verificação | Resultado |
|---|---|
| Service principal no Entra | existe |
| Papéis de aplicação concedidos | **exatamente 1**, correspondente a `User.Read.All` |
| `Calendars.ReadWrite` (Application) no Entra | **não concedida** |
| `GET /users/{id}/calendar` hoje | `403 ErrorAccessDenied` |

`User.Read.All` é o que sustenta a busca no **diretório corporativo** e **não deve
ser alterada** por este handoff. Diretório e calendário são capacidades
diferentes.

---

## 2. Identificadores necessários

Substituir os placeholders pelos valores reais do tenant. **Nenhum valor real
aparece neste documento.**

| Placeholder | O que é | Onde obter |
|---|---|---|
| `<APP-ID>` | Application (client) ID do App Registration **PGCP API** | Portal Entra → App registrations → PGCP API → *Application (client) ID*. É o mesmo valor da variável `ENTRA_API_CLIENT_ID` do backend |
| `<SP-OBJECT-ID>` | Object ID do **service principal** (enterprise application), não do App Registration | Portal Entra → Enterprise applications → PGCP API → *Object ID* |
| `<MAILBOX-HOMOLOG>` | endereço da caixa **de teste** autorizada para a homologação | definido pela governança |
| `<MAILBOX-ENTRA-OBJECT-ID>` | **Object ID no Microsoft Entra** da caixa de homologação — é ele que entra no filtro do escopo | Portal Entra → Users → a conta de `<MAILBOX-HOMOLOG>` → *Object ID*. No Exchange, é o `ExternalDirectoryObjectId` do destinatário |
| `<MAILBOX-CONTROLE>` | endereço de uma caixa **fora** do escopo, usada só para provar que o limite funciona | definido pela governança |
| `<SCOPE-NAME>` | nome do Resource Scope a criar | sugestão: `PGCP-Calendario-Homologacao` |
| `<SP-NAME>` | nome do service principal no Exchange | sugestão: `PGCP-API` |

> Atenção ao `<SP-OBJECT-ID>`: é o Object ID da **enterprise application**
> (service principal), que é diferente do Object ID do App Registration. Trocar
> os dois é a causa mais comum de falha nesta configuração.

---

## 3. Passos

Executar em uma sessão do **Exchange Online PowerShell** com privilégio
administrativo.

### 3.1 Registrar o service principal no Exchange Online

O Exchange mantém sua própria referência ao service principal do Entra.

```powershell
# Já existe?
Get-ServicePrincipal -Identity "<APP-ID>"

# Se não existir, criar a referência:
New-ServicePrincipal `
  -AppId    "<APP-ID>" `
  -ObjectId "<SP-OBJECT-ID>" `
  -DisplayName "<SP-NAME>"
```

### 3.2 Confirmar a identidade da caixa

O filtro do escopo usa o **Object ID do Entra**, não o endereço. Antes de criar o
escopo, confirmar que o ID resolve para a caixa esperada:

```powershell
Get-Mailbox -Identity "<MAILBOX-HOMOLOG>" |
  Format-List DisplayName, PrimarySmtpAddress, ExternalDirectoryObjectId
```

O `ExternalDirectoryObjectId` devolvido deve ser exatamente
`<MAILBOX-ENTRA-OBJECT-ID>`. Se divergir, **parar** e resolver a divergência
antes de seguir — um escopo apontando para o objeto errado autoriza a caixa
errada.

### 3.3 Criar o Resource Scope

O escopo define **quais caixas** a aplicação pode alcançar. Para a homologação,
**uma única caixa**.

```powershell
New-ManagementScope `
  -Name "<SCOPE-NAME>" `
  -RecipientRestrictionFilter "ExternalDirectoryObjectId -eq '<MAILBOX-ENTRA-OBJECT-ID>'"
```

> **Por que não `PrimarySmtpAddress`.** A documentação da Microsoft alerta que um
> filtro por `PrimarySmtpAddress` também casa com endereços presentes em
> `EmailAddresses` — inclusive **aliases**. Um alias criado depois, ou herdado de
> outra caixa, ampliaria o escopo silenciosamente, sem que ninguém tenha mudado a
> regra. `ExternalDirectoryObjectId` é a identidade do objeto no diretório: não
> tem alias, não muda quando o endereço muda, e é o mesmo identificador que o
> PGCP já usa para localizar o organizador (`users.entra_object_id`).
>
> O endereço continua útil — para os comandos de teste abaixo e para identificação
> humana. O que ele não deve ser é a chave do filtro.

> Para produção, o filtro provavelmente passará a ser por grupo, departamento ou
> atributo customizado — decisão da governança corporativa, **não** deste
> handoff. Não ampliar agora.

### 3.4 Atribuir o papel, limitado ao escopo

```powershell
New-ManagementRoleAssignment `
  -Role "Application Calendars.ReadWrite" `
  -App  "<APP-ID>" `
  -CustomResourceScope "<SCOPE-NAME>" `
  -Name "PGCP-Calendars-ReadWrite-Homologacao"
```

O papel **`Application Calendars.ReadWrite`** é o mínimo necessário: a aplicação
cria e atualiza o evento na caixa do organizador. Não é preciso papel de leitura
de correio, envio de e-mail ou acesso a caixas compartilhadas.

### 3.5 Provar o escopo — os **dois** testes

Ambos os resultados importam. Configuração validada só com os dois.

```powershell
# POSITIVO — deve retornar InScope = True
Test-ServicePrincipalAuthorization `
  -Identity "<APP-ID>" `
  -Resource "<MAILBOX-HOMOLOG>"

# NEGATIVO — deve retornar InScope = False
Test-ServicePrincipalAuthorization `
  -Identity "<APP-ID>" `
  -Resource "<MAILBOX-CONTROLE>"
```

Uma configuração em que a caixa de homologação funciona **mas a de controle
também** não está validada: significa que o escopo não está limitando nada.

---

## 4. O que devolver ao projeto

Basta confirmar, sem anexar segredo:

- [ ] Service principal registrado no Exchange Online
- [ ] `ExternalDirectoryObjectId` de `<MAILBOX-HOMOLOG>` conferido e igual a `<MAILBOX-ENTRA-OBJECT-ID>`
- [ ] Resource Scope `<SCOPE-NAME>` criado, filtrando por `ExternalDirectoryObjectId` e contendo **apenas** essa caixa
- [ ] Papel `Application Calendars.ReadWrite` atribuído com `-CustomResourceScope`
- [ ] `Test-ServicePrincipalAuthorization` em `<MAILBOX-HOMOLOG>` → **InScope = True**
- [ ] `Test-ServicePrincipalAuthorization` em `<MAILBOX-CONTROLE>` → **InScope = False**
- [ ] Confirmado que **nenhum** consentimento de `Calendars.ReadWrite` foi concedido no App Registration

Informar também qual foi a `<MAILBOX-HOMOLOG>` e o `<MAILBOX-ENTRA-OBJECT-ID>`
correspondente. É por esse Object ID que o PGCP endereça a caixa
(`meetings.organizer_entra_object_id`) — o mesmo identificador do filtro do
escopo, o que faz os dois lados concordarem sobre quem é a pessoa.

**O organizador não precisa ter conta no PGCP.** A identidade dele é a
Microsoft; ter usado o sistema alguma vez é irrelevante para receber a reunião
na própria agenda. Se a reunião de homologação apontar para outra caixa, a
sincronização será legitimamente recusada pelo escopo — que é exatamente o
comportamento desejado.

---

## 5. Limites desta autorização

`Test-ServicePrincipalAuthorization` valida a autorização **do Exchange RBAC**.
A ausência de `Calendars.ReadWrite` tenant-wide **no Entra** é verificada
separadamente, por inspeção do service principal — as duas checagens são
independentes e nenhuma substitui a outra.

**Duas autorizações independentes, e nenhuma substitui a outra:**

| | Controla | Onde | Situação |
|---|---|---|---|
| **`PGCP.Assessoria`** (App Role) | *quais **usuários** podem mandar o PGCP agir* — criar reunião, sincronizar, ressincronizar e, no futuro, cancelar | Entra, Enterprise Application do PGCP API | ✅ **em vigor e validado** |
| **Resource Scope** (Exchange RBAC) | *quais **caixas** a aplicação alcança* — logo, quem pode ser organizador | Exchange Online | ⏳ esta solicitação |

Um usuário com `PGCP.Assessoria` e um organizador fora do escopo → o Exchange
recusa. Um organizador dentro do escopo e um usuário sem o papel → o PGCP recusa
antes de chegar ao Exchange. As duas barreiras valem ao mesmo tempo.

`Test-ServicePrincipalAuthorization` valida apenas a segunda.

**Esta configuração é de homologação, não de produção.** Ampliar o escopo é
decisão da governança corporativa, tomada depois que o smoke test provar o
comportamento.

---

## 6. Depois da confirmação

O projeto executará um smoke test controlado:

1. reunião criada exclusivamente para homologação, cadastrada por um usuário
   com `PGCP.Assessoria` e com **organizador `<MAILBOX-HOMOLOG>`** — provando,
   na mesma operação, que ator e organizador podem ser pessoas diferentes
2. sincronização, verificando evento, *organizer* Microsoft, horário, fuso,
   local e convidados
3. alteração de um campo e ressincronização, provando que o **mesmo** evento é
   atualizado e que **não** nasce um segundo

Nenhum evento foi criado até aqui.
