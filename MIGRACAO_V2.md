# Migração ca-push-service → API v2 oficial da Conta Azul

> Status: **spec / plano** (16/06/2026). Nada implementado ainda.
> Princípio: migrar pra API oficial v2 (`api-v2.contaazul.com`, OAuth via helper `ca-oauth-app`) tudo que dá sem gambiarra; deixar na API interna X-Auth (`services.contaazul.com`) só o que a v2 não suporta.
> Referência da API v2: `C:\Projects\ca-oauth-app\CONTA_AZUL_API_V2.md`.

---

## 1. Escopo: o que migra e o que fica

| Operação (hoje, interna X-Auth) | Decisão | Destino v2 oficial |
|---|---|---|
| `findCustomerByCnpj` — `GET /contaazul-bff/person-registration/v2/persons?search_term=` | **MIGRA** | `GET /v1/pessoas?busca={cnpj}&tipo_perfil=Cliente` |
| `createCustomer` — `POST /contaazul-bff/person-registration/v1/persons` | **MIGRA** | `POST /v1/pessoas` (+ `PATCH /v1/pessoas/{id}` p/ correção) |
| enrich endereço/Simples | **NOVO** | BrasilAPI `GET /cnpj/v1/{cnpj}` |
| `nextContractNumber` — `GET /app/v1/scheduled-sales/next-number` | **MIGRA** | `GET /v1/contratos/proximo-numero` |
| `createScheduledSale` — `POST /app/v1/scheduled-sales/` | **MIGRA** | `POST /v1/contratos` |
| nº venda avulsa — `GET /app/v1/negotiations/next-number` | **MIGRA** | `GET /v1/venda/proximo-numero` |
| `createSetupSale` — `POST /app/v1/sales/` | **MIGRA** | `POST /v1/venda` |
| `applyDiscountToFirstN` — `PUT /app/v1/scheduled-sales/{id}/sales/{sid}` | **MIGRA** | `PUT /v1/venda/{id}` ou `PATCH /v1/financeiro/eventos-financeiros/parcelas/{id}` (exigem `versao`) |
| `updateScheduledSaleForUpsell` — `PUT /app/v1/scheduled-sales/{id}` | **FICA NA INTERNA** | v2 não tem update/PATCH de contrato (só GET/POST/DELETE/encerrar). Vale p/ upsell de valor E de troca de produto. |
| `calcTaxes` — `POST /invoice-tax-management/v1/calculate-taxes` | **REMOVE** | v2 não exige pré-cálculo; ERP calcula no faturamento |
| `autoTasks` (auto NFSe/boleto/lembrete) | **REMOVE** | usa config padrão da conta CA (validar 1x que está ligada) |

---

## 2. De-para de campos

### 2.1 Cliente — `POST /v1/pessoas`
| Interna | v2 |
|---|---|
| `legalDocument` | `cnpj` |
| `personType:"Jurídica"` | `tipo_pessoa:"Jurídica"` |
| `name` | `nome` |
| `code` | `codigo` |
| `isActive` | `ativo` |
| `isOptingSimple` | `optante_simples` ← **enrich BrasilAPI** |
| `companyName` | `nome_fantasia` |
| `commercialPhone` / `cellPhone` | `telefone_comercial` / `telefone_celular` |
| `profiles:[{profileType:"Cliente"}]` | `perfis:[{tipo_perfil:"Cliente"}]` |
| `billingContact.emails` | `contato_cobranca_faturamento.emails` ← **imperativo** |
| `address:[]` (vazio hoje!) | `enderecos:[{cep,logradouro,numero,complemento,bairro,cidade,estado,pais}]` ← **enrich BrasilAPI** |
| `origin`/`doDuplicate`/`attachments`/`idContactPrincipal` | (descartar) |

### 2.2 Recorrente — `POST /v1/contratos`
| Interna | v2 |
|---|---|
| `customerId` | `id_cliente` |
| `terms.number` | `termos.numero` |
| `terms.frequencyType:"MONTH"` | `termos.tipo_frequencia:"MENSAL"` |
| `terms.frequencyRange:1` | `termos.intervalo_frequencia:1` |
| `terms.expirationType:"FOREVER"` | `termos.tipo_expiracao:"NUNCA"` (+ `data_fim` ainda obrigatório) |
| `terms.startDate` | `termos.data_inicio` |
| `terms.saleEmissionDay` | `termos.dia_emissao_venda` |
| `categoryId`/`costCenterId`/`ownerId` | `id_categoria`/`id_centro_custo`/`id_vendedor` |
| `paymentCondition.paymentType:"BANKING_BILLET"` | `condicao_pagamento.tipo_pagamento:"BOLETO_BANCARIO"` |
| `paymentCondition.financialAccountId` | `condicao_pagamento.id_conta_financeira` |
| `paymentCondition.dueDay` | `condicao_pagamento.dia_vencimento` |
| `paymentCondition.firstDueDate` | `condicao_pagamento.primeira_data_vencimento` ← **FIX #1** |
| `saleItems[{id,amount,value}]` | `itens[{id,quantidade,valor}]` |
| `valueComposition.discount{value,type:"VALUE"}` | `composicao_de_valor.desconto{valor,tipo:"VALOR"}` |
| `autoTasks`/`serviceTaxInformation`/`chargeRequestMetadata`/`emissionDate`/`costCenterBySale` | (descartar — config da conta) |

### 2.3 Setup avulsa — `POST /v1/venda`
| Interna | v2 |
|---|---|
| `customerId` | `id_cliente` |
| `number` | `numero` |
| `committedDate` | `data_venda` |
| `situation:"APPROVED"` | `situacao:"APROVADO"` |
| `paymentCondition.paymentConditionOption:"À vista"` | `condicao_pagamento.opcao_condicao_pagamento:"À vista"` |
| `paymentCondition.installments[{dueDate,value}]` | `condicao_pagamento.parcelas[{data_vencimento,valor}]` |
| `operationNatureId` / `serviceTaxInformation` | (descartar) |

> ⚠️ Enum de pagamento muda de nome: interna `BANKING_BILLET` → v2 `BOLETO_BANCARIO`. E os enums de PIX/link diferem entre venda (`PIX_COBRANCA`) e contrato (`COBRANCA_PIX`) na v2.

---

## 3. Os 4 fixes

### FIX #1 — Data da 1ª parcela ⚠️ (precisa de campo no CRM)
- **Bug atual:** `createScheduledSale` usa `firstDayNextMonth(autentiqueSignedAt)` + `diaVencimento`, ignorando a data que o comercial definiu.
- **Evidência (Papel para Mechas, contract `cmppvychx00w1bqsxw5h7sd5z`):** a 1ª parcela real é **12/07/2026**, escrita só na prosa de `observacao` ("Os pagamentos iniciam-se a partir do dia 12/07/2026"). `dataInicio` defaultou pra 29/05 (= assinatura). Código atual geraria 12/06 — **errado por 1 mês**.
- **Causa raiz:** **não existe campo estruturado de "data da 1ª parcela / início da cobrança"** no CRM (`Contract.dataInicio` defaulta `new Date()` em `contracts.ts:77`).
- **DECISÃO PENDENTE:**
  - (A) **Recomendado:** adicionar campo estruturado no CRM (datepicker "Início da cobrança / 1ª parcela") no `ContractGenerator` + schema `Contract` → ca-push lê e manda em `primeira_data_vencimento`.
  - (B) **Interino:** parsear `observacao` por regex (`/pagamentos? iniciam.{0,20}dia (\d{2}\/\d{2}\/\d{4})/i`), fallback `dataInicio`+`diaVencimento`. Frágil.

### FIX #2 — Endereço (IMPERATIVO p/ faturar)
- **Bug atual:** `createCustomer` envia `address:[]` vazio (só texto na `observation`). CRM só tem `endereco` string livre.
- **Fix:** enrich **BrasilAPI `/cnpj/v1/{cnpj}`** → `enderecos:[{cep,logradouro,numero,bairro,municipio→cidade,uf→estado,pais:"Brasil"}]`. Se enrich falhar → **bloquear + marcar cadastro manual** (sem endereço não gera cobrança).

### FIX #3 — Email do financeiro (IMPERATIVO p/ cobrança)
- **Bug atual:** `Contract.emailFinanceiro` é nullable; cai pra `emailRepresentante` (errado).
- **Fix:** `contato_cobranca_faturamento.emails:[emailFinanceiro]`; **validar presença** — se faltar, bloquear/avisar (não usar representante como cobrança).

### FIX #4 — Optante pelo Simples
- **Bug atual:** hardcoded `isOptingSimple:false`.
- **Fix:** BrasilAPI `/cnpj/v1/{cnpj}` → `opcao_pelo_simples` → `optante_simples`.

### Fora de escopo agora
- **CEP:** validação ignorada por ora (decisão Thomas). O endereço vem do enrich BrasilAPI, que já traz CEP.
- **Desconto promocional:** já estruturado no `DealProduct` (`discount`/`discountMonths` sobre `recurrenceValue`) — `applyDiscountToFirstN` tem fonte boa; migra via `PUT /v1/venda/{id}` nas N primeiras geradas.

---

## 4. Risco de costura (validar ANTES de codar)
O contrato passará a nascer na **API oficial v2**, mas o **upsell continua na interna**. Validar que `findScheduledSaleByCustomer` / `updateScheduledSaleForUpsell` (interna, buscam por cliente em `services.contaazul.com`) **enxergam** contratos criados via `POST /v1/contratos` oficial (mesma conta CA; IDs oficiais ≠ IDs internos). Se não enxergar, definir a ponte (ex.: buscar por CNPJ/cliente na interna).

## 5. Ordem de execução
1. Este doc (✓).
2. Validar a costura do §4 (read-only).
3. Resolver decisão do FIX #1 (campo no CRM vs regex).
4. Refatorar `server.js` em branch nova (createCustomer/createScheduledSale/createSetupSale + enrich BrasilAPI), sem tocar no upsell interno. Sem deploy até revisão.
