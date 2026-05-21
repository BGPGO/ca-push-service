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
    commercialPhone: cleanCnpj(c.telefone || ''),
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
      phoneNumber: cleanCnpj(c.telefoneFinanceiro || c.telefone || ''),
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

async function createScheduledSale(customerId, contract, opts) {
  const productKey = (contract.produto || '').toLowerCase().trim();
  const map = PRODUCT_MAP[productKey];
  if (!map) throw new Error(`Produto desconhecido: '${contract.produto}'. Conhecidos: ${Object.keys(PRODUCT_MAP).join(', ')}`);

  const sellerId = SELLER_MAP[(contract.sellerEmail || '').toLowerCase()] || DEFAULTS.sellerId;
  const valor = Number(contract.valorMensal);
  if (!valor || valor <= 0) throw new Error(`valorMensal invalido: ${contract.valorMensal}`);

  const tax = await calcTaxes(valor);
  const nextNum = await nextContractNumber();

  const emissionDate = firstDayNextMonth(contract.dataAssinatura);
  const startDate = String(contract.dataAssinatura).slice(0, 10);
  const dueDay = parseInt(contract.diaVencimento, 10) || 5;
  const firstDueDate = firstDueAfter(emissionDate, dueDay);

  const body = {
    emissionDate,
    customerId,
    terms: {
      number: nextNum,
      frequencyType: 'MONTH',
      frequencyRange: 1,
      expirationType: 'FOREVER',
      startDate,
      endDate: null,
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

  const productKey = (contract.produto || '').toLowerCase().trim();
  const map = PRODUCT_MAP[productKey];
  if (!map) throw new Error(`Produto desconhecido: '${contract.produto}'`);

  const sellerId = SELLER_MAP[(contract.sellerEmail || '').toLowerCase()] || DEFAULTS.sellerId;
  const tax = await calcTaxes(valor);
  const committedDate = String(contract.dataAssinatura).slice(0, 10);

  const body = {
    customerId,
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
  console.log(`  POST /push-contract  (cria cliente + contrato + setup)`);
  console.log(`  GET  /lookup?cnpj=X   (busca cliente)`);
  console.log(`  GET  /probe           (sanity check)`);
  console.log(`  DELETE /scheduled-sales/{id}`);
  console.log(`  DELETE /sales/{id}`);
  console.log(`  GET  /health          (public)`);
  console.log(`  Auth: Bearer ADMIN_TOKEN`);
  console.log('================================================');
});
