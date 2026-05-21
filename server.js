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

// Gate: somente clientes com esse keyword no nome (case-insensitive) entram no funil novo
const TESTE_KEYWORD = (process.env.TESTE_KEYWORD || 'teste').toLowerCase();

// Background scan interval (segundos). 0 = desativado.
const SCAN_INTERVAL_SEC = parseInt(process.env.SCAN_INTERVAL_SEC || '0', 10);

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

// Aplica desconto nas N primeiras parcelas geradas (idempotente — pode rodar várias vezes sem duplicar efeito)
async function applyDiscountToFirstN(schedId, descontoMeses, descontoPercentual, valorMensal) {
  if (!descontoMeses || !descontoPercentual) return [];
  const N = Math.floor(descontoMeses);
  const descontoVal = Math.round((valorMensal * descontoPercentual / 100) * 100) / 100;
  const baseCom = Math.round((valorMensal - descontoVal) * 100) / 100;

  // GET instances (sale instances geradas pelo scheduled-sale)
  const search = await caRequest('POST', '/contaazul-bff/sale/v1/sales/searches?page=1&page_size=50', { searchTerm: '' });
  const linked = (search.body?.items || [])
    .filter(it => it.type === 'SCHEDULED_SALE' && it.schedule?.id === schedId)
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  const targets = linked.slice(0, N);
  if (targets.length === 0) return [];

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
  return results;
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

// Cria cliente no FinHub direto via REST (service_role bypassa RLS).
// Pula edge function create-client porque ela exige JWT de user 'team'.
async function finhubCreateClient(payload) {
  // 1) Dedup por CNPJ
  const cnpj = (payload.cnpj || '').replace(/\D/g, '');
  if (cnpj) {
    const dup = await finhubRest('GET', `/clients?cnpj=eq.${cnpj}&select=id,name&limit=1`);
    if (dup.status === 200 && Array.isArray(dup.body) && dup.body.length > 0) {
      return { reused: true, id: dup.body[0].id, name: dup.body[0].name };
    }
  }
  // 2) INSERT
  const now = new Date().toISOString();
  const row = {
    name: payload.name,
    company: payload.company || payload.name,
    email: payload.email || null,
    phone: payload.phone || null,
    cnpj: cnpj || null,
    status: 'ativo',
    data_entrada: now.slice(0, 10),
    conta_azul_code: payload.conta_azul_code || null,
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
  return { reused: false, id: created.id, name: created.name };
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

  const eligible = [];
  const skipped = [];
  for (const c of (r.body || [])) {
    // Gate name match — checa razaoSocial, contact.name, organization.name
    const names = [c.razaoSocial, c.deal?.organization?.name, c.deal?.contact?.name, c.deal?.title]
      .filter(Boolean).map(s => String(s).toLowerCase());
    const matchesGate = names.some(n => n.includes(TESTE_KEYWORD));
    if (!matchesGate) { skipped.push({ id: c.id, reason: 'no_teste_in_name', names }); continue; }
    if (!force && processedContracts.has(c.id)) { skipped.push({ id: c.id, reason: 'already_processed_inmem' }); continue; }
    eligible.push(c);
  }

  const results = [];
  for (const c of eligible) {
    const out = { contract_id: c.id, started_at: new Date().toISOString() };
    try {
      const org = c.deal?.organization || {};
      const contact = c.deal?.contact || {};
      const cnpj = (c.cnpj || org.cnpj || '').replace(/\D/g, '');

      // 2) Customer: dedup OR create
      const existing = await findCustomerByCnpj(cnpj);
      if (existing) {
        out.ca_customer = { id: existing.id || existing.uuid, reused: true };
      } else {
        out.ca_customer = await createCustomer({
          cnpj,
          razaoSocial: c.razaoSocial,
          nomeFantasia: c.nomeFantasia || '',
          email: c.emailRepresentante || contact.email || '',
          telefone: contact.phone || org.phone || '',
          emailFinanceiro: c.emailFinanceiro || c.emailRepresentante,
          endereco: c.endereco || '',
        }, { testMode: true });
      }

      // 3) Scheduled-sale: dedup por customer (reusa se já existe ativo)
      const existingSched = await findScheduledSaleByCustomer(out.ca_customer.id, c.razaoSocial || '');
      if (existingSched) {
        out.ca_scheduledSale = {
          id: existingSched.id,
          legacyId: existingSched.legacyId,
          number: existingSched.template?.terms?.number,
          reused: true,
        };
      } else {
        out.ca_scheduledSale = await createScheduledSale(out.ca_customer.id, {
          produto: c.produto,
          valorMensal: Number(c.valorMensal),
          diaVencimento: Number(c.diaVencimento || 10),
          dataAssinatura: c.autentiqueSignedAt || c.dataInicio || new Date().toISOString(),
          sellerEmail: c.deal?.user?.email,
        }, { testMode: true });
      }

      // 3.5) Aplica desconto nas N primeiras parcelas (idempotente)
      if (Number(c.descontoMeses) > 0 && Number(c.descontoPercentual) > 0) {
        try {
          out.ca_discounts = await applyDiscountToFirstN(
            out.ca_scheduledSale.id,
            Number(c.descontoMeses),
            Number(c.descontoPercentual),
            Number(c.valorMensal)
          );
        } catch (e) {
          out.ca_discount_error = e.message;
        }
      }

      // 4) Setup avulso (idempotência: skip se ja existe sale avulsa com o mesmo valor pro customer)
      if (Number(c.valorImplementacao) > 0) {
        try {
          // Procura venda avulsa existente pra mesmo customer e mesmo valor (heuristica)
          const sr = await caRequest('POST', '/contaazul-bff/sale/v1/sales/searches?page=1&page_size=50', { searchTerm: c.razaoSocial || '' });
          const existingAvulsa = (sr.body?.items || []).find(it =>
            it.type === 'SALE' &&
            it.customer?.id === out.ca_customer.id &&
            Math.abs((it.paymentCondition?.installments?.[0]?.value || 0) - Number(c.valorImplementacao)) < 0.01
          );
          if (existingAvulsa) {
            out.ca_setupSale = { id: existingAvulsa.id, legacyId: existingAvulsa.legacyId, reused: true };
          } else {
            out.ca_setupSale = await createSetupSale(out.ca_customer.id, {
              produto: c.produto,
              valorImplementacao: Number(c.valorImplementacao),
              dataAssinatura: c.autentiqueSignedAt || c.dataInicio || new Date().toISOString(),
              sellerEmail: c.deal?.user?.email,
            }, { testMode: true });
          }
        } catch (e) {
          out.ca_setupSale_error = e.message;
        }
      }

      // 3b) Push to FinHub (insert direto em clients, bypassa edge function)
      if (FINHUB_SERVICE_KEY) {
        try {
          const fin = await finhubCreateClient({
            name: c.razaoSocial,
            company: c.razaoSocial,
            email: c.emailFinanceiro || c.emailRepresentante,
            phone: contact.phone || org.phone || '',
            cnpj,
            conta_azul_code: out.ca_customer?.id || null,
            erp_cliente: 'contaazul',
            observacoes: `[TEST E2E PIPELINE] CRM Contract=${c.id} | Deal=${c.deal?.id} | CA customer=${out.ca_customer?.id || '?'} | CA scheduled-sale=${out.ca_scheduledSale?.id || '?'}`,
          });
          out.finhub = fin;
        } catch (e) {
          out.finhub_error = e.message;
        }
      } else {
        out.finhub_skipped = 'FINHUB_SERVICE_KEY nao configurada';
      }

      processedContracts.add(c.id);
      out.ok = true;
    } catch (e) {
      out.ok = false;
      out.error = e.message;
    }
    out.finished_at = new Date().toISOString();
    results.push(out);
  }

  return { scanned: r.body?.length || 0, eligible: eligible.length, skipped, results };
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
function checkAuth(req, res) {
  if (!ADMIN_TOKEN) return true; // dev mode
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m && m[1] === ADMIN_TOKEN) return true;
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
    return send(200, { ok: true, ts: Date.now() });
  }

  if (!checkAuth(req, res)) return;

  if (req.method === 'GET' && u.pathname === '/probe') {
    // Quick CA token sanity check
    const r = await caRequest('GET', '/app/v1/scheduled-sales/next-number');
    return send(200, { ca_status: r.status, response: r.body });
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
