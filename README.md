# CA Push Service

Recebe Contract data e cria cliente + venda recorrente (e opcional setup avulso) na Conta Azul Pro de Bertuzzi.

## Env vars

| Nome | Obrig | Descrição |
|------|-------|-----------|
| `ADMIN_TOKEN` | sim | Bearer token pra autenticar chamadas |
| `CA_XAUTH` | sim | Token X-Authorization da CA Pro |
| `PORT` | não | default 5455 |

## Endpoints

### `POST /push-contract`

Body:
```json
{
  "customer": {
    "cnpj": "12345678000190",
    "razaoSocial": "...",
    "nomeFantasia": "...",
    "email": "...",
    "telefone": "...",
    "emailFinanceiro": "...",
    "endereco": "..."
  },
  "contract": {
    "produto": "bgp-bi",
    "valorMensal": 1997.00,
    "diaVencimento": 10,
    "dataAssinatura": "2026-05-21",
    "valorImplementacao": null,
    "sellerEmail": "vitor@bertuzzipatrimonial.com.br"
  },
  "options": { "dryRun": false, "testMode": true }
}
```

Response 200:
```json
{
  "ok": true,
  "customer": { "id": "<uuid>", "legacyId": 123, "created": true },
  "scheduledSale": { "id": "<uuid>", "legacyId": 123, "number": 530 },
  "setupSale": { "id": "<uuid>", "legacyId": 123 }
}
```

### `GET /lookup?cnpj=X` - busca cliente
### `GET /probe` - sanity check do token CA
### `DELETE /scheduled-sales/{id}` - apaga contrato
### `DELETE /sales/{id}` - tenta apagar venda avulsa
### `GET /health` - liveness (público)

## Produtos suportados

`bgp-go-i`, `bgp-go-ii`, `bgp-go-iii`, `bgp-bi`, `bgp-bi-personalizado`, `bgp-strategy`, `bgp-valuation`, `brand-growth`, `go-aimo`, `gestao-condominial`
