import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const fixtureFile = new URL("../../tests/e2e/fixtures/scope-a.fixture.json", import.meta.url);

export async function fixtureSha() {
  return createHash("sha256").update(await readFile(fixtureFile)).digest("hex");
}

function scalar(result) {
  const id = Number(result.insertId);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Fixture insert did not return an ID");
  return id;
}

async function insert(connection, sql, values) {
  const [result] = await connection.execute(sql, values);
  return scalar(result);
}

export async function seedScopeAFixture(connection, { runId, password }) {
  const tag = `E2E-${runId}`;
  const factoryId = await insert(connection,
    "INSERT INTO factories (name, code, status) VALUES (?, ?, 'active')",
    [`${tag} Factory`, `${tag}-F`]);
  const supplierId = await insert(connection,
    "INSERT INTO suppliers (code,name,tier,managed_by_factory_id,legal_name,unified_social_credit_code,address,contact_name,contact_phone,business_scope,status) VALUES (?,?,?,?,?,?,?,?,?,?, 'active')",
    [`${tag}-SUP`, `${tag} Supplier`, 1, factoryId, `${tag} Supplier Ltd`, `${tag}-CREDIT`, "test-only", "Test Contact", "13800138000", "test",]);
  const sku = `${tag}-FG-SKU`, componentSku = `${tag}-COMP-SKU`;
  await connection.execute("INSERT INTO skus (code,name,item_type,stock_unit,verification_status,status) VALUES (?,?,'finished','EA','approved','active')", [sku, `${tag} Finished SKU`]);
  await connection.execute("INSERT INTO skus (code,name,item_type,stock_unit,verification_status,status) VALUES (?,?,'component','EA','approved','active')", [componentSku, `${tag} Component SKU`]);
  const accounts = {};
  const roleSpecs = [
    ["admin", "admin", null, null], ["supply_chain", "supply_chain", null, null],
    ["factory", "factory", factoryId, null], ["approver", "supply_chain", null, null],
    ["finance", "finance", factoryId, null], ["denied", "supplier", null, supplierId],
  ];
  for (const [ref, role, userFactoryId, userSupplierId] of roleSpecs) {
    const userId = await insert(connection,
      "INSERT INTO users (email,mobile,name,role,factory_id,supplier_id,organization_name,account_status) VALUES (?,?,?,?,?,?,?, 'active')",
      [`${ref}.${runId}@e2e.invalid`, "13800138000", `${tag} ${ref}`, role, userFactoryId, userSupplierId, `${tag} Organization`]);
    const salt = randomBytes(16).toString("hex");
    const hash = pbkdf2Sync(password, Buffer.from(salt, "hex"), 210000, 32, "sha256").toString("hex");
    await connection.execute("INSERT INTO auth_credentials (user_id,password_hash,password_salt,failed_attempts) VALUES (?,?,?,0)", [userId, hash, salt]);
    await connection.execute("INSERT INTO user_roles (user_id,role_code,effective_from,status,requested_by) VALUES (?,?,'2026-01-01','active',?)", [userId, role, userId]);
    accounts[ref] = userId;
  }
  const bomId = await insert(connection,
    "INSERT INTO product_boms (finished_sku,version,effective_from,approval_status,active,created_by) VALUES (?,'E2E-1','2026-01-01','approved',true,?)", [sku, accounts.supply_chain]);
  await connection.execute("INSERT INTO bom_components (bom_id,component_sku,item_type,is_core,quantity_per_finished) VALUES (?,?,'component',true,1)", [bomId, componentSku]);
  const warehouseId = await insert(connection,
    "INSERT INTO warehouses (code,name,type,factory_id,address,status) VALUES (?,?, 'finished_goods', ?, 'test-only', 'active')", [`${tag}-WH`, `${tag} Warehouse`, factoryId]);
  const batchId = await insert(connection,
    "INSERT INTO inventory_batches (batch_no,warehouse_id,sku,inbound_date,available_quantity,locked_quantity,defective_quantity,pending_inspection_quantity,ownership,expiry_status) VALUES (?,?,?,'2026-01-01',100,0,0,0,'company','normal')", [`${tag}-BATCH`, warehouseId, sku]);
  const supplierSkuId = await insert(connection,
    "INSERT INTO supplier_skus (factory_id,supplier_id,sku,is_primary,priority,minimum_order_quantity,packaging_multiple,purchase_unit,effective_from,status,requested_by) VALUES (?,?,?,true,1,1,1,'EA','2026-01-01','approved',?)", [factoryId, supplierId, sku, accounts.supply_chain]);
  const pendingSupplierId = await insert(connection,
    "INSERT INTO suppliers (code,name,tier,managed_by_factory_id,legal_name,unified_social_credit_code,address,contact_name,contact_phone,business_scope,verification_status,status) VALUES (?,?,?,?,?,?,?,?,?,?, 'pending','draft')",
    [`${tag}-PENDING-SUP`, `${tag} Pending Supplier`, 1, null, `${tag} Pending Supplier Ltd`, `${tag}-PENDING-CREDIT`, "test-only", "Test Contact", "13800138001", "test"]);
  const pendingPayload = { code: `${tag}-PENDING-SUP`, name: `${tag} Pending Supplier`, tier: 1, managedByFactoryId: null, unifiedSocialCreditCode: `${tag}-PENDING-CREDIT`, businessLicenseFileKey: "e2e-fixture-not-executed", address: "test-only", contactName: "Test Contact", contactPhone: "13800138001", businessScope: "test" };
  const approvalId = await insert(connection,
    "INSERT INTO approval_requests (request_no,workflow_type,entity_type,entity_id,summary,payload_json,high_risk,status,requested_by) VALUES (?, 'supplier_onboarding','supplier',?,?,?,false,'pending',?)", [`${tag}-APR`, pendingSupplierId, `${tag} pending supplier onboarding`, JSON.stringify(pendingPayload), accounts.supply_chain]);
  await connection.execute("INSERT INTO resource_versions (resource_type,resource_id,version) VALUES ('approval_request',?,1)", [String(approvalId)]);
  const planId = await insert(connection,
    "INSERT INTO purchase_plans (plan_no,version,status,created_by) VALUES (?,1,'draft',?)", [`${tag}-PLAN`, accounts.supply_chain]);
  const planItemId = await insert(connection,
    "INSERT INTO purchase_plan_items (purchase_plan_id,expected_arrival_date,factory_id,warehouse_id,sku,product_name,bom_id,planned_quantity) VALUES (?,'2026-02-01',?,?,?,?,?,10)", [planId, factoryId, warehouseId, sku, `${tag} SKU`, bomId]);
  const purchaseOrderId = await insert(connection,
    "INSERT INTO purchase_orders (order_no,status,order_date,total_tax_included_minor) VALUES (?,'draft','2026-01-01',1000)", [`${tag}-PO`]);
  const orderItemId = await insert(connection,
    "INSERT INTO order_items (purchase_order_id,sku,product_name,item_type,supplier_id,quantity,unit_price_tax_included_minor,amount_tax_included_minor,due_date) VALUES (?,?,?,'finished',?,10,100,1000,'2026-02-01')", [purchaseOrderId, sku, `${tag} Finished SKU`, supplierId]);
  const executionOrderId = await insert(connection,
    "INSERT INTO execution_orders (execution_no,order_item_id,factory_id,bom_id,planned_quantity,status,due_date,planned_start_date,planned_finish_date) VALUES (?,?,?,?,10,'factory_confirmation','2026-02-01','2026-01-10','2026-01-20')", [`${tag}-EXE`, orderItemId, factoryId, bomId]);
  const qualityRuleId = await insert(connection,
    "INSERT INTO quality_rules (scope,sku,stage,minimum_pass_rate_bps,active,created_by) VALUES ('sku',?,'incoming',9500,true,?)", [sku, accounts.supply_chain]);
  const qualityInspectionId = await insert(connection,
    "INSERT INTO quality_inspections (execution_order_id,stage,inspection_method,batch_quantity,inspected_quantity,passed_quantity,failed_quantity,pass_rate_bps,quality_rule_id,system_result,final_result,inspector_type,submitted_by) VALUES (?,'incoming','full',10,10,10,0,10000,?,'passed','passed','company_qc',?)", [executionOrderId, qualityRuleId, accounts.supply_chain]);
  const stocktakeId = await insert(connection,
    "INSERT INTO stocktakes (stocktake_no,warehouse_id,scope,due_date,status,created_by,assigned_factory_id) VALUES (?,?,'full','2026-02-10','draft',?,?)", [`${tag}-ST`, warehouseId, accounts.supply_chain, factoryId]);
  const shipmentId = await insert(connection,
    "INSERT INTO delivery_batches (execution_order_id,batch_no,quantity,planned_ship_at,carrier,logistics_no,destination,status) VALUES (?,?,10,'2026-02-01T00:00:00.000Z','test-carrier',?,'test-only','planned')", [executionOrderId, `${tag}-SHIP`, `${tag}-LOG`]);
  const returnId = await insert(connection,
    "INSERT INTO product_returns (return_no,source_delivery_batch_id,warehouse_id,sku,quantity,status) VALUES (?,?,?,?,1,'received')", [`${tag}-RET`, shipmentId, warehouseId, sku]);
  const paymentRequestId = await insert(connection,
    "INSERT INTO factory_payment_requests (request_no,factory_id,actual_shipment_date,planned_payment_date,total_amount_minor,status,maintained_by) VALUES (?,?, '2026-02-01','2026-02-28',1000,'waiting_invoice',?)", [`${tag}-PAY`, factoryId, accounts.finance]);
  const invoiceId = await insert(connection,
    "INSERT INTO factory_invoices (factory_id,purchase_order_id,coverage_mode,delivery_batch_id,invoice_no,invoice_type,amount_tax_included_minor,tax_amount_minor,issued_at,status,expected_amount_minor,maintained_by) VALUES (?,?, 'single', ?,?,'vat',1000,0,'2026-02-01','pending',1000,?)", [factoryId, purchaseOrderId, shipmentId, `${tag}-INV`, accounts.finance]);
  return { accounts, entities: { factoryId, supplierId, pendingSupplierId, sku, componentSku, bomId, warehouseId, batchId, supplierSkuId, approvalId, planId, planItemId, purchaseOrderId, orderItemId, executionOrderId, qualityInspectionId, stocktakeId, shipmentId, returnId, invoiceId, paymentRequestId } };
}

export const fixtureModulePath = fileURLToPath(new URL("./fixtures.mjs", import.meta.url));
