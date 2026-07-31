# Contrato na Conta Azul — regras de negócio e manual de operação

> Tudo que rege o pipeline **CRM → Conta Azul** da BGP: datas, imposto, Simples Nacional,
> NFS-e e as armadilhas que já custaram retrabalho. Escrito em 29/07/2026 depois de uma
> auditoria completa da base ativa (139 contratos) e da correção de 20 cadastros.
> **Leia antes de mexer em qualquer contrato, venda ou parcela na Conta Azul.**

---

## 1. O sistema

```
CRM (Supabase, BGPGO)  ──scan 30s──►  ca-push-service  ──►  Conta Azul
   Contract status=SIGNED               (Coolify)            cliente + contrato + setup
                                             │
                                             └──►  FinHub (ingest do cliente)
```

| Peça | Onde | Observação |
|---|---|---|
| `ca-push-service` | `C:\Projects\ca-push-service`, repo `BGPGO/ca-push-service`, branch `master` | Coolify uuid `s8t2hpve35ncuu9zkzolnd74`, `https://ca-push.187.77.238.125.sslip.io`. Push na master = deploy. |
| CA API **interna** | `services.contaazul.com`, header `X-Authorization` | Token de sessão do navegador (expira). Origin/Referer de `pro.contaazul.com`. É a API que a tela usa. |
| CA API **v2 oficial** | `api-v2.contaazul.com` via helper OAuth | `https://ca-oauth.187.77.238.125.sslip.io/api?path=/v1/...`, Basic auth com `ADMIN_TOKEN`. |
| Receita | `brasilapi.com.br/api/cnpj/v1/{cnpj}` | Fonte do Simples. Sem chave, tolera ~1 req/s. |

**Duas APIs, uma verdade só:** a interna e a v2 enxergam o mesmo dado, mas **não são
intercambiáveis** — cada campo tem um lado que funciona. Ver §4 e §9.

---

## 2. Datas do contrato

| Regra | Valor | Onde no código |
|---|---|---|
| **Data de início (vigência)** | = **data de assinatura** (`autentiqueSignedAt`) | `createScheduledSale`, `startDate` |
| **Competência (emissão)** | = **dia 01** do mês da 1ª parcela | `emissionDate` |
| **Competência e vencimento** | **no mesmo mês, sempre** | guarda que aborta a criação se divergir |
| **Cadência** | mensal, `saleEmissionDay: 1`, `expirationType: FOREVER` | `terms` |

**Exceção documentada:** quando a 1ª parcela é adiada para além do mês seguinte à assinatura
(assinou 23/06, 1ª parcela 10/08), a CA recusa a criação se o início não casar com a cadência.
Nesse caso o código usa a competência como início. Contrato sem cobrança é pior que vigência
no dia 01.

**A trava da emissão (importante):** a CA calcula sozinha qual deve ser a próxima emissão —
`previousEmissionDate + 1 mês` — e **recusa qualquer edição de contrato pela tela** se a venda
seguinte tiver outra competência: *"Data de emissão enviada com valor inválido, valor(es)
esperado(s) para as configurações: [2026-08-01]"*. O campo `previousEmissionDate` é do
servidor: PUT nele devolve 500. Ou seja, **não dá para pular um mês de competência** — quem
fizer isso trava a tela daquele contrato para sempre.

---

## 3. Imposto: quem retém o quê

O bloco fiscal (`serviceTaxInformation`) fica **congelado dentro de cada venda**, com a regra
textual de cada imposto. Quatro impostos importam:

| Imposto | Alíquota | Depende de quê |
|---|---|---|
| PIS + COFINS + CSLL | **4,65%** (0,65 + 3 + 1) | **do regime do cliente**: optante do Simples **não** retém |
| IRRF | **1,5%** | **do piso de R$ 10**: só retém se o imposto der ≥ R$ 10 (base ≥ R$ 666,67) |
| ISS | 5% | nunca retido (config do cadastro do serviço) |
| INSS | — | nunca retido |

Daí os quatro padrões de retenção que aparecem na base: **0% · 1,5% · 4,65% · 6,15%**.

A CA explica cada um em texto:
- *"Os impostos PIS, Cofins, CSLL não são aplicáveis a esta venda porque o cliente é Simples Nacional."*
- *"o imposto a recolher é inferior/superior a R$ 10,00, conforme configuração dos impostos."*
- *"não são aplicáveis... porque o cliente é pessoa física."* (PF é isenta de tudo)

**A calculadora** (pura, sem efeito colateral — a mesma que a tela chama):

```http
POST /invoice-tax-management/v1/calculate-taxes
{ "key": 1,
  "provider": { "taxationRegime": "NORMAL", "nationalPattern": true },
  "taker":    { "type": "LEGAL_PERSON",
                "taxationRegime": "NORMAL" | "SIMPLE_NATIONAL",
                "publicAgency": false },
  "service":  { "id": "<serviceIdNfse>", "values": { "base": 1850 },
                "provisionPlace": { "cityId": 7994 },
                "taxes": { "iss": { "roundingMode": "HALF_EVEN" } } } }
```

Devolve `values {base, retained, total}` + detalhe por imposto. **Use sempre isto para simular
antes de escrever.**

---

## 4. Simples Nacional

### Onde mora o flag

| Operação | Caminho | Detalhe |
|---|---|---|
| **LER** | interna `GET /contaazul-bff/person-registration/v1/persons/{uuid}` → `isOptingSimple` | **3 estados**: `true`, `false`, **campo ausente** |
| **ESCREVER** | v2 `PATCH /v1/pessoas/{id}` `{"optante_simples_nacional": true|false}` → 204 | |
| ❌ **NÃO LER** | v2 `GET /v1/pessoas/{id}` → `optante_simples_nacional` | devolve **`false` para TODOS**, sempre |

- **Campo ausente = não optante.** É assim que a CA calcula o imposto (comprovado: 10 de 10
  clientes com o campo ausente sofreram a retenção de 4,65%).
- Marcar como NÃO pela v2 **apaga o campo** em vez de gravar `false`. Efeito fiscal idêntico.
- **A CA não preenche esse campo sozinha.** Testado criando cliente com CNPJ optante: entrou
  `false` e ficou `false`. Quem enriquece é o nosso pipeline.

### A verdade (Receita, via BrasilAPI)

`opcao_pelo_simples` tem três leituras:

| Valor | Significa |
|---|---|
| `true` | optante **hoje** (vem `data_opcao_pelo_simples`, sem exclusão) |
| `false` | optou e **foi excluído** (vêm as duas datas) |
| `null` | **nunca** teve registro de opção |

Validado contra `publica.cnpj.ws` em 4 casos (3 nulos + 1 controle): bate 100%.

### Checagem automática

`ensureSimplesFlag(customerId, cnpj)` roda **em todo push**, para cliente novo **e reusado**:
lê o flag na interna, compara com a Receita, corrige pela v2 se divergir. Registra no audit
log como `ca_simples`. Se a Receita não responder, **aborta o push** — o contrato não é marcado
como processado e o scan retenta em 30s. Chutar o regime custa 4,65% em toda parcela.

### ⚠️ A BrasilAPI EXIGE `User-Agent` — sem ele, 429 sempre

A BrasilAPI responde **429 Too Many Requests** a qualquer requisição sem cabeçalho
`User-Agent`, **independente de volume**. O Node não manda um por padrão. Comprovado em
30/07/2026, mesmo IP e mesmo segundo: sem UA → 429; com `curl/8.5.0`, `Mozilla/5.0` ou
`ca-push-service/1.0` → 200. Com UA de biblioteca (`Python-urllib/3.12`, `node`) → 403.

Enquanto isso passou batido, `enrichCnpjBrasilApi` devolveu `null` em **100%** das chamadas
e **todo cliente criado pelo pipeline nasceu como não optante** — foi a origem das 20
divergências corrigidas na mão em 28/07 e do caso NATHAN ZANCHET (30/07, R$ 116,11/mês).
O `catch` mudo escondeu o 429 por dois dias: o log só dizia "Receita indisponível". Corrigido
em `6801421` (UA + 3 tentativas + log do motivo).

---

## 5. Como as vendas ficam no contrato

Um contrato (`scheduled-sale`) tem:

- **Template** — `GET /app/v1/scheduled-sales/{id}`: `terms`, `paymentCondition`,
  `serviceTaxInformation`, `autoTasks`, `previousEmissionDate`, `committedDate`.
- **~2 vendas `COMMITTED`** — já emitidas (a do mês e a seguinte). **Congeladas. Não mexer.**
- **~24 vendas `SCHEDULED`** — projeções já criadas, cada uma com **id próprio, bloco fiscal
  próprio e valor próprio**. São essas que se corrige.

Mudança de imposto **não** se propaga sozinha para as `SCHEDULED` já criadas: ou se edita uma a
uma pela API, ou se salva o contrato pela tela em "editar todas as próximas vendas".

---

## 6. Editar parcela sem quebrar

```http
PUT /app/v1/scheduled-sales/{schedId}/sales/{saleId}
```

⚠️ **A ARMADILHA MAIS CARA DESTE PROJETO:** o valor da parcela é recalculado como
`itens − valueComposition.serviceTaxTotal`. **O GET da venda devolve `valueComposition` SEM o
`serviceTaxTotal`.** Copiar o que veio do GET e mandar de volta **zera a retenção** e a parcela
passa a cobrar o valor cheio. Foi assim que 99 parcelas de 4 clientes passaram a cobrar
R$ 5.022,75 a mais, e o sintoma é silencioso: o bloco fiscal continua dizendo que retém.

**Corpo mínimo correto:**

```js
valueComposition: { shipping: 0, discount: { value: 0, type: 'VALUE' },
                    serviceTaxTotal: serviceTaxInformation.values.retained }
```

Mais: `emissionDate` (a competência atual — o GET devolve `null` em venda SCHEDULED, então
mande explicitamente), `paymentCondition` do GET, `saleItems` de
`/search-engine-core/v1/sales/{id}/items`, `version`, `autoTasks` do GET, `serviceTaxInformation`.

**Depois de todo PUT, conferir os TRÊS:** valor, competência e vencimento. O valor só sai em
`POST /contaazul-bff/sale/v1/sales/searches` (campo `total`) — o GET da venda não devolve.

---

## 7. NFS-e automática (`autoTasks`)

| Na tela | No JSON |
|---|---|
| "Todo dia 1, enviar automaticamente os detalhes" | `sendInvoice` |
| "Gerar e enviar a **cobrança** automaticamente" | `issueAndSendBilling` |
| "Emitir e enviar a **NFS-e** automaticamente" | `serviceInvoice.active` |
| "Assim que a venda for gerada" | `serviceInvoice.triggerType: "SALE_GENERATION"` |
| "Apenas quando identificarmos o pagamento" | `serviceInvoice.triggerType: "PAYMENT_IDENTIFICATION"` |
| E-mails | `emailsReceiveInvoice[]` |
| Lembretes | `sendReminder` |

Regra da casa: **recorrência** emite na geração da venda; **venda avulsa (setup)** só quando o
pagamento for identificado.

### O que a CA grava, de verdade (medido 30/07/2026)

⚠️ **Não audite esse campo lendo os contratos reais** — a financeira edita os flags na mão, e o
estado de hoje não prova nada sobre como o contrato nasceu. O jeito certo é criar contrato
descartável → ler na hora → apagar (`DELETE /app/v1/scheduled-sales/{id}` funciona).

| Payload enviado no POST | `active` gravado | `triggerType` gravado |
|---|---|---|
| chave `serviceInvoice` ausente | **false** | SALE_GENERATION |
| `{}` | **false** | SALE_GENERATION |
| `{active:true}` | true | SALE_GENERATION (default) |
| `{active:true, triggerType:'SALE_GENERATION'}` | true | SALE_GENERATION |
| `{active:true, triggerType:'PAYMENT_IDENTIFICATION'}` | true | PAYMENT_IDENTIFICATION |

- `{}` faz o contrato **nascer com a emissão desligada** — era o que obrigava a marcar na mão.
- `triggerType` **é respeitado**; os dois enums funcionam.
- `issued` é **só leitura** (status "já emitida"): sempre volta `false` na criação. Não mandar.
- `sendReminder` volta `false` mesmo mandando `true` — é configuração de conta, não nossa.
- **Não dá pra consertar depois pela API**: PUT devolve 400 (`saleItems` não vem no GET) e, mesmo
  com `saleItems` explícitos, 500. Contrato que nasceu errado só se conserta pela tela.

### O que trava a automação de NFS-e

A CA exige, no cadastro do cliente: **razão social, CNPJ, endereço, telefone e e-mail**. Em
28/07/2026, dos 139 ativos, **6 estavam travados e todos pelo mesmo campo: telefone**.

Origem de cada dado no CRM:

| Campo na CA | Vem de | Cobertura |
|---|---|---|
| Razão social, CNPJ | `Contract.razaoSocial`, `Contract.cnpj` | ok |
| E-mail | `Contract.emailFinanceiro` / `emailRepresentante` | ok |
| **Telefone** | `Deal.contactId → Contact.phone` (o scan já traz) | falha quando **o Deal não tem contato vinculado** |
| **Endereço** | `Contract.cep/logradouro/numeroEndereco/bairro/cidade/estado` | **14%** preenchido. O texto livre `Contract.endereco` está em 68% |

O endereço estruturado é **obrigatório** na criação pela v2 (cep + logradouro + número), e sem
ele o contrato assinado simplesmente não aparece na CA.

---

## 8. Armadilhas — a lista de não-faça

1. **Não copie `valueComposition` do GET** para um PUT. Falta o `serviceTaxTotal`. (§6)
2. **Não leia o Simples pela v2.** Devolve `false` para todos. (§4)
3. **Não trate "campo ausente" como bug** — é o terceiro estado, e vale como não optante.
4. **Não alinhe competência de parcela de venda parcelada.** Descrição `3/7 - Venda 2586` é
   parcela, não venda: uma venda, uma competência, N vencimentos. Alinhar joga a receita para
   o mês do pagamento.
5. **Não pule mês de competência.** Trava a edição do contrato pela tela para sempre. (§2)
6. **Não mexa em venda `COMMITTED`** nem em nota já emitida.
7. **Não confie só na competência depois de um PUT** — confira o valor também. (§6)
8. **Não crie contrato de teste com automação ligada.** Emite boleto e nota fiscal de verdade.
9. **`emissionDate` volta `null`** em venda SCHEDULED no GET. Não é apagamento; mande o valor
   explicitamente no PUT.

---

## 9. Referência rápida de endpoints

| O quê | Chamada |
|---|---|
| Buscar cliente por CNPJ | `GET /contaazul-bff/person-registration/v2/persons?search_term={cnpj}&profile_type=CUSTOMER&recover_legacy_id=true&textual_search_only=true` |
| Cadastro do cliente (com Simples) | `GET /contaazul-bff/person-registration/v1/persons/{uuid}` |
| Criar cliente (interna) | `POST /contaazul-bff/person-registration/v1/persons` |
| Criar cliente (v2) | `POST /v1/pessoas` |
| Corrigir Simples | `PATCH /v1/pessoas/{id}` `{optante_simples_nacional}` |
| Listar contratos | `POST /contaazul-bff/sale/v1/scheduled-sales/searches?page=N&page_size=50` |
| Contrato (template) | `GET /app/v1/scheduled-sales/{id}` |
| Criar contrato | `POST /app/v1/scheduled-sales/` |
| Apagar contrato | `DELETE /app/v1/scheduled-sales/{id}` |
| Venda do contrato | `GET|PUT /app/v1/scheduled-sales/{schedId}/sales/{saleId}` |
| Buscar vendas (traz `total`) | `POST /contaazul-bff/sale/v1/sales/searches` `{searchTerm}` |
| Itens da venda | `GET /search-engine-core/v1/sales/{id}/items?page=1&page_size=300` |
| Calcular imposto | `POST /invoice-tax-management/v1/calculate-taxes` |
| Toggles de e-mail/NFS-e | `GET /app/v2/scheduled-sales/{id}/auto-tasks` (só leitura) |
| Extrato completo (XLSX) | `POST /finance-pro-reports/v1/financial-statement-view/export` `{"quickFilter":"ALL"}` |
| Excluir pessoa (v2) | `POST /v1/pessoas/excluir` `{"uuids": ["..."]}` ← o campo é `uuids` |

---

## 10. Estado da base em 28/07/2026

- **139 contratos ativos** (`status ENABLED`).
- **Simples: 0 divergências.** 71 optantes marcados, 54 não optantes desmarcados, 14 não
  optantes com o campo em branco (equivale a desmarcado).
- **20 cadastros corrigidos** naquele dia (14 viraram optantes, 6 deixaram de ser) e **407
  parcelas futuras recalculadas**. Efeito: +R$ 701/mês de um lado, −R$ 108/mês do outro.
- **85 parcelas não puderam ser ajustadas** — vendas **sem bloco fiscal**
  (`serviceTaxInformation` ausente): contratos **223 VERSATTO, 79 FUT3, 255 LIRA-SAT** inteiros,
  mais caudas de 512 Fronteira, 458 Alicerce, 516 Valoriza, 89 Studio 360, 398 Barleys.
  Corrigir exige **criar** o bloco onde nunca existiu.
- **7 clientes micro/EPP sem registro de opção** na Receita (MANFAC, Saúde Master, Compre Mais
  Leme, SMX, FAV, Atena, Armazém das Miudezas) — confirmar com a contabilidade.
- Planilha: `Downloads\simples-nacional-comparativo-2026-07-28.xlsx`.

---

## 11. Pendências abertas

1. **Enum do gatilho de NFS-e da venda avulsa** — precisa de um HAR da tela. (§7)
2. **85 parcelas sem bloco fiscal** — decidir se cria o bloco. (§10)
3. **Deal sem contato vinculado** no CRM — impede o telefone de chegar e trava a NFS-e. (§7)
4. **Endereço estruturado em 14% dos contratos** — derivar do texto livre no push. (§7)
5. **4 contratos com competência desalinhada da cadência** (512, 544, 546, 547, 548) — a edição
   pela tela segue recusada neles. (§2)
