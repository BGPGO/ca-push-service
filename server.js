#!/usr/bin/env node
// CA Push Service — recebe Contract data e cria cliente+contrato+setup na Conta Azul Pro.
// Single-file, zero-deps Node. Deployavel no Coolify.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');

const PORT = parseInt(process.env.PORT || '5455', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const CA_XAUTH = process.env.CA_XAUTH || '';
const CA_BASE = 'https://services.contaazul.com';
const ORIGIN = 'https://pro.contaazul.com';

// CRM Supabase (origem dos dados do contrato assinado)
const CRM_SUPABASE_URL = process.env.CRM_SUPABASE_URL || 'https://gqjgbwzxlqkwvrtorhvb.supabase.co';
const CRM_SERVICE_KEY = process.env.CRM_SERVICE_KEY || '';

// FinHub Supabase (cria cliente final via edge function create-client)
const FINHUB_SUPABASE_URL = process.env.FINHUB_SUPABASE_URL || 'https://pbtheffdoebfryttkyge.supabase.co';
const FINHUB_SERVICE_KEY = process.env.FINHUB_SERVICE_KEY || '';

// Gate desativado em produção. Pra ativar de novo, set TESTE_KEYWORD env (vazio = sem gate).
const TESTE_KEYWORD = (process.env.TESTE_KEYWORD || '').toLowerCase();

// Kill switch: se 'true', /scan retorna sem processar nada (preserva tudo, só skip).
const KILL_SWITCH = String(process.env.KILL_SWITCH || '').toLowerCase() === 'true';

// Background scan interval (segundos). 0 = desativado.
const SCAN_INTERVAL_SEC = parseInt(process.env.SCAN_INTERVAL_SEC || '0', 10);

// Cria a venda avulsa de SETUP automaticamente no /scan (com idempotência durável via
// findSetupSaleByCustomer). DEFAULT OFF: a CA NÃO permite DELETE de venda avulsa via API,
// então deixamos um humano ligar isso explicitamente (SETUP_AUTOCREATE=true) depois de revisar.
// Com OFF, mantém o comportamento atual (só loga pendente) mas já reporta se o setup JÁ existe.
const SETUP_AUTOCREATE = String(process.env.SETUP_AUTOCREATE || '').toLowerCase() === 'true';

// Default seller (Josi) + financial account (Conta PJ CA IP) + cidade Porto Alegre
const DEFAULTS = {
  sellerId: '36f44a62-2517-461f-b3d6-b8a745608740',
  financialAccountId: '5ffcc22f-522d-467d-a903-f1081590c642',
  cityId: 7994,
  serviceIdNfse: '4cc68c92-4988-4e04-b416-920738b22f3d',  // 1 CONTROLADORIA
  operationNatureIdAvulsa: '0b5e717c-7c88-11ed-b89e-3fead1bf7ff9',
};

// Mapeamento produto BGP -> (categoryId, costCenterId)
const PRODUCT_MAP = {
  'bgp-go-i': { cc: 'f7d9af16-37fd-11f0-abc8-675aacdf1411', cat: '62acd13c-d0a6-4935-b234-8bc2c6e2890c' },
  'bgp-go-ii': { cc: '02f937d6-37fe-11f0-9b6c-671ef509b492', cat: '62acd13c-d0a6-4935-b234-8bc2c6e2890c' },
  'bgp-go-iii': { cc: '0f8b1cc6-37fe-11f0-bf12-4f0c48fc1e3e', cat: '62acd13c-d0a6-4935-b234-8bc2c6e2890c' },
  'bgp-bi': { cc: '3b5f86a0-d9b0-11ee-a7fd-579af0a23ded', cat: 'b4387188-29c7-4906-9345-35bf7b66f515' },
  'bgp-bi-personalizado': { cc: 'd6298da0-37fd-11f0-a011-afb236fae052', cat: 'b4387188-29c7-4906-9345-35bf7b66f515' },
  'bi-personalizado': { cc: 'd6298da0-37fd-11f0-a011-afb236fae052', cat: 'b4387188-29c7-4906-9345-35bf7b66f515' },
  'bgp-strategy': { cc: 'b9958064-fb44-11ee-bf23-738a7691524e', cat: 'e748c192-2b5e-437f-877a-3739d145bd20' },
  'bgp-valuation': { cc: '1ac117e4-37fe-11f0-9c0c-4f3d632514d2', cat: 'a882d0ea-5f90-422c-b613-6e6cb71f0260' },
  'brand-growth': { cc: '396de6fa-d05a-11f0-a205-f7c9cebf091f', cat: '7ca280ae-c469-4ff4-b2ae-e59099f45395' },
  'go-aimo': { cc: 'ac220d00-2160-11f1-977a-2ba7c1fffab6', cat: 'a66f45bf-8600-4640-9a97-ebe9f4b63e29' },
  'gestao-condominial': { cc: '4dc1ef9e-3b26-11f0-ac84-4f62813feeba', cat: 'd3464540-e64c-4494-9025-99ff5c7d001e' },
};

// Mapeamento email vendedor -> ID na CA
const SELLER_MAP = {
  'josi@bertuzzipatrimonial.com.br': '36f44a62-2517-461f-b3d6-b8a745608740',
  'vitor@bertuzzipatrimonial.com.br': 'b9a88f38-bef8-4b40-841d-a079217d10d8',
  'joao.lopes@bertuzzipatrimonial.com.br': 'd986925d-f693-4f6f-bf55-7f0a42504cfe',
  'mavi@bertuzzipatrimonial.com.br': 'b415a0c6-e81f-4c93-b567-9833f7fb801f',
  'fernanda@bertuzzipatrimonial.com.br': 'e0db37dd-4f4e-4ec4-b209-86d5a953f7d2',
};

// ---------- HTTP helpers ----------
function caRequest(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(CA_BASE + urlPath);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''),
      method,
      headers: {
        'X-Authorization': CA_XAUTH,
        'Origin': ORIGIN,
        'Referer': ORIGIN + '/',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
        'Content-Type': 'application/json',
      },
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let raw = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc.includes('gzip')) raw = zlib.gunzipSync(raw);
          else if (enc.includes('deflate')) raw = zlib.inflateSync(raw);
        } catch {}
        const text = raw.toString('utf-8');
        let json;
        try { json = text ? JSON.parse(text) : null; } catch { json = text; }
        resolve({ status: res.statusCode, body: json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// ---------- Pipeline operations ----------
function cleanCnpj(s) { return String(s || '').replace(/\D/g, ''); }
function cleanPhone(s) {
  let d = String(s || '').replace(/\D/g, '');
  // strip Brazil country code 55 if present and total > 11 digits
  if (d.length === 13 && d.startsWith('55')) d = d.slice(2);
  if (d.length === 12 && d.startsWith('55')) d = d.slice(2);
  // CA accepts 10 (fixed) or 11 (mobile) digits
  if (d.length > 11) d = d.slice(-11);
  return d;
}
function fmtCnpj(s) {
  const c = cleanCnpj(s);
  if (c.length !== 14) return s;
  return `${c.slice(0,2)}.${c.slice(2,5)}.${c.slice(5,8)}/${c.slice(8,12)}-${c.slice(12)}`;
}

async function findCustomerByCnpj(cnpj) {
  const r = await caRequest('GET',
    `/contaazul-bff/person-registration/v2/persons?search_term=${encodeURIComponent(cnpj)}&page=1&page_size=20&profile_type=CUSTOMER&person_status=active&recover_legacy_id=true&textual_search_only=true`);
  if (r.status !== 200 || !r.body) return null;
  const items = r.body.items || r.body.content || r.body.data || [];
  const target = cleanCnpj(cnpj);
  for (const it of items) {
    const doc = cleanCnpj(it.legalDocument || it.document || '');
    if (doc === target) return it;
  }
  return null;
}

async function createCustomer(c, opts) {
  const cnpj = cleanCnpj(c.cnpj);
  const body = {
    personType: 'Jurídica',
    legalDocument: cnpj,
    naturalDocument: '',
    name: (opts?.testMode ? '[TEST] ' : '') + (c.razaoSocial || c.nomeFantasia || 'Cliente'),
    code: fmtCnpj(cnpj),
    isActive: false,
    isOptingSimple: false,
    companyName: c.nomeFantasia || '',
    generalRegistry: '',
    birthDate: c.dataAbertura || '2026-01-01',
    email: c.email || '',
    commercialPhone: cleanPhone(c.telefone || ''),
    cellPhone: '',
    observation: c.endereco ? `Endereco: ${c.endereco}` : '',
    idContactPrincipal: '',
    profiles: [{ profileType: 'Cliente' }],
    registrations: [],
    otherContacts: [],
    address: [],
    doDuplicate: false,
    attachments: [{ description: '' }],
    billingContact: {
      emails: [c.emailFinanceiro || c.email || ''].filter(Boolean),
      phoneNumber: cleanPhone(c.telefoneFinanceiro || c.telefone || ''),
    },
    origin: 'CadastroUnico',
  };
  const r = await caRequest('POST', '/contaazul-bff/person-registration/v1/persons', body);
  if (r.status !== 200 || !r.body?.uuid) {
    throw new Error(`createCustomer falhou ${r.status}: ${JSON.stringify(r.body).slice(0,400)}`);
  }
  return {
    id: r.body.uuid,
    legacyId: (r.body.legacyIds || [{}])[0]?.personLegacyId,
    created: true,
  };
}

async function calcTaxes(value) {
  const r = await caRequest('POST', '/invoice-tax-management/v1/calculate-taxes', {
    key: 1,
    provider: { taxationRegime: 'NORMAL', nationalPattern: true },
    taker: { type: 'LEGAL_PERSON', taxationRegime: 'NORMAL', publicAgency: false },
    service: {
      id: DEFAULTS.serviceIdNfse,
      values: { base: value },
      provisionPlace: { cityId: DEFAULTS.cityId },
      taxes: { iss: { roundingMode: 'HALF_EVEN' } },
    },
  });
  if (r.status !== 200 || !r.body?.service) {
    throw new Error(`calcTaxes falhou ${r.status}: ${JSON.stringify(r.body).slice(0,400)}`);
  }
  return r.body.service;
}

async function nextContractNumber() {
  const r = await caRequest('GET', '/app/v1/scheduled-sales/next-number');
  return r.body?.number || 1;
}

function firstDayNextMonth(dateStr) {
  const d = new Date(dateStr);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const next = new Date(Date.UTC(y, m + 1, 1));
  return next.toISOString().slice(0, 10);
}

function firstDueAfter(emissionDate, dueDay) {
  const e = new Date(emissionDate);
  let y = e.getUTCFullYear(), m = e.getUTCMonth();
  if (e.getUTCDate() > dueDay) m += 1;
  const d = new Date(Date.UTC(y, m, dueDay));
  return d.toISOString().slice(0, 10);
}

function normalizeProductKey(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
}

// Upsell: PUT no scheduled-sale com novo valor e/ou nova categoria/CC
async function updateScheduledSaleForUpsell(schedId, customerId, productKey, valorMensal, dueDay, searchTerm = '') {
  const map = PRODUCT_MAP[productKey];
  if (!map) throw new Error(`Produto desconhecido pra upsell: '${productKey}'`);
  // Pega state atual do scheduled-sale + items
  const cur = await caRequest('GET', `/app/v1/scheduled-sales/${schedId}`);
  if (cur.status !== 200) throw new Error(`GET scheduled-sale ${schedId}: ${cur.status}`);
  const sched = cur.body;
  // Pega saleId da próxima instance + items dela
  const saleId = sched.saleId;
  if (!saleId) throw new Error('scheduled-sale sem saleId proxima');
  const itemsR = await caRequest('GET', `/search-engine-core/v1/sales/${saleId}/items?page=1&page_size=10`);
  const oldItems = itemsR.body?.items || [];
  // Calcula novos taxes
  const tax = await calcTaxes(valorMensal);
  // emissionDate = dia 1 do próximo mês (assim novas parcelas usam novo valor)
  const today = new Date();
  const nextMonthFirst = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
  const firstDueDate = (() => {
    const d = new Date(nextMonthFirst);
    if (d.getUTCDate() > dueDay) d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(dueDay);
    return d.toISOString().slice(0, 10);
  })();
  const body = {
    saleId,
    emissionDate: nextMonthFirst,
    customerId,
    terms: {
      number: sched.terms.number,
      frequencyType: sched.terms.frequencyType,
      frequencyRange: sched.terms.frequencyRange,
      expirationType: sched.terms.expirationType,
      endDate: sched.terms.endDate,
      saleEmissionDay: sched.terms.saleEmissionDay,
    },
    categoryId: map.cat,                  // pode mudar (BI → STRATEGY etc.)
    costCenterBySale: true,
    costCenterId: map.cc,                 // pode mudar
    ownerId: sched.ownerId,
    serviceProviderLocationId: DEFAULTS.cityId,
    observations: sched.observations || '',
    invoiceObservations: sched.invoiceObservations || '',
    autoTasks: sched.autoTasks,
    valueComposition: {
      shipping: 0,
      discount: { type: 'VALUE', value: 0 },
      serviceTaxTotal: tax.values.retained,
    },
    paymentCondition: {
      paymentType: 'BANKING_BILLET',
      financialAccountId: DEFAULTS.financialAccountId,
      dueDay,
      firstDueDate,
    },
    saleItems: oldItems.map(it => ({
      description: it.description || '',
      amount: it.amount,
      value: valorMensal,                 // novo valor
      id: it.id,
      saleItemId: it.saleItemId,
      costValue: it.costValue || 0,
      priceAdjustmentMethod: null,
    })),
    version: sched.version || 0,
    chargeRequestMetadata: sched.chargeRequestMetadata || { charge: { type: 'BILLET' } },
    serviceTaxInformation: {
      id: DEFAULTS.serviceIdNfse,
      values: tax.values,
      taxes: tax.taxes,
      provisionPlace: { cityId: DEFAULTS.cityId },
    },
  };
  const putR = await caRequest('PUT', `/app/v1/scheduled-sales/${schedId}`, body);
  if (putR.status !== 200) throw new Error(`PUT scheduled-sale ${schedId}: ${putR.status} ${JSON.stringify(putR.body).slice(0,200)}`);
  return { id: schedId, new_value: valorMensal, new_category: map.cat, new_cc: map.cc, emission_date: nextMonthFirst };
}

// Verifica se cliente CA já tem scheduled-sale ativa (pra idempotência durável)
async function findScheduledSaleByCustomer(customerId, searchTerm = '') {
  const r = await caRequest('POST',
    '/contaazul-bff/sale/v1/scheduled-sales/searches?page=1&page_size=50',
    { totals: 'ENABLED', searchTerm });
  if (r.status !== 200 || !r.body?.items) return null;
  for (const it of r.body.items) {
    if (it?.template?.customer?.id === customerId && it.status !== 'DISABLED') return it;
  }
  return null;
}

// Idempotência DURÁVEL pro setup (a CA NÃO permite DELETE de venda avulsa via API → uma vez criada,
// não dá pra desfazer). Busca uma venda AVULSA (type=SALE) já existente do cliente com o valor de setup.
// Match por: customer.id + type=SALE + valor do ITEM == valorSetup (valor BRUTO; o `total` da venda
// vem LÍQUIDO de retenção de ISS, então comparamos contra o item, não o total).
// Retorna a venda encontrada (ou null). NÃO escreve nada.
// IMPORTANTE: o searchTerm da CA casa por NOME (razão social), NÃO por CNPJ — por isso passamos o nome.
async function findSetupSaleByCustomer(customerId, valorSetup, searchTerm = '') {
  const alvo = Math.round(Number(valorSetup) * 100) / 100;
  if (!customerId || !alvo) return null;
  // Pagina sales/searches por nome e filtra por customer.id + type SALE (avulsa).
  const candidatos = [];
  for (let page = 1; page <= 10; page++) {
    const r = await caRequest('POST',
      `/contaazul-bff/sale/v1/sales/searches?page=${page}&page_size=50`, { searchTerm });
    const items = r.body?.items || [];
    if (items.length === 0) break;
    for (const s of items) {
      if (s.type === 'SCHEDULED_SALE') continue;            // só vendas avulsas
      if (s.customer?.id !== customerId) continue;          // mesmo cliente
      candidatos.push(s);
    }
    if (items.length < 50) break;
  }
  if (candidatos.length === 0) return null;
  // Confere o valor de cada candidata pelos ITENS (valor bruto). Se algum item == valorSetup → já existe.
  for (const s of candidatos) {
    const itemsR = await caRequest('GET', `/search-engine-core/v1/sales/${s.id}/items?page=1&page_size=10`);
    const its = itemsR.body?.items || [];
    const somaItens = Math.round(its.reduce((a, it) => a + (Number(it.value) || 0) * (Number(it.amount) || 1), 0) * 100) / 100;
    const algumItem = its.some(it => Math.abs((Number(it.value) || 0) - alvo) < 0.01);
    if (algumItem || Math.abs(somaItens - alvo) < 0.01) return s;
  }
  return null;
}

const SERVICE_VERSION = '2026-05-28T00:00:00Z-aditivo-automation+setup-source-dealproduct';

// ---------- AUDIT LOG ----------
// Grava em FinHub.bgp_pipeline_audit. Se a tabela não existir, falha silenciosamente.
async function logAudit(ctx, step, action, status, detail, payload, startedAt) {
  if (!FINHUB_SERVICE_KEY) return;
  const duration_ms = startedAt ? (Date.now() - startedAt) : null;
  const row = {
    run_id: ctx.run_id,
    cnpj: ctx.cnpj || null,
    client_name: ctx.client_name || null,
    crm_contract_id: ctx.crm_contract_id || null,
    step, action, status,
    detail: detail ? String(detail).slice(0, 1000) : null,
    payload: payload || null,
    duration_ms,
  };
  try {
    const r = await finhubRest('POST', '/bgp_pipeline_audit', row);
    if (r.status !== 201 && r.status !== 200) {
      // tabela ausente ou erro — só logga local
      console.warn('[audit-log skip]', r.status, JSON.stringify(r.body).slice(0,200));
    }
  } catch (e) {
    console.warn('[audit-log fail]', e.message);
  }
}

function uuid() {
  return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
    (c ^ (Math.random()*16) >> c/4).toString(16));
}

// ⚠️ DESCONTINUADO (2026-05-27): a tabela `client_products` foi descontinuada no FinHub.
// A fonte de verdade de produto do cliente é o JSON `clients.produtos`.
// Este mapa NÃO é mais usado em finhubCreateClient — mantido só como referência de product_id.
// Para o nome do produto no JSON, use produtoJsonName().
// Mapeamento produto BGP CRM -> FinHub products table (id + display_name) [LEGADO]
const FINHUB_PRODUCT_MAP = {
  'bgp-bi':              { id: '5c9e70ed-6674-4847-b8ac-b319c2307eb7', name: 'BI' },
  'bi-personalizado':    { id: '4c64b935-cd59-4da2-925d-1a48d9d5b1ec', name: 'BI2B' },
  'bgp-bi-personalizado':{ id: '4c64b935-cd59-4da2-925d-1a48d9d5b1ec', name: 'BI2B' },
  'bgp-go-i':            { id: '5bccd167-c426-48c7-aa30-3045fc5b0c65', name: 'GO I' },
  'bgp-go-ii':           { id: '0f1e9c35-9499-4262-bdf8-e8a3fa403c5b', name: 'GO II' },
  'bgp-go-iii':          { id: 'a5ed83f4-e9fe-4eb7-bf73-e4762041a97b', name: 'GO III' },
  'bgp-strategy':        { id: '2836916d-1e83-42f9-8dcc-35fe8977ac87', name: 'Strategy' },
  'bgp-valuation':       { id: 'b0d4e7dd-2d88-43a3-9cbc-50eb3996e4a3', name: 'Valuation' },
  'brand-growth':        { id: '08a5e33e-6bb0-477e-aa7b-d6323260e997', name: 'Brand Growth' },
  'go-aimo':             { id: '9b45dc42-d30b-4135-8406-82f02d0a1d7e', name: 'GO BI by AiMO' },
};

// Aplica desconto nas N primeiras parcelas geradas (idempotente — pode rodar várias vezes sem duplicar efeito)
// NOTA: o searchTerm da CA casa por NOME (razão social), NÃO por CNPJ (verificado ao vivo: busca por
// CNPJ retorna 0 resultados). Por isso a busca é por nome. A chave forte de filtro é `schedule.id===schedId`
// (durável, à prova de homônimos). `customerId` é cross-check opcional pra descartar parcela de homônimo
// que por acaso tenha o mesmo schedId (não deve acontecer, mas barato validar).
async function applyDiscountToFirstN(schedId, descontoMeses, descontoPercentual, valorMensal, searchTerm = '', customerId = null) {
  if (!descontoMeses || !descontoPercentual) return { applied: [], error: 'missing params' };
  const N = Math.floor(descontoMeses);
  const descontoVal = Math.round((valorMensal * descontoPercentual / 100) * 100) / 100;
  const baseCom = Math.round((valorMensal - descontoVal) * 100) / 100;

  // GET ALL instances of this scheduled-sale via pagination (search é global mas filtramos por schedule.id)
  const allLinked = [];
  const debug = { pages_fetched: 0, total_items_seen: 0, search_term: searchTerm };
  for (let page = 1; page <= 20; page++) {   // 20 págs × 50 = até 1000 vendas (era 10 = 500)
    const search = await caRequest('POST', `/contaazul-bff/sale/v1/sales/searches?page=${page}&page_size=50`, { searchTerm });
    const items = search.body?.items || [];
    debug.pages_fetched = page;
    debug.total_items_seen += items.length;
    if (items.length === 0) break;
    for (const it of items) {
      if (it.type !== 'SCHEDULED_SALE' || it.schedule?.id !== schedId) continue;
      if (customerId && it.customer?.id && it.customer.id !== customerId) continue; // cross-check homônimo
      allLinked.push(it);
    }
    if (items.length < 50) break;
  }
  debug.linked_found = allLinked.length;
  // Se a busca por nome não achou NENHUMA parcela do schedId, sinaliza claramente (em vez de silêncio).
  if (allLinked.length === 0) {
    return { applied: [], error: 'no_linked_sales_found', debug,
      hint: 'busca por nome não retornou parcelas deste schedId — nome genérico, fora da janela de páginas, ou parcelas ainda não geradas' };
  }
  const linked = allLinked.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const targets = linked.slice(0, N);
  if (targets.length === 0) return { applied: [], debug };

  const tax = await calcTaxes(baseCom);
  const results = [];
  for (const t of targets) {
    const sid = t.id;
    const saleResp = await caRequest('GET', `/app/v1/scheduled-sales/${schedId}/sales/${sid}`);
    if (saleResp.status !== 200) { results.push({ sid, status: saleResp.status, error: 'GET failed' }); continue; }
    const sale = saleResp.body;
    // Se já tem o desconto exato → skip (idempotency)
    if (Math.abs((sale.valueComposition?.discount?.value || 0) - descontoVal) < 0.01) {
      results.push({ sid, status: 200, skipped: 'already_discounted' });
      continue;
    }
    const itemsResp = await caRequest('GET', `/search-engine-core/v1/sales/${sid}/items?page=1&page_size=10`);
    const items = (itemsResp.body?.items || []).map(it => ({
      description: it.description || '',
      amount: it.amount,
      value: it.value,
      id: it.id,
      saleItemId: it.saleItemId,
      costValue: it.costValue || 0,
      priceAdjustmentMethod: null,
    }));
    const body = {
      saleId: sid,
      emissionDate: sale.committedDate,
      customerId: sale.customerId,
      terms: {
        number: sale.terms.number,
        frequencyType: sale.terms.frequencyType,
        frequencyRange: sale.terms.frequencyRange,
        expirationType: sale.terms.expirationType,
        endDate: sale.terms.endDate,
        saleEmissionDay: sale.terms.saleEmissionDay,
      },
      categoryId: sale.categoryId,
      costCenterBySale: true,
      costCenterId: sale.costCenterId,
      ownerId: sale.ownerId,
      serviceProviderLocationId: sale.serviceProviderLocationId,
      observations: sale.observations || '',
      invoiceObservations: sale.invoiceObservations || '',
      autoTasks: sale.autoTasks,
      valueComposition: {
        shipping: 0,
        discount: { type: 'VALUE', value: descontoVal },
        serviceTaxTotal: tax.values.retained,
      },
      paymentCondition: sale.paymentCondition,
      saleItems: items,
      version: sale.version || 0,
      chargeRequestMetadata: sale.chargeRequestMetadata || { charge: { type: 'BILLET' } },
      serviceTaxInformation: {
        id: DEFAULTS.serviceIdNfse,
        values: tax.values,
        taxes: tax.taxes,
        provisionPlace: { cityId: DEFAULTS.cityId },
      },
    };
    const putR = await caRequest('PUT', `/app/v1/scheduled-sales/${schedId}/sales/${sid}`, body);
    results.push({ sid, status: putR.status, date: t.date });
  }
  return { applied: results, debug };
}

async function createScheduledSale(customerId, contract, opts) {
  const productKey = normalizeProductKey(contract.produto);
  const map = PRODUCT_MAP[productKey];
  if (!map) throw new Error(`Produto desconhecido: '${contract.produto}' (normalizado: '${productKey}'). Conhecidos: ${Object.keys(PRODUCT_MAP).join(', ')}`);

  const sellerId = SELLER_MAP[(contract.sellerEmail || '').toLowerCase()] || DEFAULTS.sellerId;
  const valor = Number(contract.valorMensal);
  if (!valor || valor <= 0) throw new Error(`valorMensal invalido: ${contract.valorMensal}`);

  const tax = await calcTaxes(valor);
  const nextNum = await nextContractNumber();

  const emissionDate = firstDayNextMonth(contract.dataAssinatura);
  const startDate = String(contract.dataAssinatura).slice(0, 10);
  const dueDay = parseInt(contract.diaVencimento, 10) || 5;
  const firstDueDate = firstDueAfter(emissionDate, dueDay);
  // endDate: mesmo em FOREVER a CA exige um valor. Coloca 11 meses pra frente do start.
  const endD = new Date(startDate);
  endD.setUTCMonth(endD.getUTCMonth() + 11);
  const endDate = endD.toISOString().slice(0, 10);

  const body = {
    emissionDate,
    customerId,
    terms: {
      number: nextNum,
      frequencyType: 'MONTH',
      frequencyRange: 1,
      expirationType: 'FOREVER',
      startDate,
      endDate,
      saleEmissionDay: 1,
    },
    categoryId: map.cat,
    costCenterBySale: true,
    costCenterId: map.cc,
    ownerId: sellerId,
    serviceProviderLocationId: DEFAULTS.cityId,
    observations: opts?.testMode ? 'TEST E2E CRM — apagar' : `Contrato BGPGO — ${contract.produto}`,
    invoiceObservations: '',
    autoTasks: {
      sendInvoice: true,
      issueAndSendBilling: true,
      sendReminder: true,
      emailsReceiveInvoice: [contract.emailFinanceiro || contract.emailCliente].filter(Boolean),
      serviceInvoice: {},
    },
    valueComposition: {
      shipping: 0,
      discount: { value: 0, type: 'VALUE' },
      serviceTaxTotal: tax.values.retained,
    },
    paymentCondition: {
      paymentType: 'BANKING_BILLET',
      financialAccountId: DEFAULTS.financialAccountId,
      dueDay,
      firstDueDate,
    },
    saleItems: [{
      description: '',
      amount: 1,
      value: valor,
      id: DEFAULTS.serviceIdNfse,
      costValue: 0,
      priceAdjustmentMethod: null,
    }],
    chargeRequestMetadata: { charge: { type: 'BILLET' } },
    serviceTaxInformation: {
      id: DEFAULTS.serviceIdNfse,
      values: tax.values,
      taxes: tax.taxes,
      provisionPlace: { cityId: DEFAULTS.cityId },
    },
  };

  const r = await caRequest('POST', '/app/v1/scheduled-sales/', body);
  if (r.status !== 200 || !r.body?.id) {
    throw new Error(`createScheduledSale falhou ${r.status}: ${JSON.stringify(r.body).slice(0,600)}`);
  }
  return { id: r.body.id, legacyId: r.body.legacyId, number: nextNum, emissionDate, firstDueDate };
}

async function createSetupSale(customerId, contract, opts) {
  const valor = Number(contract.valorImplementacao);
  if (!valor || valor <= 0) return null;

  const productKey = normalizeProductKey(contract.produto);
  const map = PRODUCT_MAP[productKey];
  if (!map) throw new Error(`Produto desconhecido: '${contract.produto}' (normalizado: '${productKey}')`);

  const sellerId = SELLER_MAP[(contract.sellerEmail || '').toLowerCase()] || DEFAULTS.sellerId;
  const tax = await calcTaxes(valor);
  const committedDate = String(contract.dataAssinatura).slice(0, 10);

  // Venda avulsa usa /negotiations/next-number — response shape: {"data": N}
  const nn = await caRequest('GET', '/app/v1/negotiations/next-number');
  const saleNumber = nn.body && (nn.body.data || nn.body.number) || null;

  const body = {
    customerId,
    number: saleNumber,
    committedDate,
    categoryId: map.cat,
    costCenterId: map.cc,
    ownerId: sellerId,
    operationNatureId: DEFAULTS.operationNatureIdAvulsa,
    saleItems: [{
      description: 'Setup / implementacao',
      amount: 1,
      value: valor,
      id: DEFAULTS.serviceIdNfse,
      costValue: 0,
      priceAdjustmentMethod: null,
    }],
    valueComposition: {
      shipping: 0,
      discount: { type: 'VALUE', value: 0 },
      serviceTaxTotal: tax.values.retained,
    },
    paymentCondition: {
      paymentType: 'BANKING_BILLET',
      financialAccountId: DEFAULTS.financialAccountId,
      paymentConditionOption: 'À vista',
      installments: [{ dueDate: committedDate, value: tax.values.total }],
    },
    observations: opts?.testMode ? 'TEST E2E CRM Setup — apagar' : `Setup ${contract.produto}`,
    invoiceObservations: '',
    situation: 'APPROVED',
    serviceTaxInformation: {
      id: DEFAULTS.serviceIdNfse,
      values: tax.values,
      taxes: tax.taxes,
      provisionPlace: { cityId: DEFAULTS.cityId },
    },
  };

  const r = await caRequest('POST', '/app/v1/sales/', body);
  if (r.status !== 200 || !r.body?.id) {
    throw new Error(`createSetupSale falhou ${r.status}: ${JSON.stringify(r.body).slice(0,600)}`);
  }
  return { id: r.body.id, legacyId: r.body.legacyId, number: r.body.number };
}

// ---------- CRM / FinHub helpers ----------
function crmRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(CRM_SUPABASE_URL + '/rest/v1' + path);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''),
      method,
      headers: {
        'apikey': CRM_SERVICE_KEY,
        'Authorization': `Bearer ${CRM_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Accept-Encoding': 'identity',
      },
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const req = https.request(opts, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function finhubRest(method, path, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${FINHUB_SUPABASE_URL}/rest/v1${path}`);
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const opts = {
      hostname: u.hostname, path: u.pathname + (u.search || ''), method,
      headers: {
        'apikey': FINHUB_SERVICE_KEY,
        'Authorization': `Bearer ${FINHUB_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Prefer': method === 'POST' || method === 'PATCH' ? 'return=representation' : '',
      },
    };
    if (data) opts.headers['Content-Length'] = data.length;
    const req = https.request(opts, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}

// Produto CRM -> product_name usado no JSON clients.produtos (FONTE DE VERDADE do FinHub).
// Mesma convenção do ingest-crm-contract.mapProdutoToFinhub (validada): família GO.
function produtoJsonName(produtoRaw) {
  const p = String(produtoRaw || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return null;
  if (p.includes('go iii') || p.includes('go 3')) return 'GO III';
  if (p.includes('go ii') || p.includes('go 2')) return 'GO II';
  if (p.includes('go i') || p.includes('go 1')) return 'GO I';
  if (p.includes('strategy') || p.includes('estrateg')) return 'Strategy';
  if (p.includes('valuation')) return 'Valuation';
  if (p.includes('brand') || p.includes('growth')) return 'Brand Growth';
  if (p.includes('aimo')) return 'GO BI by AiMO';
  if (p.includes('condomin')) return 'Gestão Condominial';
  if (p.includes('bi')) return 'GO BI'; // BGP BI / BI Personalizado -> GO BI
  return null;
}

// Cria/atualiza cliente no FinHub direto via REST (service_role bypassa RLS).
// Pula edge function create-client (exige JWT 'team').
// Escreve: clients + clients.produtos (JSON) + pit_wall.
// ⚠️ client_products está DESCONTINUADO — NÃO escrever nela. Fonte de verdade = clients.produtos (JSON).
async function finhubCreateClient(payload) {
  const cnpj = (payload.cnpj || '').replace(/\D/g, '');
  if (!cnpj) throw new Error('CNPJ obrigatório pra criar cliente FinHub');

  // 1) Dedup clients por CNPJ (e auto-corrige conta_azul_code se ficou UUID antigo)
  const dup = await finhubRest('GET', `/clients?cnpj=eq.${cnpj}&select=id,name,conta_azul_code&limit=1`);
  let clientId, clientName, reused = false, fixedCaCode = false;
  if (dup.status === 200 && Array.isArray(dup.body) && dup.body.length > 0) {
    clientId = dup.body[0].id; clientName = dup.body[0].name; reused = true;
    // Se conta_azul_code != CNPJ, corrige
    if (dup.body[0].conta_azul_code !== cnpj) {
      await finhubRest('PATCH', `/clients?id=eq.${clientId}`, { conta_azul_code: cnpj });
      fixedCaCode = true;
    }
  } else {
    // 2) INSERT clients (conta_azul_code = CNPJ, padrão do FinHub)
    const now = new Date().toISOString();
    const row = {
      name: payload.name,
      company: payload.company || payload.name,
      email: payload.email || null,
      phone: payload.phone || null,
      cnpj,
      status: 'ativo',
      data_entrada: now.slice(0, 10),
      conta_azul_code: cnpj, // ← CNPJ, NÃO o uuid da CA
      erp_cliente: payload.erp_cliente || 'contaazul',
      observacoes_importantes: payload.observacoes || null,
      created_at: now,
      updated_at: now,
    };
    const r = await finhubRest('POST', '/clients', row);
    if (r.status !== 201 && r.status !== 200) {
      throw new Error(`finhub insert clients falhou ${r.status}: ${JSON.stringify(r.body).slice(0,300)}`);
    }
    const created = Array.isArray(r.body) ? r.body[0] : r.body;
    clientId = created.id; clientName = created.name;
  }

  // 3) produtos (JSON em clients) — FONTE DE VERDADE do FinHub (client_products DESCONTINUADO).
  //    Lê o JSON atual e faz merge idempotente por product_name (enrich se novo, upsell se valor mudou).
  //    Lido por FaseOperacional / Carteira / PitWall.
  const productName = produtoJsonName(payload.produto || '');
  let productRow = null;
  if (productName) {
    const cur = await finhubRest('GET', `/clients?id=eq.${clientId}&select=produtos&limit=1`);
    const arr = (cur.status === 200 && Array.isArray(cur.body) && Array.isArray(cur.body[0]?.produtos))
      ? cur.body[0].produtos : [];
    const val = payload.valorMensal != null ? Number(payload.valorMensal) : null;
    const idx = arr.findIndex(p =>
      String(p.product_name || p.nome || p.name || '').toLowerCase() === productName.toLowerCase());
    let action;
    if (idx === -1) { arr.push({ product_name: productName, value: val, responsible: null }); action = 'added'; }
    else if (val != null && val > 0 && Number(arr[idx].value) !== val) { arr[idx] = { ...arr[idx], value: val }; action = 'value_updated'; }
    else action = 'noop';
    const upd = await finhubRest('PATCH', `/clients?id=eq.${clientId}`, { produtos: arr });
    productRow = (upd.status === 200 || upd.status === 204 || upd.status === 201)
      ? { product_name: productName, action }
      : { error: `clients.produtos PATCH ${upd.status}: ${JSON.stringify(upd.body).slice(0,200)}` };
  } else {
    productRow = { error: `produto não mapeado: '${payload.produto}'` };
  }

  // 4) pit_wall (UNIQUE por client_id)
  let pitWallRow = null;
  const dupPW = await finhubRest('GET',
    `/pit_wall?client_id=eq.${clientId}&select=id&limit=1`);
  if (dupPW.status === 200 && Array.isArray(dupPW.body) && dupPW.body.length > 0) {
    pitWallRow = { id: dupPW.body[0].id, reused: true };
  } else {
    const pwRow = {
      client_id: clientId,
      prioridade_pontos_atencao: 'Novo cliente — configurar processos iniciais',
      status_reuniao_cliente: 'marcar',
      produto: productName || null,
    };
    const r = await finhubRest('POST', '/pit_wall', pwRow);
    if (r.status === 201 || r.status === 200) {
      const p = Array.isArray(r.body) ? r.body[0] : r.body;
      pitWallRow = { id: p.id, reused: false };
    } else {
      pitWallRow = { error: `pit_wall insert ${r.status}: ${JSON.stringify(r.body).slice(0,200)}` };
    }
  }

  return { reused, fixed_ca_code: fixedCaCode, id: clientId, name: clientName, conta_azul_code: cnpj, produto_json: productRow, pit_wall: pitWallRow };
}

// ---------- ADITIVO helpers ----------
// Aditivos (upsell) na BGP não persistem valor estruturado no SentDocument, mas SIM no DealProduct
// (setupPrice + recurrenceValue) — fonte de verdade que a equipe usa quando aplica manual.
async function crmDealProducts(dealId) {
  if (!dealId) return null;
  const r = await crmRequest('GET',
    `/DealProduct?dealId=eq.${dealId}&select=setupPrice,setupInstallments,recurrenceValue,quantity,productId,product:Product(name)`);
  if (r.status !== 200 || !Array.isArray(r.body) || r.body.length === 0) return null;
  const products = r.body;
  const setupTotal = Math.round(products.reduce((s, p) =>
    s + Number(p.setupPrice || 0) * Number(p.quantity || 1), 0) * 100) / 100;
  const recurrenceTotal = Math.round(products.reduce((s, p) =>
    s + Number(p.recurrenceValue || 0) * Number(p.quantity || 1), 0) * 100) / 100;
  const setupInstallments = products[0]?.setupInstallments || null;
  // Produto primário = o que tem mais recorrência (define a categoria CA); senão o que tem setup
  const primary = products.find(p => Number(p.recurrenceValue || 0) > 0)
               || products.find(p => Number(p.setupPrice || 0) > 0)
               || products[0];
  return { setupTotal, recurrenceTotal, setupInstallments, primaryProductName: primary?.product?.name || null, products };
}

// Mapeia Product.name (vindo do CRM Product table) -> chave do PRODUCT_MAP (slug pra CA cat/cc).
// Reusa convenção do produtoJsonName mas devolve a chave pra PRODUCT_MAP em vez do nome do JSON.
function mapCrmProductNameToKey(productName) {
  const p = String(productName || '').toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!p) return null;
  if (p.includes('controladoria')) return 'bgp-go-iii'; // default level (cat é a mesma; cc default)
  if (p.includes('go iii') || p.includes('go 3')) return 'bgp-go-iii';
  if (p.includes('go ii') || p.includes('go 2')) return 'bgp-go-ii';
  if (p.includes('go i') || p.includes('go 1')) return 'bgp-go-i';
  if (p.includes('strategy') || p.includes('estrateg')) return 'bgp-strategy';
  if (p.includes('valuation')) return 'bgp-valuation';
  if (p.includes('brand') || p.includes('growth')) return 'brand-growth';
  if (p.includes('aimo')) return 'go-aimo';
  if (p.includes('condomin')) return 'gestao-condominial';
  if (p.includes('bi')) return 'bgp-bi'; // BGP BI / BI Personalizado / BI GO
  return null;
}

// Idempotência durável (via FinHub autentique_webhook_events.aditivo_applied_at).
// Se o documento Autentique já foi processado (PUT na CA + setup) — não refaz. Restart-safe.
async function finhubAditivoApplied(documentId) {
  if (!documentId || !FINHUB_SERVICE_KEY) return false;
  try {
    const r = await finhubRest('GET',
      `/autentique_webhook_events?document_id=eq.${encodeURIComponent(documentId)}&event_type=eq.signed&aditivo_applied_at=not.is.null&select=id&limit=1`);
    return Array.isArray(r.body) && r.body.length > 0;
  } catch { return false; }
}
async function markAditivoApplied(documentId, detail) {
  if (!documentId || !FINHUB_SERVICE_KEY) return;
  try {
    await finhubRest('PATCH',
      `/autentique_webhook_events?document_id=eq.${encodeURIComponent(documentId)}&event_type=eq.signed`,
      { aditivo_applied_at: new Date().toISOString(), aditivo_applied_detail: detail });
  } catch (e) { console.warn('[markAditivoApplied fail]', e.message); }
}

// ---------- SCAN logic ----------
// Idempotency tracker in-memory (resets on restart, but CA /lookup acts as durable check)
const processedContracts = new Set();

async function scanAndProcessTest(opts = {}) {
  if (!CRM_SERVICE_KEY) throw new Error('CRM_SERVICE_KEY nao configurada');
  const force = !!opts.force;

  // 1) Busca Contracts SIGNED recentes (ultimas 48h) com relacao Deal+Org+Contact
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const query = `?select=*,deal:Deal(id,title,closedAt,status,user:User(email),organization:Organization(name,cnpj,phone,email),contact:Contact(name,email,phone))&status=eq.SIGNED&autentiqueSignedAt=gte.${encodeURIComponent(since)}&order=autentiqueSignedAt.desc&limit=100`;
  const r = await crmRequest('GET', '/Contract' + query);
  if (r.status !== 200) throw new Error(`CRM Contract query falhou ${r.status}: ${JSON.stringify(r.body).slice(0,300)}`);

  if (KILL_SWITCH) {
    return { kill_switch: true, scanned: (r.body || []).length, skipped: [], results: [] };
  }

  const eligible = [];
  const skipped = [];
  for (const c of (r.body || [])) {
    // Gate name match (se TESTE_KEYWORD for vazia, passa tudo)
    if (TESTE_KEYWORD) {
      const names = [c.razaoSocial, c.deal?.organization?.name, c.deal?.contact?.name, c.deal?.title]
        .filter(Boolean).map(s => String(s).toLowerCase());
      const matchesGate = names.some(n => n.includes(TESTE_KEYWORD));
      if (!matchesGate) { skipped.push({ id: c.id, reason: `no_keyword_${TESTE_KEYWORD}`, names }); continue; }
    }
    if (!force && processedContracts.has(c.id)) { skipped.push({ id: c.id, reason: 'already_processed_inmem' }); continue; }
    eligible.push(c);
  }

  const results = [];
  for (const c of eligible) {
    const out = { contract_id: c.id, started_at: new Date().toISOString() };
    const ctx = { run_id: uuid(), cnpj: null, client_name: c.razaoSocial, crm_contract_id: c.id };
    const t0 = Date.now();
    try {
      const org = c.deal?.organization || {};
      const contact = c.deal?.contact || {};
      const cnpj = (c.cnpj || org.cnpj || '').replace(/\D/g, '');
      ctx.cnpj = cnpj;
      await logAudit(ctx, 'watcher_scan', 'attempt', 'pending', `Iniciando pipeline pra ${c.razaoSocial}`, { contract: c.id, produto: c.produto, valor: c.valorMensal });

      // 2) Customer
      const tCust = Date.now();
      const existing = await findCustomerByCnpj(cnpj);
      if (existing) {
        out.ca_customer = { id: existing.id || existing.uuid, reused: true };
        await logAudit(ctx, 'ca_customer', 'reuse', 'reused', `Cliente já existe na CA (${existing.id || existing.uuid})`, { ca_id: existing.id }, tCust);
      } else {
        out.ca_customer = await createCustomer({
          cnpj, razaoSocial: c.razaoSocial, nomeFantasia: c.nomeFantasia || '',
          email: c.emailRepresentante || contact.email || '',
          telefone: contact.phone || org.phone || '',
          emailFinanceiro: c.emailFinanceiro || c.emailRepresentante,
          endereco: c.endereco || '',
        }, { testMode: false });
        await logAudit(ctx, 'ca_customer', 'create', 'ok', `Criado cliente CA ${out.ca_customer.id}`, out.ca_customer, tCust);
      }

      // 3) Scheduled-sale: dedup OR create OR upsell
      const tSched = Date.now();
      const existingSched = await findScheduledSaleByCustomer(out.ca_customer.id, c.razaoSocial || '');
      const newProductMap = PRODUCT_MAP[normalizeProductKey(c.produto)];
      const newValor = Number(c.valorMensal);
      const newDueDay = Number(c.diaVencimento || 10);
      if (existingSched) {
        // Detecta upsell — usando valor BRUTO e categoryId REAIS (não o template.total, que vem
        // LÍQUIDO de retenção de ISS, nem template.categoryId, que NÃO existe no payload de busca).
        // Verificado ao vivo: MINATO template.total=3894.77 mas item bruto=4150 → comparar com
        // template.total gerava upsell ESPÚRIO (PUT) a cada re-scan pós-restart. Por isso buscamos o
        // estado real do scheduled-sale (GET) e o valor do item da próxima venda.
        let oldGrossValue = null, oldCategoryId = null;
        try {
          const full = await caRequest('GET', `/app/v1/scheduled-sales/${existingSched.id}`);
          if (full.status === 200 && full.body) {
            oldCategoryId = full.body.categoryId || null;
            if (full.body.saleId) {
              const itR = await caRequest('GET', `/search-engine-core/v1/sales/${full.body.saleId}/items?page=1&page_size=10`);
              const its = itR.body?.items || [];
              oldGrossValue = Math.round(its.reduce((a, it) => a + (Number(it.value) || 0) * (Number(it.amount) || 1), 0) * 100) / 100;
            }
          }
        } catch (e) { /* fallback abaixo */ }
        // Fallback seguro: se não conseguiu o bruto, NÃO dispara upsell por valor (evita falso positivo).
        const newCategoryId = newProductMap?.cat;
        const valueChanged = oldGrossValue != null && Math.abs(oldGrossValue - newValor) > 0.01;
        const productChanged = !!(oldCategoryId && newCategoryId && oldCategoryId !== newCategoryId);
        const oldValue = oldGrossValue != null ? oldGrossValue : (existingSched.template?.total || 0);
        if (valueChanged || productChanged) {
          try {
            out.ca_upsell = await updateScheduledSaleForUpsell(
              existingSched.id, out.ca_customer.id,
              normalizeProductKey(c.produto), newValor, newDueDay, c.razaoSocial || ''
            );
            out.ca_scheduledSale = { id: existingSched.id, legacyId: existingSched.legacyId, upsell: true };
            await logAudit(ctx, 'upsell', 'update', 'ok',
              `Upsell aplicado: valor ${oldValue}→${newValor}, productChanged=${productChanged}`,
              out.ca_upsell, tSched);
          } catch (e) {
            out.ca_upsell_error = e.message;
            out.ca_scheduledSale = { id: existingSched.id, reused: true, upsell_failed: true };
            await logAudit(ctx, 'upsell', 'update', 'error', e.message, null, tSched);
          }
        } else {
          out.ca_scheduledSale = {
            id: existingSched.id, legacyId: existingSched.legacyId,
            number: existingSched.template?.terms?.number, reused: true,
          };
          await logAudit(ctx, 'ca_scheduled_sale', 'reuse', 'reused',
            `Scheduled-sale existente sem mudança (valor=${oldValue})`, { id: existingSched.id }, tSched);
        }
      } else {
        out.ca_scheduledSale = await createScheduledSale(out.ca_customer.id, {
          produto: c.produto, valorMensal: newValor, diaVencimento: newDueDay,
          dataAssinatura: c.autentiqueSignedAt || c.dataInicio || new Date().toISOString(),
          sellerEmail: c.deal?.user?.email,
        }, { testMode: false });
        await logAudit(ctx, 'ca_scheduled_sale', 'create', 'ok',
          `Criado scheduled-sale num ${out.ca_scheduledSale.number}`, out.ca_scheduledSale, tSched);
      }

      // 3.5) Desconto
      if (Number(c.descontoMeses) > 0 && Number(c.descontoPercentual) > 0) {
        const tDisc = Date.now();
        try {
          out.ca_discount_result = await applyDiscountToFirstN(
            out.ca_scheduledSale.id, Number(c.descontoMeses), Number(c.descontoPercentual),
            newValor, c.razaoSocial || '', out.ca_customer.id   // customerId p/ cross-check homônimo
          );
          const applied = out.ca_discount_result.applied?.length || 0;
          const discErr = out.ca_discount_result.error;
          await logAudit(ctx, 'ca_discount', 'apply', discErr ? 'error' : 'ok',
            discErr
              ? `Desconto NÃO aplicado: ${discErr} (${c.descontoPercentual}%/${c.descontoMeses}m)`
              : `Desconto ${c.descontoPercentual}% em ${c.descontoMeses} parcelas (applied=${applied})`,
            out.ca_discount_result, tDisc);
        } catch (e) {
          out.ca_discount_error = e.message;
          await logAudit(ctx, 'ca_discount', 'apply', 'error', e.message, null, tDisc);
        }
      } else if (Number(c.descontoMeses) > 0 || Number(c.descontoPercentual) > 0) {
        // Só um dos dois veio preenchido (gap de dados no CRM) → não aplica, mas registra pra não passar batido.
        out.ca_discount_skipped = `desconto incompleto: meses=${c.descontoMeses} pct=${c.descontoPercentual}`;
        await logAudit(ctx, 'ca_discount', 'skip', 'pending',
          `Desconto incompleto no CRM (meses=${c.descontoMeses}, pct=${c.descontoPercentual}) — não aplicado`, null, null);
      }

      // 4) Setup (venda avulsa). FONTE = SUM(DealProduct.setupPrice) — é o que a equipe usa no
      //    aplicação manual. Caso SHERPA: Contract.valorImplementacao=2500 mas DealProduct=2997
      //    (equipe aplicou 2997). Se o Deal não tem DealProduct (raro), cai pra Contract.valorImplementacao.
      //    Idempotência DURÁVEL via findSetupSaleByCustomer (CA não permite DELETE via API).
      let setupAmount = Number(c.valorImplementacao || 0);
      let setupSource = 'contract';
      try {
        const dp = await crmDealProducts(c.dealId);
        if (dp && dp.setupTotal > 0) {
          setupAmount = dp.setupTotal;
          setupSource = 'dealproduct';
        }
      } catch { /* mantém fallback ao Contract.valorImplementacao */ }
      if (setupAmount > 0) {
        const tSetup = Date.now();
        try {
          const existingSetup = await findSetupSaleByCustomer(
            out.ca_customer.id, setupAmount, c.razaoSocial || '');
          if (existingSetup) {
            // Idempotência durável: setup já existe (criado manual ou em scan anterior) → reusa.
            out.ca_setup = { id: existingSetup.id, number: existingSetup.number, reused: true, source: setupSource, value: setupAmount };
            await logAudit(ctx, 'ca_setup', 'reuse', 'reused',
              `Setup avulso R$ ${setupAmount} já existe na CA (#${existingSetup.number}) — não recria [fonte=${setupSource}]`,
              { id: existingSetup.id, source: setupSource }, tSetup);
          } else if (SETUP_AUTOCREATE) {
            // Não existe e autocreate ligado → cria a venda avulsa de setup.
            out.ca_setup = await createSetupSale(out.ca_customer.id, {
              produto: c.produto, valorImplementacao: setupAmount,
              dataAssinatura: c.autentiqueSignedAt || c.dataInicio || new Date().toISOString(),
              sellerEmail: c.deal?.user?.email,
            }, { testMode: false });
            await logAudit(ctx, 'ca_setup', 'create', 'ok',
              `Criado setup avulso R$ ${setupAmount} (#${out.ca_setup?.number}) [fonte=${setupSource}]`,
              { ...(out.ca_setup || {}), source: setupSource }, tSetup);
          } else {
            // Não existe e autocreate desligado → mantém pendência (comportamento atual), mas auditável.
            out.ca_setup_pending = `Criar setup avulso R$ ${setupAmount} (SETUP_AUTOCREATE off — manual no painel CA Pro) [fonte=${setupSource}]`;
            await logAudit(ctx, 'ca_setup', 'skip', 'pending',
              `Setup avulso R$ ${setupAmount} pendente (autocreate off; não encontrado na CA) [fonte=${setupSource}]`, null, tSetup);
          }
        } catch (e) {
          out.ca_setup_error = e.message;
          await logAudit(ctx, 'ca_setup', 'create', 'error', e.message, null, tSetup);
        }
      }

      // 5) FinHub
      if (FINHUB_SERVICE_KEY) {
        const tFin = Date.now();
        try {
          out.finhub = await finhubCreateClient({
            name: c.razaoSocial, company: c.razaoSocial,
            email: c.emailFinanceiro || c.emailRepresentante,
            phone: contact.phone || org.phone || '',
            cnpj, produto: c.produto, valorMensal: newValor,
            erp_cliente: 'contaazul',
            observacoes: `CRM Contract=${c.id} | CA customer=${out.ca_customer?.id} | CA scheduled-sale=${out.ca_scheduledSale?.id}`,
          });
          await logAudit(ctx, 'finhub_client', out.finhub.reused ? 'reuse' : 'create',
            'ok', `FinHub cliente ${out.finhub.id} (reused=${out.finhub.reused})`, out.finhub, tFin);
        } catch (e) {
          out.finhub_error = e.message;
          await logAudit(ctx, 'finhub_client', 'create', 'error', e.message, null, tFin);
        }
      } else {
        out.finhub_skipped = 'FINHUB_SERVICE_KEY nao configurada';
      }

      processedContracts.add(c.id);
      out.ok = true;
      await logAudit(ctx, 'watcher_scan', 'complete', 'ok', 'Pipeline completo', null, t0);
    } catch (e) {
      out.ok = false;
      out.error = e.message;
      await logAudit(ctx, 'watcher_scan', 'complete', 'error', e.message, { stack: e.stack?.slice(0,500) }, t0);
    }
    out.finished_at = new Date().toISOString();
    results.push(out);
  }

  // 6) ADITIVOS (upsell) — PROCESSAMENTO COMPLETO. Aditivo na BGP = SentDocument com DealProduct
  //    contendo o financeiro estruturado (setupPrice + recurrenceValue). Fluxo:
  //    a) Setup: cria avulsa via createSetupSale (idempotência por findSetupSaleByCustomer +
  //       SETUP_AUTOCREATE gate).
  //    b) MRR upsell: lê valor BRUTO atual do scheduled-sale + soma DealProduct.recurrenceValue
  //       → PUT com novo total (e troca categoria se Product mudou).
  //    Idempotência durável: marca autentique_webhook_events.aditivo_applied_at no FinHub
  //    (restart-safe; se a coluna estiver setada, skipa).
  let aditivos = [];
  try {
    const sinceAdit = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    const aq = `?select=id,documentName,documentType,documentId,status,dealId,updatedAt,deal:Deal(id,title,status,organization:Organization(name,cnpj))&documentType=eq.aditivo&status=eq.signed&updatedAt=gte.${encodeURIComponent(sinceAdit)}&order=updatedAt.desc&limit=50`;
    const ar = await crmRequest('GET', '/SentDocument' + aq);
    if (ar.status === 200 && Array.isArray(ar.body)) {
      for (const a of ar.body) {
        const cnpjAdit = (a.deal?.organization?.cnpj || '').replace(/\D/g, '');
        const ctxA = { run_id: uuid(), cnpj: cnpjAdit || null, client_name: a.deal?.organization?.name || a.deal?.title || a.documentName, crm_contract_id: null };
        const aOut = { sent_document_id: a.id, document_id: a.documentId, document: a.documentName, deal: a.deal?.title, dealId: a.dealId, cnpj: cnpjAdit };
        try {
          // Idempotência durável (a coluna foi adicionada em 2026-05-28).
          if (await finhubAditivoApplied(a.documentId)) {
            aOut.skipped = 'already_applied';
            aditivos.push(aOut);
            continue;
          }
          const dp = await crmDealProducts(a.dealId);
          if (!dp) {
            aOut.error = 'no_deal_products';
            await logAudit(ctxA, 'aditivo', 'parse', 'error',
              `Aditivo '${a.documentName}' — DealProduct não encontrado pro deal ${a.dealId}`,
              { sent_document_id: a.id }, null);
            aditivos.push(aOut);
            continue;
          }
          aOut.setupTotal = dp.setupTotal;
          aOut.recurrenceTotal = dp.recurrenceTotal;
          aOut.primaryProductName = dp.primaryProductName;
          if (dp.setupTotal <= 0 && dp.recurrenceTotal <= 0) {
            aOut.skipped = 'no_financial_value';
            await logAudit(ctxA, 'aditivo', 'parse', 'skip',
              `Aditivo '${a.documentName}' sem setup nem recorrência (deal ${a.dealId})`, dp, null);
            aditivos.push(aOut);
            continue;
          }
          const newProductKey = mapCrmProductNameToKey(dp.primaryProductName);
          const newCatMap = newProductKey ? PRODUCT_MAP[newProductKey] : null;
          // Localiza CA customer (por CNPJ; se não tiver, falha — aditivo sem cliente CA fica em pending pra revisão)
          let customer = null;
          if (cnpjAdit) customer = await findCustomerByCnpj(cnpjAdit);
          if (!customer) {
            aOut.error = `ca_customer_not_found cnpj=${cnpjAdit || 'null'}`;
            await logAudit(ctxA, 'aditivo', 'customer', 'error',
              `CA customer não localizado p/ aditivo (cnpj=${cnpjAdit || 'null'}, name=${ctxA.client_name})`,
              { sent_document_id: a.id }, null);
            aditivos.push(aOut);
            continue;
          }
          const customerId = customer.id || customer.uuid;
          aOut.ca_customer_id = customerId;
          const searchTerm = a.deal?.organization?.name || ctxA.client_name;

          // 6a) Setup (avulsa) — mesma idempotência + gate do fluxo Contract
          if (dp.setupTotal > 0) {
            const tSetup = Date.now();
            try {
              const existingSetup = await findSetupSaleByCustomer(customerId, dp.setupTotal, searchTerm);
              if (existingSetup) {
                aOut.ca_setup = { id: existingSetup.id, number: existingSetup.number, reused: true, value: dp.setupTotal };
                await logAudit(ctxA, 'aditivo_setup', 'reuse', 'reused',
                  `Setup R$${dp.setupTotal} já existe na CA (#${existingSetup.number})`,
                  { id: existingSetup.id }, tSetup);
              } else if (SETUP_AUTOCREATE) {
                aOut.ca_setup = await createSetupSale(customerId, {
                  produto: dp.primaryProductName || a.deal?.title || '',
                  valorImplementacao: dp.setupTotal,
                  dataAssinatura: a.updatedAt || new Date().toISOString(),
                  sellerEmail: null,
                }, { testMode: false });
                await logAudit(ctxA, 'aditivo_setup', 'create', 'ok',
                  `Setup R$${dp.setupTotal} criado via aditivo (#${aOut.ca_setup?.number})`,
                  aOut.ca_setup, tSetup);
              } else {
                aOut.ca_setup_pending = `Criar setup R$${dp.setupTotal} (SETUP_AUTOCREATE off)`;
                await logAudit(ctxA, 'aditivo_setup', 'skip', 'pending',
                  `Setup R$${dp.setupTotal} via aditivo pendente (autocreate off)`, null, tSetup);
              }
            } catch (e) {
              aOut.ca_setup_error = e.message;
              await logAudit(ctxA, 'aditivo_setup', 'create', 'error', e.message, null, tSetup);
            }
          }

          // 6b) MRR upsell (PUT scheduled-sale) — current_gross + recurrenceTotal = novoValor
          if (dp.recurrenceTotal > 0) {
            const tMRR = Date.now();
            try {
              const sched = await findScheduledSaleByCustomer(customerId, searchTerm);
              if (!sched) {
                aOut.ca_mrr_error = 'no_scheduled_sale';
                await logAudit(ctxA, 'aditivo_mrr', 'lookup', 'error',
                  `Sem scheduled-sale do cliente — não pode incrementar MRR`, null, tMRR);
              } else {
                let oldGross = null, oldCat = null, oldDueDay = 10;
                const full = await caRequest('GET', `/app/v1/scheduled-sales/${sched.id}`);
                if (full.status === 200 && full.body) {
                  oldCat = full.body.categoryId || null;
                  oldDueDay = full.body.paymentCondition?.dueDay || 10;
                  if (full.body.saleId) {
                    const itR = await caRequest('GET',
                      `/search-engine-core/v1/sales/${full.body.saleId}/items?page=1&page_size=10`);
                    const its = itR.body?.items || [];
                    oldGross = Math.round(its.reduce((s, it) =>
                      s + (Number(it.value) || 0) * (Number(it.amount) || 1), 0) * 100) / 100;
                  }
                }
                if (oldGross == null || oldGross <= 0) {
                  aOut.ca_mrr_error = 'cannot_read_current_gross';
                  await logAudit(ctxA, 'aditivo_mrr', 'read', 'error',
                    `Não foi possível ler bruto atual do scheduled-sale ${sched.id} — abort upsell`,
                    { sched_id: sched.id }, tMRR);
                } else if (!newProductKey || !newCatMap) {
                  aOut.ca_mrr_error = `cannot_map_product:${dp.primaryProductName}`;
                  await logAudit(ctxA, 'aditivo_mrr', 'map', 'error',
                    `Não mapeou Product '${dp.primaryProductName}' p/ PRODUCT_MAP — abort upsell`,
                    dp, tMRR);
                } else {
                  const novoValor = Math.round((oldGross + dp.recurrenceTotal) * 100) / 100;
                  const productChanged = !!(oldCat && newCatMap.cat && oldCat !== newCatMap.cat);
                  aOut.ca_mrr_upsell = await updateScheduledSaleForUpsell(
                    sched.id, customerId, newProductKey, novoValor, oldDueDay, searchTerm
                  );
                  aOut.old_gross = oldGross;
                  aOut.new_gross = novoValor;
                  aOut.product_changed = productChanged;
                  await logAudit(ctxA, 'aditivo_mrr', 'upsell', 'ok',
                    `MRR upsell aditivo: ${oldGross} + ${dp.recurrenceTotal} = ${novoValor} (productChanged=${productChanged})`,
                    aOut.ca_mrr_upsell, tMRR);
                }
              }
            } catch (e) {
              aOut.ca_mrr_error = e.message;
              await logAudit(ctxA, 'aditivo_mrr', 'upsell', 'error', e.message, null, tMRR);
            }
          }

          // Marca idempotência durável (mesmo com erro parcial — não tenta de novo automático)
          aOut.ok = !aOut.ca_setup_error && !aOut.ca_mrr_error;
          await markAditivoApplied(a.documentId, aOut);
        } catch (e) {
          aOut.ok = false;
          aOut.error = e.message;
          await logAudit(ctxA, 'aditivo', 'pipeline', 'error', e.message,
            { stack: e.stack?.slice(0, 500) }, null);
        }
        aditivos.push(aOut);
      }
    }
  } catch (e) {
    console.warn('[aditivo-scan fail]', e.message);
  }

  return { scanned: r.body?.length || 0, eligible: eligible.length, skipped, results, aditivos_signed_48h: aditivos };
}

// Background poll (se SCAN_INTERVAL_SEC > 0)
let scanLoopActive = false;
async function scanLoopOnce() {
  if (scanLoopActive) return;
  scanLoopActive = true;
  try {
    const r = await scanAndProcessTest();
    if (r.eligible > 0 || r.results.length > 0) {
      console.log('[scan]', JSON.stringify(r));
    }
  } catch (e) {
    console.error('[scan-error]', e.message);
  } finally {
    scanLoopActive = false;
  }
}

// ---------- HTTP server ----------
function checkAuth(req, res, opts = {}) {
  if (!ADMIN_TOKEN) return true; // dev mode
  const h = req.headers['authorization'] || '';
  // Aceita Bearer (curl/api) E Basic (browser popup)
  const bearer = h.match(/^Bearer\s+(.+)$/i);
  if (bearer && bearer[1] === ADMIN_TOKEN) return true;
  const basic = h.match(/^Basic\s+(.+)$/i);
  if (basic) {
    const dec = Buffer.from(basic[1], 'base64').toString('utf-8');
    const colon = dec.indexOf(':');
    const pw = colon >= 0 ? dec.slice(colon + 1) : dec;
    if (pw === ADMIN_TOKEN) return true;
  }
  // Se for HTML route, manda WWW-Authenticate pro browser pedir creds
  if (opts.allowBasic) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="CA Push Service"',
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end('Login: deixe usuario vazio, senha = ADMIN_TOKEN');
    return false;
  }
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const send = (s, obj) => {
    res.writeHead(s, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj, null, 2));
  };

  if (req.method === 'GET' && u.pathname === '/health') {
    return send(200, { ok: true, ts: Date.now(), version: SERVICE_VERSION, kill_switch: KILL_SWITCH, gate_keyword: TESTE_KEYWORD || '(disabled — processa todos)', setup_autocreate: SETUP_AUTOCREATE, scan_interval_sec: SCAN_INTERVAL_SEC });
  }

  if (!checkAuth(req, res)) return;

  // Tela de auditoria (HTML)
  if (req.method === 'GET' && u.pathname === '/admin/log') {
    try {
      const cnpjFilter = u.searchParams.get('cnpj');
      const statusFilter = u.searchParams.get('status');
      const limit = parseInt(u.searchParams.get('limit') || '200', 10);
      let q = `/bgp_pipeline_audit?select=*&order=ts.desc&limit=${limit}`;
      if (cnpjFilter) q += `&cnpj=eq.${cnpjFilter.replace(/\D/g,'')}`;
      if (statusFilter) q += `&status=eq.${statusFilter}`;
      const r = await finhubRest('GET', q);
      const rows = Array.isArray(r.body) ? r.body : [];
      const grouped = {};
      for (const row of rows) {
        const key = row.run_id;
        if (!grouped[key]) grouped[key] = { run_id: row.run_id, cnpj: row.cnpj, client_name: row.client_name, ts: row.ts, steps: [] };
        grouped[key].steps.push(row);
      }
      const runs = Object.values(grouped).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
      const statusColor = (s) => s === 'ok' ? '#16a34a' : s === 'error' ? '#dc2626' : s === 'reused' ? '#0891b2' : s === 'pending' ? '#d97706' : '#64748b';
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>BGP Pipeline Audit</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; margin: 20px; background: #f8fafc; }
  h1 { font-size: 20px; }
  .filters { background: white; padding: 12px; border-radius: 8px; margin-bottom: 16px; border: 1px solid #e2e8f0; }
  input, button, select { padding: 6px 10px; border: 1px solid #cbd5e1; border-radius: 4px; margin: 0 4px; }
  button { background: #2563eb; color: white; border: none; cursor: pointer; }
  .run { background: white; border: 1px solid #e2e8f0; border-radius: 8px; margin: 10px 0; padding: 12px 16px; }
  .run-header { display: flex; justify-content: space-between; font-size: 13px; color: #475569; margin-bottom: 6px; }
  .run-title { font-weight: 600; color: #0f172a; font-size: 14px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  th { font-size: 11px; text-transform: uppercase; color: #64748b; font-weight: 600; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; color: white; font-size: 11px; font-weight: 600; }
  .step { font-family: ui-monospace, monospace; font-size: 11px; color: #1e293b; }
  .detail { color: #475569; max-width: 500px; }
  details { margin-top: 4px; }
  details summary { cursor: pointer; color: #2563eb; font-size: 11px; }
  pre { background: #f1f5f9; padding: 8px; border-radius: 4px; overflow-x: auto; font-size: 11px; max-height: 200px; }
  .muted { color: #94a3b8; font-size: 11px; }
</style></head><body>
<h1>📊 BGP Pipeline Audit</h1>
<form class="filters" method="GET">
  CNPJ: <input name="cnpj" value="${cnpjFilter||''}" placeholder="só dígitos">
  Status: <select name="status">
    <option value="">todos</option>
    <option value="ok" ${statusFilter==='ok'?'selected':''}>ok</option>
    <option value="error" ${statusFilter==='error'?'selected':''}>error</option>
    <option value="reused" ${statusFilter==='reused'?'selected':''}>reused</option>
    <option value="pending" ${statusFilter==='pending'?'selected':''}>pending</option>
  </select>
  Limit: <input name="limit" value="${limit}" type="number" min="10" max="1000" style="width:80px">
  <button type="submit">filtrar</button>
  <span class="muted">| ${rows.length} eventos, ${runs.length} runs</span>
</form>
${runs.map(run => {
  const errors = run.steps.filter(s => s.status === 'error').length;
  return `<div class="run">
    <div class="run-header">
      <span class="run-title">${run.client_name || '(sem nome)'} · CNPJ ${run.cnpj || '?'}</span>
      <span class="muted">${run.ts} · run ${run.run_id?.slice(0,8)} · ${run.steps.length} steps${errors?` · <b style="color:#dc2626">${errors} erros</b>`:''}</span>
    </div>
    <table><thead><tr><th>step</th><th>action</th><th>status</th><th>detail</th><th>ms</th></tr></thead><tbody>
    ${run.steps.sort((a,b)=>(a.ts||'').localeCompare(b.ts||'')).map(s => `
      <tr>
        <td class="step">${s.step}</td>
        <td>${s.action}</td>
        <td><span class="badge" style="background:${statusColor(s.status)}">${s.status}</span></td>
        <td class="detail">${(s.detail||'').replace(/</g,'&lt;')}${s.payload ? `<details><summary>payload</summary><pre>${JSON.stringify(s.payload,null,2).replace(/</g,'&lt;')}</pre></details>` : ''}</td>
        <td>${s.duration_ms ?? ''}</td>
      </tr>`).join('')}
    </tbody></table>
  </div>`;
}).join('')}
${runs.length === 0 ? '<p class="muted">Nenhum evento. Tabela bgp_pipeline_audit existe? Rode o SQL em audit-table.sql no Supabase do FinHub.</p>' : ''}
</body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Erro: ${e.message}`);
      return;
    }
  }

  if (req.method === 'GET' && u.pathname === '/probe') {
    // Quick CA token sanity check
    const r = await caRequest('GET', '/app/v1/scheduled-sales/next-number');
    return send(200, { ca_status: r.status, response: r.body });
  }

  // Endpoint dedicado pra aplicar desconto: POST /apply-discount/{schedId}?meses=3&pct=10&valor=123&searchTerm=...
  if (req.method === 'POST' && u.pathname.startsWith('/apply-discount/')) {
    try {
      const schedId = u.pathname.split('/').pop();
      const meses = parseInt(u.searchParams.get('meses') || '0', 10);
      const pct = parseFloat(u.searchParams.get('pct') || '0');
      const valor = parseFloat(u.searchParams.get('valor') || '0');
      const term = u.searchParams.get('searchTerm') || '';
      if (!schedId || !meses || !pct || !valor) {
        return send(400, { error: 'meses, pct, valor required' });
      }
      const r = await applyDiscountToFirstN(schedId, meses, pct, valor, term);
      return send(200, r);
    } catch (e) {
      return send(500, { error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'POST' && u.pathname === '/scan') {
    try {
      const force = u.searchParams.get('force') === 'true' || u.searchParams.get('force') === '1';
      const r = await scanAndProcessTest({ force });
      return send(200, r);
    } catch (e) {
      return send(500, { error: e.message, stack: e.stack });
    }
  }

  if (req.method === 'GET' && u.pathname === '/lookup') {
    const cnpj = u.searchParams.get('cnpj');
    if (!cnpj) return send(400, { error: 'cnpj query required' });
    const found = await findCustomerByCnpj(cnpj);
    return send(200, { found: !!found, customer: found });
  }

  if (req.method === 'POST' && u.pathname === '/push-contract') {
    let body = '';
    for await (const c of req) body += c;
    let input;
    try { input = JSON.parse(body); } catch { return send(400, { error: 'invalid json' }); }

    const out = { ok: false, started_at: new Date().toISOString() };
    try {
      const opts = input.options || {};
      // 1) lookup or create customer
      const existing = await findCustomerByCnpj(input.customer.cnpj);
      let customer;
      if (existing) {
        customer = { id: existing.id || existing.uuid, legacyId: existing.legacyId, created: false, cnpj: input.customer.cnpj };
      } else if (opts.dryRun) {
        customer = { id: '<would-create>', created: true, cnpj: input.customer.cnpj, dryRun: true };
      } else {
        customer = await createCustomer(input.customer, opts);
        customer.cnpj = input.customer.cnpj;
      }
      out.customer = customer;

      if (opts.dryRun) {
        out.ok = true;
        out.note = 'dry-run: nao criou contrato nem setup';
        return send(200, out);
      }

      // 2) recurring contract
      out.scheduledSale = await createScheduledSale(customer.id, input.contract, opts);

      // 3) optional setup
      if (Number(input.contract.valorImplementacao) > 0) {
        out.setupSale = await createSetupSale(customer.id, input.contract, opts);
      }

      out.ok = true;
      out.finished_at = new Date().toISOString();
      return send(200, out);
    } catch (e) {
      out.error = e.message;
      out.stack = e.stack;
      return send(500, out);
    }
  }

  if (req.method === 'DELETE' && u.pathname.startsWith('/scheduled-sales/')) {
    const id = u.pathname.split('/').pop();
    const r = await caRequest('DELETE', `/app/v1/scheduled-sales/${id}`);
    return send(r.status, r.body || { ok: r.status === 200 });
  }

  if (req.method === 'DELETE' && u.pathname.startsWith('/sales/')) {
    const id = u.pathname.split('/').pop();
    // venda avulsa — endpoint TBD, tentativa
    const r = await caRequest('DELETE', `/app/v1/sales/${id}`);
    return send(r.status, r.body || { ok: r.status === 200 });
  }

  send(404, { error: 'not found', method: req.method, path: u.pathname });
});

server.listen(PORT, () => {
  console.log('================================================');
  console.log(`CA Push Service rodando em :${PORT}`);
  console.log(`  POST /push-contract  (cria cliente + contrato + setup, direto)`);
  console.log(`  POST /scan           (vasculha CRM, processa Contracts SIGNED com '${TESTE_KEYWORD}' no nome)`);
  console.log(`  GET  /lookup?cnpj=X  (busca cliente)`);
  console.log(`  GET  /probe          (sanity check)`);
  console.log(`  DELETE /scheduled-sales/{id}`);
  console.log(`  DELETE /sales/{id}`);
  console.log(`  GET  /health         (public)`);
  console.log(`  Auth: Bearer ADMIN_TOKEN`);
  console.log(`  CRM_SERVICE_KEY: ${CRM_SERVICE_KEY ? 'OK' : 'MISSING'}`);
  console.log(`  FINHUB_SERVICE_KEY: ${FINHUB_SERVICE_KEY ? 'OK' : 'MISSING (CA only)'}`);
  console.log('================================================');
  if (SCAN_INTERVAL_SEC > 0) {
    console.log(`[bg-scan] Loop ativo a cada ${SCAN_INTERVAL_SEC}s`);
    setInterval(scanLoopOnce, SCAN_INTERVAL_SEC * 1000);
  }
});
