import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryRoot = new URL("../../..", import.meta.url);

async function source(path) {
  return readFile(new URL(path, repositoryRoot), "utf8");
}

test("finance and approval reads and R3 mutations use v1", async () => {
  const [page, finance, exceptions] = await Promise.all([
    source("app/page.tsx"),
    source("app/components/FinanceWorkspace.tsx"),
    source("app/components/FinanceExceptionWorkspace.tsx"),
  ]);

  assert.match(page, /apiJson\("\/api\/v1\/approvals"\)/u);
  assert.match(page, /mutateJson\("\/api\/v1\/approvals", "POST"/u);
  assert.match(finance, /requestJson\("\/api\/v1\/finance"\)/u);
  assert.match(finance, /mutateJson\("\/api\/v1\/finance", "POST"/u);
  assert.match(exceptions, /json\("\/api\/v1\/finance"\)/u);
  assert.match(exceptions, /mutateJson\("\/api\/v1\/finance", "POST"/u);
  assert.doesNotMatch([page, finance, exceptions].join("\n"), /["'`]\/api\/(?:approvals|finance)["'`]/u);
});

test("inventory and logistics reads and R3 mutations use v1", async () => {
  const [inventory, stocktakes, warehouses, shipping] = await Promise.all([
    source("app/components/InventoryWorkspace.tsx"),
    source("app/components/StocktakeWorkspace.tsx"),
    source("app/components/WarehouseWorkspace.tsx"),
    source("app/components/ShippingWorkspace.tsx"),
  ]);

  assert.match(inventory, /fetch\("\/api\/v1\/inventory"/u);
  assert.match(inventory, /mutateJson(?:<[^\n]+>)?\(\s*"\/api\/v1\/inventory", "POST"/u);
  assert.match(inventory, /mutateJson\("\/api\/v1\/inventory\/transfers", "PATCH"/u);
  assert.match(stocktakes, /fetch\("\/api\/v1\/stocktakes"/u);
  assert.match(stocktakes, /mutateJson\("\/api\/v1\/stocktakes", "POST"/u);
  assert.match(warehouses, /fetch\("\/api\/v1\/warehouses"/u);
  assert.match(warehouses, /mutateJson\("\/api\/v1\/warehouses", "POST"/u);
  assert.match(shipping, /jsonRequest\("\/api\/v1\/shipments"\)/u);
  assert.match(shipping, /post\("\/api\/v1\/shipments"/u);
  assert.match(shipping, /jsonRequest\("\/api\/v1\/returns"\)/u);
  assert.match(shipping, /post\("\/api\/v1\/returns"/u);
  assert.doesNotMatch([inventory, stocktakes, warehouses, shipping].join("\n"),
    /["'`]\/api\/(?:inventory|stocktakes|warehouses|shipments|returns)(?:["'`/])/u);
});

test("production and R2 supplier mutations use their typed v1 adapters", async () => {
  const [production, suppliers, prices, performance, r2Client] = await Promise.all([
    source("app/components/ProductionWorkspace.tsx"),
    source("app/components/SupplierWorkspace.tsx"),
    source("app/components/SupplierPriceWorkspace.tsx"),
    source("app/components/SupplierPerformanceWorkspace.tsx"),
    source("app/lib/r2-mutation-client.ts"),
  ]);

  assert.match(production, /fetch\("\/api\/v1\/production-orders"/u);
  assert.match(production, /mutateJson\("\/api\/v1\/production-orders", method/u);
  assert.doesNotMatch(production, /["'`]\/api\/production-orders["'`]/u);
  assert.match(suppliers, /fetch\("\/api\/v1\/suppliers"\)/u);
  assert.match(suppliers, /fetch\("\/api\/v1\/supplier-skus"\)/u);
  assert.match(suppliers, /writeSupplier/u);
  assert.match(suppliers, /writeSupplierSku/u);
  assert.match(prices, /fetch\("\/api\/v1\/supplier-prices"/u);
  assert.match(prices, /writeSupplierPrice/u);
  assert.match(performance, /fetch\(`\/api\/v1\/supplier-performance\?/u);
  assert.match(performance, /window\.location\.href = `\/api\/v1\/supplier-performance\?/u);
  assert.match(performance, /writeSupplierPerformance/u);
  assert.doesNotMatch([suppliers, prices, performance].join("\n"), /fetch\([`"]\/api\/(?:suppliers|supplier-skus|supplier-prices|supplier-performance)/u);
  assert.match(r2Client, /"\/api\/v1\/supplier-prices"/u);
});

test("session, purchase reads, and purchase mutations use v1", async () => {
  const [page, purchase, r2Client] = await Promise.all([
    source("app/page.tsx"),
    source("app/components/PurchaseWorkspace.tsx"),
    source("app/lib/r2-mutation-client.ts"),
  ]);

  assert.match(page, /fetch\("\/api\/v1\/session"\)/u);
  assert.match(purchase, /fetch\("\/api\/v1\/purchase-plans"/u);
  assert.match(purchase, /fetch\("\/api\/v1\/purchase-orders"/u);
  assert.match(purchase, /fetch\("\/api\/v1\/session"/u);
  assert.match(purchase, /updatePurchasePlan/u);
  assert.match(purchase, /updatePurchaseOrder/u);
  assert.doesNotMatch(purchase, /fetch\([`"]\/api\/(?:purchase-plans|purchase-orders)/u);
  assert.match(r2Client, /"\/api\/v1\/purchase-plans"/u);
  assert.match(r2Client, /"\/api\/v1\/purchase-orders"/u);
});

test("platform user mutations and file uploads use the typed v1 mutation seam", async () => {
  const [page, audit, finance, shipping, client] = await Promise.all([
    source("app/page.tsx"),
    source("app/components/AuditWorkspace.tsx"),
    source("app/components/FinanceWorkspace.tsx"),
    source("app/components/ShippingWorkspace.tsx"),
    source("app/lib/mutation-client.ts"),
  ]);

  assert.match(page, /apiJson\("\/api\/v1\/users"\)/u);
  assert.match(page, /mutateJson\("\/api\/v1\/users", "POST"/u);
  assert.match(page, /mutateJson\("\/api\/v1\/users", "PATCH"/u);
  assert.match(page, /mutateJson\("\/api\/v1\/users", "DELETE"/u);
  assert.match(audit, /fetch\(`\/api\/v1\/audit-logs\?/u);
  assert.doesNotMatch(audit, /fetch\(`\/api\/audit-logs\?/u);
  assert.match(finance, /uploadPlatformFile/u);
  assert.match(shipping, /uploadPlatformFile/u);
  assert.doesNotMatch([page, finance, shipping].join("\n"), /["'`]\/api\/(?:users|files)["'`]/u);
  assert.match(client, /sessionStorage\.setItem\(id, key\)/u);
  assert.match(client, /if \(!error\.outcomeUnknown\) sessionStorage\.removeItem/u);
  assert.match(client, /"NETWORK_OUTCOME_UNKNOWN"/u);
  assert.match(client, /"x-request-digest": requestDigest/u);
  assert.match(client, /waitForPlatformFile/u);
  assert.match(client, /topology:upload:/u);
  assert.match(client, /state\.fileId/u);
  assert.match(client, /FILE_SCAN_REJECTED/u);
  assert.match(finance, /entityType", "purchase_order"/u);
  assert.match(shipping, /"delivery_batch"/u);
  assert.match(shipping, /"product_return"/u);
  const supplierPrice = await source("app/components/SupplierPriceWorkspace.tsx");
  assert.match(supplierPrice, /entityType", "supplier_sku"/u);
});
