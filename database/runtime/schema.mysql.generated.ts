/*
 * AUTO-GENERATED FILE — DO NOT EDIT DIRECTLY.
 * Source: database/runtime/schema.ts
 * Command: npm run db:generate:mysql-schema
 *
 * This is the RDS MySQL table-model baseline. API migration also needs to replace
 * SQLite-only SQL expressions and emulate INSERT ... RETURNING with insertId/select.
 */
import { sql } from "drizzle-orm";
import { bigint, boolean, datetime, int, mysqlTable, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

const timestamps = {
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
};

export const factories = mysqlTable("factories", {
  id: int("id").autoincrement().primaryKey(),
  name: text("name").notNull(),
  code: varchar("code", { length: 191 }).notNull().unique(),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const suppliers = mysqlTable("suppliers", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 191 }).notNull().unique(),
  name: text("name").notNull(),
  tier: int("tier"),
  supplierType: text("supplier_type", { enum: ["core_component", "noncore_component", "auxiliary"] }),
  managedByFactoryId: int("managed_by_factory_id").references(() => factories.id),
  legalName: text("legal_name").notNull().default(""),
  unifiedSocialCreditCode: text("unified_social_credit_code").notNull().default(""),
  businessLicenseFileKey: text("business_license_file_key"),
  businessLicenseExpiresAt: text("business_license_expires_at"),
  businessLicenseLongTerm: boolean("business_license_long_term").notNull().default(false),
  address: text("address").notNull().default(""),
  contactName: text("contact_name").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  businessScope: text("business_scope").notNull().default(""),
  source: text("source").notNull().default("manual"),
  sourceCreatedAt: text("source_created_at"),
  verificationStatus: text("verification_status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  verifiedBy: int("verified_by"),
  verifiedAt: text("verified_at"),
  supplyRisk: text("supply_risk", { enum: ["low", "medium", "high", "critical"] }).notNull().default("low"),
  riskReason: text("risk_reason").notNull().default(""),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const supplierContacts = mysqlTable("supplier_contacts", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: varchar("email", { length: 191 }).notNull().default(""),
  wechat: text("wechat").notNull().default(""),
  responsibility: text("responsibility", { enum: ["purchasing", "production", "quality", "finance", "other"] }).notNull().default("other"),
  isPrimary: boolean("is_primary").notNull().default(false),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
});

export const supplierBankAccounts = mysqlTable("supplier_bank_accounts", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  accountName: text("account_name").notNull(),
  bankName: text("bank_name").notNull(),
  encryptedAccountNo: text("encrypted_account_no").notNull(),
  usage: text("usage", { enum: ["company_payment", "restricted_reference", "factory_only"] }).notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
});

export const users = mysqlTable("users", {
  id: int("id").autoincrement().primaryKey(),
  email: varchar("email", { length: 191 }).notNull().unique(),
  mobile: text("mobile").notNull().default(""),
  name: text("name").notNull(),
  role: text("role", { enum: ["supply_chain", "finance", "factory", "supplier_qc", "company_qc"] }).notNull(),
  factoryId: int("factory_id").references(() => factories.id),
  supplierId: int("supplier_id").references(() => suppliers.id),
  organizationName: text("organization_name").notNull().default(""),
  accountStatus: text("account_status", { enum: ["pending", "active", "locked", "disabled"] }).notNull().default("active"),
  ...timestamps,
});

export const purchaseOrders = mysqlTable("purchase_orders", {
  id: int("id").autoincrement().primaryKey(),
  orderNo: varchar("order_no", { length: 191 }).notNull().unique(),
  source: text("source").notNull().default("lingxing_excel"),
  sourceFileKey: text("source_file_key"),
  status: text("status").notNull().default("draft"),
  orderDate: text("order_date"),
  totalTaxIncludedMinor: int("total_tax_included_minor").notNull().default(0),
  paymentTermId: int("payment_term_id"),
  ...timestamps,
});

export const purchaseImports = mysqlTable("purchase_imports", {
  id: int("id").autoincrement().primaryKey(),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  detectedOrderNo: text("detected_order_no"),
  matchedPurchaseOrderId: int("matched_purchase_order_id").references(() => purchaseOrders.id),
  isPossibleDuplicate: boolean("is_possible_duplicate").notNull().default(false),
  status: text("status", { enum: ["analyzing", "awaiting_confirmation", "applied", "cancelled"] }).notNull().default("analyzing"),
  importedBy: int("imported_by").notNull().references(() => users.id),
  ...timestamps,
});

export const purchaseImportDiffs = mysqlTable("purchase_import_diffs", {
  id: int("id").autoincrement().primaryKey(),
  purchaseImportId: int("purchase_import_id").notNull().references(() => purchaseImports.id),
  sheetName: text("sheet_name").notNull(),
  rowKey: text("row_key").notNull(),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changeType: text("change_type", { enum: ["added", "changed", "removed"] }).notNull(),
});

export const orderItems = mysqlTable("order_items", {
  id: int("id").autoincrement().primaryKey(),
  purchaseOrderId: int("purchase_order_id").notNull().references(() => purchaseOrders.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  productName: text("product_name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }).notNull(),
  supplierId: int("supplier_id").references(() => suppliers.id),
  quantity: int("quantity").notNull(),
  unitPriceTaxIncludedMinor: int("unit_price_tax_included_minor").notNull().default(0),
  amountTaxIncludedMinor: int("amount_tax_included_minor").notNull().default(0),
  dueDate: text("due_date"),
  ...timestamps,
}, table => [uniqueIndex("order_item_unique").on(table.purchaseOrderId, table.sku, table.supplierId)]);

export const supplierSkus = mysqlTable("supplier_skus", {
  id: int("id").autoincrement().primaryKey(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  priority: int("priority").notNull().default(1),
  minimumOrderQuantity: int("minimum_order_quantity").notNull().default(1),
  packagingMultiple: int("packaging_multiple").notNull().default(1),
  purchaseUnit: varchar("purchase_unit", { length: 191 }).notNull().default(""),
  leadTimeDays: int("lead_time_days"),
  dailyCapacity: int("daily_capacity"),
  monthlyCapacity: int("monthly_capacity"),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  status: text("status", { enum: ["pending", "active", "inactive"] }).notNull().default("pending"),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("supplier_sku_unique").on(table.factoryId, table.supplierId, table.sku)]);

export const corePriceAgreements = mysqlTable("core_price_agreements", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  currency: text("currency").notNull().default("CNY"),
  unitPriceTaxIncludedMinor: int("unit_price_tax_included_minor").notNull(),
  unitPriceTaxExcludedMinor: int("unit_price_tax_excluded_minor").notNull(),
  taxRateBps: int("tax_rate_bps").notNull(),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  effectiveTo: text("effective_to"),
  status: text("status").notNull().default("active"),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const corePriceChangeRequests = mysqlTable("core_price_change_requests", {
  id: int("id").autoincrement().primaryKey(),
  currentAgreementId: int("current_agreement_id").references(() => corePriceAgreements.id),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  proposedTaxIncludedMinor: int("proposed_tax_included_minor").notNull(),
  proposedTaxExcludedMinor: int("proposed_tax_excluded_minor").notNull(),
  proposedTaxRateBps: int("proposed_tax_rate_bps").notNull(),
  proposedEffectiveFrom: text("proposed_effective_from").notNull(),
  reason: text("reason").notNull(),
  evidenceFileKey: text("evidence_file_key").notNull(),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewComment: text("review_comment"),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const factorySupplierDeliverySettings = mysqlTable("factory_supplier_delivery_settings", {
  id: int("id").autoincrement().primaryKey(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  componentSku: varchar("component_sku", { length: 191 }).notNull(),
  arrivalBufferDays: int("arrival_buffer_days").notNull(),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("factory_supplier_sku_buffer_unique").on(table.factoryId, table.supplierId, table.componentSku)]);

export const deliverySettingChanges = mysqlTable("delivery_setting_changes", {
  id: int("id").autoincrement().primaryKey(),
  settingId: int("setting_id").notNull().references(() => factorySupplierDeliverySettings.id),
  oldDays: int("old_days").notNull(),
  newDays: int("new_days").notNull(),
  reason: text("reason").notNull(),
  changedBy: int("changed_by").notNull().references(() => users.id),
  supplyChainNotifiedAt: datetime("supply_chain_notified_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const skus = mysqlTable("skus", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 191 }).notNull().unique(),
  name: text("name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  stockUnit: text("stock_unit"),
  serialTrackingEnabled: boolean("serial_tracking_enabled").notNull().default(false),
  overproductionToleranceBps: int("overproduction_tolerance_bps").notNull().default(0),
  purchaseOverToleranceBps: int("purchase_over_tolerance_bps").notNull().default(0),
  purchaseUnderToleranceBps: int("purchase_under_tolerance_bps").notNull().default(0),
  verificationStatus: text("verification_status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  status: text("status", { enum: ["draft", "active", "inactive"] }).notNull().default("draft"),
  ...timestamps,
});

export const skuUnitConversions = mysqlTable("sku_unit_conversions", {
  id: int("id").autoincrement().primaryKey(),
  skuId: int("sku_id").notNull().references(() => skus.id),
  purchaseUnit: varchar("purchase_unit", { length: 191 }).notNull(),
  stockUnit: text("stock_unit").notNull(),
  purchaseUnitQuantity: int("purchase_unit_quantity").notNull(),
  stockUnitQuantity: int("stock_unit_quantity").notNull(),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
}, table => [uniqueIndex("sku_purchase_unit_unique").on(table.skuId, table.purchaseUnit, table.effectiveFrom)]);

export const productBoms = mysqlTable("product_boms", {
  id: int("id").autoincrement().primaryKey(),
  finishedSku: varchar("finished_sku", { length: 191 }).notNull(),
  version: varchar("version", { length: 191 }).notNull(),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  effectiveTo: text("effective_to"),
  overlapAllowed: boolean("overlap_allowed").notNull().default(false),
  overlapReason: text("overlap_reason").notNull().default(""),
  approvalStatus: text("approval_status", { enum: ["draft", "pending", "approved", "rejected"] }).notNull().default("draft"),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  active: boolean("active").notNull().default(true),
  createdBy: int("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("product_bom_version_unique").on(table.finishedSku, table.version)]);

export const bomComponents = mysqlTable("bom_components", {
  id: int("id").autoincrement().primaryKey(),
  bomId: int("bom_id").notNull().references(() => productBoms.id),
  componentSku: varchar("component_sku", { length: 191 }).notNull(),
  itemType: text("item_type", { enum: ["auxiliary", "component"] }).notNull(),
  isCore: boolean("is_core").notNull().default(false),
  quantityPerFinished: int("quantity_per_finished").notNull(),
  issueToleranceBps: int("issue_tolerance_bps").notNull().default(0),
  consumptionToleranceBps: int("consumption_tolerance_bps").notNull().default(0),
  lossToleranceBps: int("loss_tolerance_bps").notNull().default(0),
}, table => [uniqueIndex("bom_component_unique").on(table.bomId, table.componentSku)]);

export const skuFactoryDefaults = mysqlTable("sku_factory_defaults", {
  id: int("id").autoincrement().primaryKey(),
  sku: varchar("sku", { length: 191 }).notNull().unique(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  selectedBy: int("selected_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryChangeRequests = mysqlTable("factory_change_requests", {
  id: int("id").autoincrement().primaryKey(),
  sku: varchar("sku", { length: 191 }).notNull(),
  fromFactoryId: int("from_factory_id").notNull().references(() => factories.id),
  toFactoryId: int("to_factory_id").notNull().references(() => factories.id),
  reason: text("reason").notNull(),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewComment: text("review_comment"),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const purchasePlans = mysqlTable("purchase_plans", {
  id: int("id").autoincrement().primaryKey(),
  planNo: varchar("plan_no", { length: 191 }).notNull(),
  version: int("version").notNull().default(1),
  source: text("source").notNull().default("lingxing_excel"),
  sourceFileKey: text("source_file_key"),
  status: text("status", { enum: ["draft", "pending_approval", "awaiting_factory_confirmation", "confirmed", "disputed", "ordering", "ordered_complete", "superseded"] }).notNull().default("draft"),
  confirmationDueAt: text("confirmation_due_at"),
  confirmedAt: text("confirmed_at"),
  createdBy: int("created_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_version_unique").on(table.planNo, table.version)]);

export const purchasePlanItems = mysqlTable("purchase_plan_items", {
  id: int("id").autoincrement().primaryKey(),
  purchasePlanId: int("purchase_plan_id").notNull().references(() => purchasePlans.id),
  expectedArrivalDate: varchar("expected_arrival_date", { length: 191 }).notNull(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  productName: text("product_name").notNull(),
  bomId: int("bom_id").notNull().references(() => productBoms.id),
  plannedQuantity: int("planned_quantity").notNull(),
  orderedQuantity: int("ordered_quantity").notNull().default(0),
  overToleranceBps: int("over_tolerance_bps").notNull().default(0),
  underToleranceBps: int("under_tolerance_bps").notNull().default(0),
  completionStatus: text("completion_status", { enum: ["not_ordered", "within_tolerance", "over_plan_pending", "under_plan_pending", "exception_approved"] }).notNull().default("not_ordered"),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_summary_key").on(table.purchasePlanId, table.expectedArrivalDate, table.factoryId, table.warehouseId, table.sku)]);

export const purchasePlanSourceRows = mysqlTable("purchase_plan_source_rows", {
  id: int("id").autoincrement().primaryKey(),
  purchasePlanId: int("purchase_plan_id").notNull().references(() => purchasePlans.id),
  sourceRowNo: int("source_row_no").notNull(),
  sourcePlanNo: text("source_plan_no").notNull(),
  isCombinationMain: boolean("is_combination_main").notNull().default(false),
  ignoredExpandedItem: boolean("ignored_expanded_item").notNull().default(false),
  rawJson: text("raw_json").notNull(),
});

export const purchasePlanOrderLinks = mysqlTable("purchase_plan_order_links", {
  id: int("id").autoincrement().primaryKey(),
  purchasePlanItemId: int("purchase_plan_item_id").notNull().references(() => purchasePlanItems.id),
  orderItemId: int("order_item_id").notNull().references(() => orderItems.id),
  allocatedQuantity: int("allocated_quantity").notNull(),
  matchMethod: text("match_method", { enum: ["automatic", "manual"] }).notNull(),
  confirmedBy: int("confirmed_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_order_link_unique").on(table.purchasePlanItemId, table.orderItemId)]);

export const factoryPlanResponses = mysqlTable("factory_plan_responses", {
  id: int("id").autoincrement().primaryKey(),
  purchasePlanId: int("purchase_plan_id").notNull().references(() => purchasePlans.id),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  decision: text("decision", { enum: ["confirmed", "unable"] }).notNull(),
  expectedStartDate: text("expected_start_date").notNull(),
  expectedFinishDate: text("expected_finish_date").notNull(),
  proposedArrivalDate: text("proposed_arrival_date"),
  reason: text("reason").notNull().default(""),
  status: text("status", { enum: ["accepted", "pending_supply_chain", "approved", "rejected"] }).notNull(),
  respondedBy: int("responded_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const executionOrders = mysqlTable("execution_orders", {
  id: int("id").autoincrement().primaryKey(),
  executionNo: varchar("execution_no", { length: 191 }).notNull().unique(),
  orderItemId: int("order_item_id").notNull().references(() => orderItems.id),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  bomId: int("bom_id").references(() => productBoms.id),
  plannedQuantity: int("planned_quantity").notNull(),
  completedQuantity: int("completed_quantity").notNull().default(0),
  status: text("status").notNull().default("factory_confirmation"),
  dueDate: text("due_date"),
  plannedStartDate: text("planned_start_date"),
  plannedFinishDate: text("planned_finish_date"),
  actualStartAt: text("actual_start_at"),
  actualFinishAt: text("actual_finish_at"),
  ...timestamps,
});

export const productionMaterialLines = mysqlTable("production_material_lines", {
  id: int("id").autoincrement().primaryKey(),
  executionOrderId: int("execution_order_id").notNull().references(() => executionOrders.id),
  bomComponentId: int("bom_component_id").notNull().references(() => bomComponents.id),
  theoreticalQuantity: int("theoretical_quantity").notNull(),
  reservedQuantity: int("reserved_quantity").notNull().default(0),
  issuedQuantity: int("issued_quantity").notNull().default(0),
  consumedQuantity: int("consumed_quantity").notNull().default(0),
  lossQuantity: int("loss_quantity").notNull().default(0),
  deviationStatus: text("deviation_status", { enum: ["within_tolerance", "pending_approval", "approved", "rejected"] }).notNull().default("within_tolerance"),
  ...timestamps,
});

export const productionReports = mysqlTable("production_reports", {
  id: int("id").autoincrement().primaryKey(),
  executionOrderId: int("execution_order_id").notNull().references(() => executionOrders.id),
  actualFinishedQuantity: int("actual_finished_quantity").notNull(),
  varianceQuantity: int("variance_quantity").notNull(),
  varianceRateBps: int("variance_rate_bps").notNull(),
  result: text("result", { enum: ["within_tolerance", "overproduction_quarantined", "underproduction_pending", "approved", "rejected_factory_owned"] }).notNull(),
  companyInventoryQuantity: int("company_inventory_quantity").notNull().default(0),
  factoryOwnedQuantity: int("factory_owned_quantity").notNull().default(0),
  reportedBy: int("reported_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const coreSupplierOrders = mysqlTable("core_supplier_orders", {
  id: int("id").autoincrement().primaryKey(),
  orderNo: varchar("order_no", { length: 191 }).notNull().unique(),
  sourcePurchaseOrderId: int("source_purchase_order_id").notNull().references(() => purchaseOrders.id),
  assemblyFactoryId: int("assembly_factory_id").notNull().references(() => factories.id),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  plannedShipDate: text("planned_ship_date").notNull(),
  status: text("status", { enum: ["awaiting_confirmation", "confirmed", "unable_to_fulfill", "shipped", "completed"] }).notNull().default("awaiting_confirmation"),
  confirmedBy: int("confirmed_by").references(() => users.id),
  confirmedAt: text("confirmed_at"),
  inabilityReason: text("inability_reason"),
  proposedShipDate: text("proposed_ship_date"),
  alertStatus: text("alert_status", { enum: ["none", "open", "resolved"] }).notNull().default("none"),
  ...timestamps,
});

export const coreOrderReschedules = mysqlTable("core_order_reschedules", {
  id: int("id").autoincrement().primaryKey(),
  coreSupplierOrderId: int("core_supplier_order_id").notNull().references(() => coreSupplierOrders.id),
  previousShipDate: text("previous_ship_date").notNull(),
  proposedShipDate: text("proposed_ship_date").notNull(),
  supplierReason: text("supplier_reason").notNull(),
  factoryDecision: text("factory_decision", { enum: ["pending", "confirmed", "rejected"] }).notNull().default("pending"),
  factoryConfirmedBy: int("factory_confirmed_by").references(() => users.id),
  factoryConfirmedAt: text("factory_confirmed_at"),
  supplyChainDecision: text("supply_chain_decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  supplyChainReviewedBy: int("supply_chain_reviewed_by").references(() => users.id),
  supplyChainReviewedAt: text("supply_chain_reviewed_at"),
  reviewComment: text("review_comment"),
  ...timestamps,
});

export const coreSupplierOrderItems = mysqlTable("core_supplier_order_items", {
  id: int("id").autoincrement().primaryKey(),
  coreSupplierOrderId: int("core_supplier_order_id").notNull().references(() => coreSupplierOrders.id),
  componentSku: varchar("component_sku", { length: 191 }).notNull(),
  quantity: int("quantity").notNull(),
  priceAgreementId: int("price_agreement_id").notNull().references(() => corePriceAgreements.id),
  currency: text("currency").notNull(),
  unitPriceTaxIncludedMinor: int("unit_price_tax_included_minor").notNull(),
  unitPriceTaxExcludedMinor: int("unit_price_tax_excluded_minor").notNull(),
  taxRateBps: int("tax_rate_bps").notNull(),
  amountTaxIncludedMinor: int("amount_tax_included_minor").notNull(),
  amountTaxExcludedMinor: int("amount_tax_excluded_minor").notNull(),
}, table => [uniqueIndex("core_supplier_order_item_unique").on(table.coreSupplierOrderId, table.componentSku)]);

export const factoryPaymentTerms = mysqlTable("factory_payment_terms", {
  id: int("id").autoincrement().primaryKey(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  name: text("name").notNull(),
  mode: text("mode", { enum: ["shipment_plus_days", "monthly_cutoff"] }).notNull(),
  daysAfterShipment: int("days_after_shipment"),
  cutoffDay: int("cutoff_day"),
  settlementMonthOffset: int("settlement_month_offset"),
  paymentDay: int("payment_day"),
  invoiceRequired: boolean("invoice_required").notNull().default(true),
  active: boolean("active").notNull().default(true),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryPaymentSchedules = mysqlTable("factory_payment_schedules", {
  id: int("id").autoincrement().primaryKey(),
  purchaseOrderId: int("purchase_order_id").notNull().references(() => purchaseOrders.id),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  deliveryBatchId: int("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  paymentType: text("payment_type", { enum: ["prepayment", "progress", "balance", "other"] }).notNull(),
  rateBps: int("rate_bps"),
  shippedQuantity: int("shipped_quantity").notNull(),
  unitPriceMinor: int("unit_price_minor").notNull(),
  amountMinor: int("amount_minor").notNull(),
  paymentTermId: int("payment_term_id").notNull().references(() => factoryPaymentTerms.id),
  paymentRuleSnapshot: text("payment_rule_snapshot").notNull(),
  plannedPaymentDate: varchar("planned_payment_date", { length: 191 }).notNull(),
  triggerEvent: text("trigger_event", { enum: ["actual_shipment"] }).notNull().default("actual_shipment"),
  status: text("status", { enum: ["planned", "requested", "paid", "cancelled"] }).notNull().default("planned"),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryPaymentRequests = mysqlTable("factory_payment_requests", {
  id: int("id").autoincrement().primaryKey(),
  requestNo: varchar("request_no", { length: 191 }).notNull().unique(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  actualShipmentDate: text("actual_shipment_date").notNull(),
  plannedPaymentDate: varchar("planned_payment_date", { length: 191 }).notNull(),
  totalAmountMinor: int("total_amount_minor").notNull(),
  autoGenerated: boolean("auto_generated").notNull().default(true),
  status: text("status", { enum: ["waiting_invoice", "generated", "submitted_to_finance", "paid", "partially_paid", "invoice_exception_frozen", "failed", "cancelled"] }).notNull().default("waiting_invoice"),
  invoiceCoveredAmountMinor: int("invoice_covered_amount_minor").notNull().default(0),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  submittedToFinanceAt: text("submitted_to_finance_at"),
  supplyChainNotifiedAt: datetime("supply_chain_notified_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  financeNotifiedAt: datetime("finance_notified_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  paidAt: text("paid_at"),
  paymentReference: text("payment_reference"),
  paymentNote: text("payment_note"),
  ...timestamps,
}, table => [uniqueIndex("factory_payment_request_group_unique").on(table.factoryId, table.plannedPaymentDate)]);

export const factoryPaymentRequestItems = mysqlTable("factory_payment_request_items", {
  id: int("id").autoincrement().primaryKey(),
  paymentRequestId: int("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  paymentScheduleId: int("payment_schedule_id").notNull().references(() => factoryPaymentSchedules.id),
  purchaseOrderId: int("purchase_order_id").notNull().references(() => purchaseOrders.id),
  triggeredByDeliveryBatchId: int("triggered_by_delivery_batch_id").notNull().references(() => deliveryBatches.id),
  amountMinor: int("amount_minor").notNull(),
}, table => [uniqueIndex("payment_request_schedule_unique").on(table.paymentRequestId, table.paymentScheduleId)]);

export const factoryInvoices = mysqlTable("factory_invoices", {
  id: int("id").autoincrement().primaryKey(),
  factoryId: int("factory_id").notNull().references(() => factories.id),
  purchaseOrderId: int("purchase_order_id").notNull().references(() => purchaseOrders.id),
  coverageMode: text("coverage_mode", { enum: ["full_order", "delivery_batch"] }).notNull(),
  deliveryBatchId: int("delivery_batch_id").references(() => deliveryBatches.id),
  invoiceNo: varchar("invoice_no", { length: 191 }).notNull().unique(),
  invoiceType: text("invoice_type", { enum: ["vat_special", "vat_general", "other"] }).notNull(),
  amountTaxIncludedMinor: int("amount_tax_included_minor").notNull(),
  taxAmountMinor: int("tax_amount_minor").notNull(),
  issuedAt: text("issued_at").notNull(),
  receivedAt: text("received_at"),
  fileKey: text("file_key"),
  status: text("status", { enum: ["pending", "received", "verified", "rejected", "invalidated"] }).notNull().default("pending"),
  expectedAmountMinor: int("expected_amount_minor").notNull(),
  amountMatchesExpected: boolean("amount_matches_expected").notNull().default(false),
  mismatchAmountMinor: int("mismatch_amount_minor").notNull().default(0),
  maintainedBy: int("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const notifications = mysqlTable("notifications", {
  id: int("id").autoincrement().primaryKey(),
  recipientRole: text("recipient_role", { enum: ["supply_chain", "finance"] }).notNull(),
  type: varchar("type", { length: 191 }).notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: int("entity_id").notNull(),
  readAt: text("read_at"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const deliveryBatches = mysqlTable("delivery_batches", {
  id: int("id").autoincrement().primaryKey(),
  executionOrderId: int("execution_order_id").notNull().references(() => executionOrders.id),
  batchNo: varchar("batch_no", { length: 191 }).notNull(),
  quantity: int("quantity").notNull(),
  plannedShipAt: text("planned_ship_at").notNull(),
  shippedAt: text("shipped_at"),
  carrier: text("carrier").notNull(),
  logisticsNo: text("logistics_no").notNull(),
  destination: text("destination").notNull(),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  deviationReason: text("deviation_reason"),
  status: text("status").notNull().default("planned"),
  ...timestamps,
}, table => [uniqueIndex("delivery_batch_unique").on(table.executionOrderId, table.batchNo)]);

export const shipmentEvidence = mysqlTable("shipment_evidence", {
  id: int("id").autoincrement().primaryKey(),
  deliveryBatchId: int("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const shipmentReceipts = mysqlTable("shipment_receipts", {
  id: int("id").autoincrement().primaryKey(),
  deliveryBatchId: int("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  receivedQuantity: int("received_quantity").notNull(),
  damagedQuantity: int("damaged_quantity").notNull().default(0),
  receivedAt: text("received_at").notNull(),
  evidenceFileKey: text("evidence_file_key").notNull(),
  exceptionReason: text("exception_reason").notNull().default(""),
  receivedBy: int("received_by").notNull().references(() => users.id),
  ...timestamps,
});

export const productReturns = mysqlTable("product_returns", {
  id: int("id").autoincrement().primaryKey(),
  returnNo: varchar("return_no", { length: 191 }).notNull().unique(),
  sourceDeliveryBatchId: int("source_delivery_batch_id").notNull().references(() => deliveryBatches.id),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  quantity: int("quantity").notNull(),
  batchId: int("batch_id").references(() => inventoryBatches.id),
  status: text("status", { enum: ["return_in_transit", "quarantined", "inspection", "pending_supply_chain", "restocked", "rework", "scrapped"] }).notNull(),
  proposedDisposition: text("proposed_disposition", { enum: ["restock", "rework", "scrap"] }),
  proposedBy: int("proposed_by").references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const productReturnInspections = mysqlTable("product_return_inspections", {
  id: int("id").autoincrement().primaryKey(),
  productReturnId: int("product_return_id").notNull().references(() => productReturns.id),
  inspectedQuantity: int("inspected_quantity").notNull(),
  passedQuantity: int("passed_quantity").notNull(),
  failedQuantity: int("failed_quantity").notNull(),
  defectReason: text("defect_reason").notNull().default(""),
  evidenceFileKey: text("evidence_file_key").notNull(),
  inspectedBy: int("inspected_by").notNull().references(() => users.id),
  inspectedAt: datetime("inspected_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const productReturnDispositions = mysqlTable("product_return_dispositions", {
  id: int("id").autoincrement().primaryKey(),
  productReturnId: int("product_return_id").notNull().references(() => productReturns.id),
  type: varchar("type", { length: 191, enum: ["restock", "rework", "scrap"] }).notNull(),
  quantity: int("quantity").notNull(),
  proposedBy: int("proposed_by").notNull().references(() => users.id),
  status: text("status", { enum: ["pending_supply_chain", "approved", "rejected"] }).notNull().default("pending_supply_chain"),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("product_return_disposition_unique").on(table.productReturnId, table.type)]);

export const supplyRiskCases = mysqlTable("supply_risk_cases", {
  id: int("id").autoincrement().primaryKey(),
  riskNo: varchar("risk_no", { length: 191 }).notNull().unique(),
  assemblyFactoryId: int("assembly_factory_id").notNull().references(() => factories.id),
  sourceSupplierId: int("source_supplier_id").references(() => suppliers.id),
  sourceTier: int("source_tier").notNull(),
  affectedEntityType: text("affected_entity_type").notNull(),
  affectedEntityId: int("affected_entity_id").notNull(),
  triggerType: text("trigger_type", { enum: ["factory_reported", "system_predicted"] }).notNull(),
  impactSummary: text("impact_summary").notNull(),
  responseDueAt: text("response_due_at").notNull(),
  factoryPlan: text("factory_plan"),
  proposedDeliveryDate: text("proposed_delivery_date"),
  status: text("status", { enum: ["open", "pending_supply_chain", "approved", "rejected", "resolved"] }).notNull().default("open"),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const exceptions = mysqlTable("exceptions", {
  id: int("id").autoincrement().primaryKey(),
  executionOrderId: int("execution_order_id").references(() => executionOrders.id),
  factoryId: int("factory_id").references(() => factories.id),
  type: varchar("type", { length: 191, enum: ["quality_failure", "quality_override", "concession_acceptance", "overproduction", "stocktake_variance", "shortage", "shipment_deviation", "logistics_exception", "warehouse_transfer"] }).notNull(),
  description: text("description").notNull(),
  evidenceFileKey: text("evidence_file_key"),
  status: text("status").notNull().default("pending_supply_chain"),
  submittedBy: int("submitted_by").notNull().references(() => users.id),
  ...timestamps,
});

export const approvals = mysqlTable("approvals", {
  id: int("id").autoincrement().primaryKey(),
  exceptionId: int("exception_id").notNull().references(() => exceptions.id),
  decision: text("decision", { enum: ["approved", "rejected", "rework"] }).notNull(),
  comment: text("comment").notNull().default(""),
  approvedBy: int("approved_by").notNull().references(() => users.id),
  approvedAt: datetime("approved_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const warehouses = mysqlTable("warehouses", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 191 }).notNull().unique(),
  name: text("name").notNull(),
  type: varchar("type", { length: 191, enum: ["factory", "company", "other"] }).notNull(),
  factoryId: int("factory_id").references(() => factories.id),
  address: text("address").notNull().default(""),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const inventory = mysqlTable("inventory", {
  id: int("id").autoincrement().primaryKey(),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }).notNull(),
  availableQuantity: int("available_quantity").notNull().default(0),
  lockedQuantity: int("locked_quantity").notNull().default(0),
  quarantinedQuantity: int("quarantined_quantity").notNull().default(0),
  ...timestamps,
}, table => [uniqueIndex("inventory_warehouse_sku_unique").on(table.warehouseId, table.sku)]);

export const inventoryBatches = mysqlTable("inventory_batches", {
  id: int("id").autoincrement().primaryKey(),
  batchNo: varchar("batch_no", { length: 191 }).notNull().unique(),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  productionDate: text("production_date"),
  inboundDate: text("inbound_date").notNull(),
  expiryDate: text("expiry_date"),
  productionDateEstimated: boolean("production_date_estimated").notNull().default(false),
  expiryDateEstimated: boolean("expiry_date_estimated").notNull().default(false),
  availableQuantity: int("available_quantity").notNull().default(0),
  lockedQuantity: int("locked_quantity").notNull().default(0),
  defectiveQuantity: int("defective_quantity").notNull().default(0),
  pendingInspectionQuantity: int("pending_inspection_quantity").notNull().default(0),
  quarantineQuantity: int("quarantine_quantity").notNull().default(0),
  ownership: text("ownership", { enum: ["company", "factory"] }).notNull().default("company"),
  expiryStatus: text("expiry_status", { enum: ["normal", "yellow", "red", "expired_frozen"] }).notNull().default("normal"),
  ...timestamps,
}, table => [uniqueIndex("inventory_batch_warehouse_unique").on(table.warehouseId, table.batchNo)]);

export const inventoryReservations = mysqlTable("inventory_reservations", {
  id: int("id").autoincrement().primaryKey(),
  batchId: int("batch_id").notNull().references(() => inventoryBatches.id),
  entityType: text("entity_type", { enum: ["purchase_order", "production_order", "shipment_plan", "historical"] }).notNull(),
  entityId: int("entity_id"),
  requestedQuantity: int("requested_quantity").notNull(),
  reservedQuantity: int("reserved_quantity").notNull(),
  shortageQuantity: int("shortage_quantity").notNull().default(0),
  priority: int("priority").notNull().default(0),
  status: text("status", { enum: ["active", "released", "consumed"] }).notNull().default("active"),
  createdBy: int("created_by").notNull().references(() => users.id),
  ...timestamps,
});

export const stocktakes = mysqlTable("stocktakes", {
  id: int("id").autoincrement().primaryKey(),
  stocktakeNo: varchar("stocktake_no", { length: 191 }).notNull().unique(),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  scope: text("scope", { enum: ["full_warehouse", "sku_sample", "batch"] }).notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["draft", "frozen", "first_count", "recount", "pending_approval", "completed"] }).notNull().default("draft"),
  frozenAt: text("frozen_at"),
  createdBy: int("created_by").notNull().references(() => users.id),
  assignedFactoryId: int("assigned_factory_id").references(() => factories.id),
  ...timestamps,
});

export const stocktakeCounts = mysqlTable("stocktake_counts", {
  id: int("id").autoincrement().primaryKey(),
  stocktakeId: int("stocktake_id").notNull().references(() => stocktakes.id),
  batchId: int("batch_id").references(() => inventoryBatches.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  countRound: int("count_round").notNull(),
  availableQuantity: int("available_quantity").notNull(),
  lockedQuantity: int("locked_quantity").notNull(),
  defectiveQuantity: int("defective_quantity").notNull(),
  pendingInspectionQuantity: int("pending_inspection_quantity").notNull(),
  totalQuantity: int("total_quantity").notNull(),
  countedBy: int("counted_by").notNull().references(() => users.id),
  countedAt: datetime("counted_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, table => [uniqueIndex("stocktake_count_round_unique").on(table.stocktakeId, table.sku, table.batchId, table.countRound)]);

export const stocktakeAdjustments = mysqlTable("stocktake_adjustments", {
  id: int("id").autoincrement().primaryKey(),
  stocktakeId: int("stocktake_id").notNull().references(() => stocktakes.id),
  stocktakeCountId: int("stocktake_count_id").notNull().references(() => stocktakeCounts.id),
  bucket: varchar("bucket", { length: 32 }),
  snapshotQuantity: int("snapshot_quantity"),
  countedQuantity: int("counted_quantity"),
  varianceQuantity: int("variance_quantity").notNull(),
  revision: int("revision").notNull().default(1),
  generatedBatchNo: text("generated_batch_no"),
  estimatedProductionDate: text("estimated_production_date"),
  estimatedExpiryDate: text("estimated_expiry_date"),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("r3_stocktake_adjustment_bucket_unique").on(table.stocktakeId, table.stocktakeCountId, table.bucket)]);

export const inventoryMovements = mysqlTable("inventory_movements", {
  id: int("id").autoincrement().primaryKey(),
  warehouseId: int("warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  type: varchar("type", { length: 191, enum: ["inbound", "shipment", "transfer_out", "transfer_in", "adjustment"] }).notNull(),
  quantity: int("quantity").notNull(),
  deliveryBatchId: int("delivery_batch_id").references(() => deliveryBatches.id),
  sourceKey: varchar("source_key", { length: 191 }),
  occurredAt: datetime("occurred_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdBy: int("created_by").notNull().references(() => users.id),
}, table => [uniqueIndex("r3_inventory_movement_source_unique").on(table.sourceKey)]);

export const inventoryTransfers = mysqlTable("inventory_transfers", {
  id: int("id").autoincrement().primaryKey(),
  transferNo: varchar("transfer_no", { length: 191 }).notNull().unique(),
  fromWarehouseId: int("from_warehouse_id").notNull().references(() => warehouses.id),
  toWarehouseId: int("to_warehouse_id").notNull().references(() => warehouses.id),
  sku: varchar("sku", { length: 191 }).notNull(),
  quantity: int("quantity").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending_supply_chain"),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  approvedBy: int("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  shippedAt: text("shipped_at"),
  receivedAt: text("received_at"),
  ...timestamps,
});

export const qualityRules = mysqlTable("quality_rules", {
  id: int("id").autoincrement().primaryKey(),
  scope: text("scope", { enum: ["sku", "item_type"] }).notNull(),
  sku: varchar("sku", { length: 191 }),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  stage: text("stage", { enum: ["incoming", "finished_goods"] }).notNull(),
  minimumPassRateBps: int("minimum_pass_rate_bps").notNull(),
  active: boolean("active").notNull().default(true),
  source: text("source", { enum: ["system_default", "manual"] }).notNull().default("manual"),
  createdBy: int("created_by").references(() => users.id),
  ...timestamps,
});

export const qualityInspections = mysqlTable("quality_inspections", {
  id: int("id").autoincrement().primaryKey(),
  executionOrderId: int("execution_order_id").notNull().references(() => executionOrders.id),
  stage: text("stage", { enum: ["incoming", "finished_goods"] }).notNull(),
  inspectionMethod: text("inspection_method", { enum: ["sampling", "full"] }).notNull(),
  batchQuantity: int("batch_quantity").notNull(),
  inspectedQuantity: int("inspected_quantity").notNull(),
  passedQuantity: int("passed_quantity").notNull(),
  failedQuantity: int("failed_quantity").notNull(),
  passRateBps: int("pass_rate_bps").notNull(),
  qualityRuleId: int("quality_rule_id").notNull().references(() => qualityRules.id),
  usedItemTypeFallback: boolean("used_item_type_fallback").notNull().default(false),
  skuRuleReminderStatus: text("sku_rule_reminder_status", { enum: ["not_needed", "pending", "completed"] }).notNull().default("not_needed"),
  defectReason: text("defect_reason").notNull().default(""),
  systemResult: text("system_result", { enum: ["passed", "failed"] }).notNull(),
  requestedResult: text("requested_result", { enum: ["passed", "failed"] }),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  finalResult: text("final_result", { enum: ["passed", "failed", "pending_approval"] }).notNull(),
  quarantineTriggered: boolean("quarantine_triggered").notNull().default(false),
  fullInspectionRequired: boolean("full_inspection_required").notNull().default(false),
  sourceInspectionId: int("source_inspection_id"),
  releasedQuantity: int("released_quantity").notNull().default(0),
  dispositionStatus: text("disposition_status", { enum: ["not_needed", "pending", "completed"] }).notNull().default("not_needed"),
  inspectorType: text("inspector_type", { enum: ["supplier_qc", "company_qc"] }).notNull(),
  submittedBy: int("submitted_by").notNull().references(() => users.id),
  ...timestamps,
});

export const defectCatalog = mysqlTable("defect_catalog", {
  id: int("id").autoincrement().primaryKey(),
  code: varchar("code", { length: 191 }).notNull().unique(),
  name: text("name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  description: text("description").notNull().default(""),
  status: text("status", { enum: ["proposed", "active", "inactive", "rejected"] }).notNull().default("proposed"),
  proposedBy: int("proposed_by").references(() => users.id),
  approvedBy: int("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  ...timestamps,
});

export const inspectionDefects = mysqlTable("inspection_defects", {
  id: int("id").autoincrement().primaryKey(),
  inspectionId: int("inspection_id").notNull().references(() => qualityInspections.id),
  defectId: int("defect_id").notNull().references(() => defectCatalog.id),
  quantity: int("quantity").notNull(),
  note: text("note").notNull().default(""),
  ...timestamps,
}, table => [uniqueIndex("inspection_defect_unique").on(table.inspectionId, table.defectId)]);

export const defectImages = mysqlTable("defect_images", {
  id: int("id").autoincrement().primaryKey(),
  inspectionDefectId: int("inspection_defect_id").notNull().references(() => inspectionDefects.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const nonconformanceDispositions = mysqlTable("nonconformance_dispositions", {
  id: int("id").autoincrement().primaryKey(),
  inspectionId: int("inspection_id").notNull().references(() => qualityInspections.id),
  type: varchar("type", { length: 191, enum: ["rework", "return", "scrap", "concession"] }).notNull(),
  quantity: int("quantity").notNull(),
  comment: text("comment").notNull().default(""),
  requiresSupplyChainApproval: boolean("requires_supply_chain_approval").notNull().default(false),
  status: text("status").notNull().default("factory_confirmation"),
  confirmedBy: int("confirmed_by").references(() => users.id),
  exceptionId: int("exception_id").references(() => exceptions.id),
  ...timestamps,
});

export const inspectionImages = mysqlTable("inspection_images", {
  id: int("id").autoincrement().primaryKey(),
  inspectionId: int("inspection_id").notNull().references(() => qualityInspections.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const userRoles = mysqlTable("user_roles", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id),
  roleCode: text("role_code").notNull(),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  effectiveTo: text("effective_to"),
  status: text("status", { enum: ["pending", "active", "expired", "revoked"] }).notNull().default("pending"),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const invoiceVerifications = mysqlTable("invoice_verifications", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoice_id").notNull().references(() => factoryInvoices.id),
  verifierRole: varchar("verifier_role", { length: 191, enum: ["supply_chain", "finance"] }).notNull(),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  rejectionReason: text("rejection_reason"),
  verifiedBy: int("verified_by").notNull().references(() => users.id),
  verifiedAt: datetime("verified_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, table => [uniqueIndex("invoice_role_verification_unique").on(table.invoiceId, table.verifierRole)]);

export const invoicePaymentAllocations = mysqlTable("invoice_payment_allocations", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoice_id").notNull().references(() => factoryInvoices.id),
  paymentRequestId: int("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  allocatedAmountMinor: int("allocated_amount_minor").notNull(),
  status: text("status", { enum: ["active", "frozen", "released"] }).notNull().default("active"),
  createdBy: int("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("invoice_payment_request_unique").on(table.invoiceId, table.paymentRequestId)]);

export const invoiceExceptions = mysqlTable("invoice_exceptions", {
  id: int("id").autoincrement().primaryKey(),
  invoiceId: int("invoice_id").notNull().references(() => factoryInvoices.id),
  exceptionType: text("exception_type", { enum: ["red_invoice", "voided"] }).notNull(),
  affectedAmountMinor: int("affected_amount_minor").notNull(),
  replacementDeadline: text("replacement_deadline").notNull(),
  replacementCoveredAmountMinor: int("replacement_covered_amount_minor").notNull().default(0),
  refundedAmountMinor: int("refunded_amount_minor").notNull().default(0),
  status: text("status", { enum: ["awaiting_remediation", "risk_warning", "resolved"] }).notNull().default("awaiting_remediation"),
  reason: text("reason").notNull(),
  createdBy: int("created_by").notNull().references(() => users.id),
  riskReleasedBy: int("risk_released_by").references(() => users.id),
  riskReleasedAt: text("risk_released_at"),
  riskReleaseReason: text("risk_release_reason"),
  riskReleaseEvidenceFileKey: text("risk_release_evidence_file_key"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
});

export const replacementInvoiceLinks = mysqlTable("replacement_invoice_links", {
  id: int("id").autoincrement().primaryKey(),
  invoiceExceptionId: int("invoice_exception_id").notNull().references(() => invoiceExceptions.id),
  replacementInvoiceId: int("replacement_invoice_id").notNull().references(() => factoryInvoices.id),
  coveredAmountMinor: int("covered_amount_minor").notNull(),
  status: text("status", { enum: ["pending_verification", "verified", "rejected"] }).notNull().default("pending_verification"),
  ...timestamps,
}, table => [uniqueIndex("replacement_invoice_unique").on(table.invoiceExceptionId, table.replacementInvoiceId)]);

export const paymentRecords = mysqlTable("payment_records", {
  id: int("id").autoincrement().primaryKey(),
  paymentRequestId: int("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  amountMinor: int("amount_minor").notNull(),
  paidAt: text("paid_at").notNull(),
  bankReference: text("bank_reference").notNull(),
  recordType: text("record_type", { enum: ["payment", "reversal", "correction", "refund"] }).notNull().default("payment"),
  reversesPaymentRecordId: int("reverses_payment_record_id"),
  correctsPaymentRecordId: int("corrects_payment_record_id"),
  invoiceExceptionId: int("invoice_exception_id").references(() => invoiceExceptions.id),
  recordedBy: int("recorded_by").notNull().references(() => users.id),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewStatus: text("review_status", { enum: ["not_required", "pending", "approved", "rejected"] }).notNull().default("not_required"),
  ...timestamps,
}, table => [
  uniqueIndex("r3_payment_record_reversal_unique").on(table.reversesPaymentRecordId),
  uniqueIndex("r3_payment_record_correction_unique").on(table.correctsPaymentRecordId),
]);

export const auditLogs = mysqlTable("audit_logs", {
  id: int("id").autoincrement().primaryKey(),
  actorUserId: int("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  module: text("module").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  businessNo: text("business_no"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  ipAddress: text("ip_address"),
  deviceId: varchar("device_id", { length: 191 }),
  sensitiveView: boolean("sensitive_view").notNull().default(false),
  exported: boolean("exported").notNull().default(false),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  archiveAfter: text("archive_after").notNull(),
});

export const supplierPerformanceWeightVersions = mysqlTable("supplier_performance_weight_versions", {
  id: int("id").autoincrement().primaryKey(),
  tier: int("tier").notNull(),
  effectiveFrom: varchar("effective_from", { length: 191 }).notNull(),
  deliveryWeightBps: int("delivery_weight_bps").notNull(),
  qualityWeightBps: int("quality_weight_bps").notNull(),
  exceptionWeightBps: int("exception_weight_bps").notNull(),
  preparationWeightBps: int("preparation_weight_bps").notNull(),
  satisfactionWeightBps: int("satisfaction_weight_bps").notNull().default(0),
  samplingWeightBps: int("sampling_weight_bps").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdBy: int("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("supplier_performance_weight_tier_date_unique").on(table.tier, table.effectiveFrom)]);

export const supplierPerformanceReviews = mysqlTable("supplier_performance_reviews", {
  id: int("id").autoincrement().primaryKey(),
  supplierId: int("supplier_id").notNull().references(() => suppliers.id),
  quarter: varchar("quarter", { length: 191 }).notNull(),
  reviewType: varchar("review_type", { length: 191, enum: ["satisfaction", "sampling"] }).notNull(),
  score: int("score").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  comment: text("comment").notNull().default(""),
  evaluatorUserId: int("evaluator_user_id").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("supplier_performance_review_unique").on(table.supplierId, table.quarter, table.reviewType, table.evaluatorUserId)]);

export const approvalRequests = mysqlTable("approval_requests", {
  id: int("id").autoincrement().primaryKey(),
  requestNo: varchar("request_no", { length: 191 }).notNull().unique(),
  workflowType: text("workflow_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: int("entity_id").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull(),
  highRisk: boolean("high_risk").notNull().default(false),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
  requestedBy: int("requested_by").notNull().references(() => users.id),
  requestedAt: datetime("requested_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  reviewedBy: int("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  reviewComment: text("review_comment"),
  smsVerifiedAt: text("sms_verified_at"),
  ...timestamps,
});

export const aiConversations = mysqlTable("ai_conversations", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  retainUntil: text("retain_until").notNull(),
  ...timestamps,
});

export const aiMessages = mysqlTable("ai_messages", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversation_id").notNull().references(() => aiConversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  citationJson: text("citation_json"),
  confidenceStatus: text("confidence_status", { enum: ["confirmed", "unable_to_confirm", "conflict"] }).notNull().default("confirmed"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const aiOperationDrafts = mysqlTable("ai_operation_drafts", {
  id: int("id").autoincrement().primaryKey(),
  conversationId: int("conversation_id").notNull().references(() => aiConversations.id),
  operationType: text("operation_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  highRisk: boolean("high_risk").notNull().default(false),
  status: text("status", { enum: ["draft", "confirmed", "submitted", "cancelled"] }).notNull().default("draft"),
  confirmedBy: int("confirmed_by").references(() => users.id),
  confirmedAt: text("confirmed_at"),
  ...timestamps,
});

export const fileObjects = mysqlTable("file_objects", {
  id: int("id").autoincrement().primaryKey(),
  objectKey: varchar("object_key", { length: 191 }).notNull().unique(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: int("size_bytes").notNull(),
  category: text("category").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  ownerUserId: int("owner_user_id").notNull().references(() => users.id),
  factoryId: int("factory_id").references(() => factories.id),
  supplierId: int("supplier_id").references(() => suppliers.id),
  sensitive: boolean("sensitive").notNull().default(false),
  scanStatus: varchar("scan_status", { length: 191, enum: ["quarantined", "clean", "rejected"] }).notNull().default("quarantined"),
  contentSha256: varchar("content_sha256", { length: 191 }).notNull().default(""),
  retainUntil: text("retain_until"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const importBatches = mysqlTable("import_batches", {
  id: int("id").autoincrement().primaryKey(),
  importNo: varchar("import_no", { length: 191 }).notNull().unique(),
  type: varchar("type", { length: 191 }).notNull(),
  fileObjectId: int("file_object_id").references(() => fileObjects.id),
  fileName: text("file_name").notNull(),
  fingerprint: text("fingerprint").notNull(),
  businessKey: text("business_key"),
  status: text("status", { enum: ["preview", "blocked", "awaiting_mapping", "awaiting_duplicate_confirmation", "committed", "cancelled"] }).notNull().default("preview"),
  totalRows: int("total_rows").notNull().default(0),
  validRows: int("valid_rows").notNull().default(0),
  errorCount: int("error_count").notNull().default(0),
  warningCount: int("warning_count").notNull().default(0),
  duplicateOfBatchId: int("duplicate_of_batch_id"),
  committedBy: int("committed_by").references(() => users.id),
  committedAt: text("committed_at"),
  createdBy: int("created_by").notNull().references(() => users.id),
  ...timestamps,
});

export const importStagingRows = mysqlTable("import_staging_rows", {
  id: int("id").autoincrement().primaryKey(),
  importBatchId: int("import_batch_id").notNull().references(() => importBatches.id),
  sheetName: text("sheet_name").notNull(),
  sourceRowNo: int("source_row_no").notNull(),
  businessKey: text("business_key"),
  normalizedJson: text("normalized_json").notNull(),
  rawJson: text("raw_json").notNull(),
  validationStatus: text("validation_status", { enum: ["valid", "warning", "error"] }).notNull(),
  validationMessagesJson: text("validation_messages_json").notNull().default("[]"),
  mappingConfirmed: boolean("mapping_confirmed").notNull().default(false),
});

export const reminderSchedules = mysqlTable("reminder_schedules", {
  id: int("id").autoincrement().primaryKey(),
  reminderType: text("reminder_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: int("entity_id").notNull(),
  businessNo: text("business_no"),
  dueAt: text("due_at").notNull(),
  nextRunAt: text("next_run_at").notNull(),
  recurrence: text("recurrence", { enum: ["once", "daily_overdue", "milestones"] }).notNull(),
  milestoneDaysJson: text("milestone_days_json").notNull().default("[]"),
  recipientRoleJson: text("recipient_role_json").notNull(),
  recipientUserIdsJson: text("recipient_user_ids_json").notNull().default("[]"),
  channelsJson: text("channels_json").notNull().default("[\"in_app\",\"email\"]"),
  severity: text("severity", { enum: ["normal", "yellow", "red", "approval"] }).notNull().default("normal"),
  quietHoursBypass: boolean("quiet_hours_bypass").notNull().default(false),
  status: text("status", { enum: ["active", "completed", "cancelled"] }).notNull().default("active"),
  lastRunAt: text("last_run_at"),
  ...timestamps,
});

export const notificationMessages = mysqlTable("notification_messages", {
  id: int("id").autoincrement().primaryKey(),
  recipientUserId: int("recipient_user_id").references(() => users.id),
  recipientRole: text("recipient_role"),
  recipientFactoryId: int("recipient_factory_id").references(() => factories.id),
  recipientSupplierId: int("recipient_supplier_id").references(() => suppliers.id),
  channel: text("channel", { enum: ["in_app", "email"] }).notNull(),
  type: varchar("type", { length: 191 }).notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: int("entity_id").notNull(),
  businessNo: text("business_no"),
  status: text("status", { enum: ["queued", "sent", "failed", "read"] }).notNull().default("queued"),
  sentAt: text("sent_at"),
  readAt: text("read_at"),
  errorMessage: text("error_message"),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const authCredentials = mysqlTable("auth_credentials", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().unique().references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  failedAttempts: int("failed_attempts").notNull().default(0),
  lockedAt: text("locked_at"),
  passwordChangedAt: datetime("password_changed_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  ...timestamps,
});

export const authChallenges = mysqlTable("auth_challenges", {
  id: int("id").autoincrement().primaryKey(),
  challengeNo: varchar("challenge_no", { length: 191 }).notNull().unique(),
  userId: int("user_id").notNull().references(() => users.id),
  purpose: text("purpose", { enum: ["login", "high_risk", "phone_change"] }).notNull(),
  codeHash: text("code_hash").notNull(),
  deviceId: varchar("device_id", { length: 191 }).notNull(),
  ipAddress: text("ip_address"),
  region: text("region"),
  expiresAt: text("expires_at").notNull(),
  attempts: int("attempts").notNull().default(0),
  verifiedAt: text("verified_at"),
  sessionId: int("session_id").references(() => authSessions.id),
  action: text("action"),
  objectType: varchar("object_type", { length: 191 }),
  objectId: varchar("object_id", { length: 191 }),
  objectVersion: bigint("object_version", { mode: "number" }),
  requestDigest: varchar("request_digest", { length: 191 }),
  consumedAt: text("consumed_at"),
  ...timestamps,
});

export const r3BusinessKeys = mysqlTable("r3_business_keys", {
  keyType: varchar("key_type", { length: 64 }).notNull(),
  keyValue: varchar("key_value", { length: 191 }).notNull(),
  aggregateId: varchar("aggregate_id", { length: 191 }).notNull(),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, table => [uniqueIndex("r3_business_keys_identity_unique").on(table.keyType, table.keyValue)]);

export const trustedDevices = mysqlTable("trusted_devices", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id),
  deviceId: varchar("device_id", { length: 191 }).notNull(),
  deviceName: text("device_name").notNull().default(""),
  lastIpAddress: text("last_ip_address"),
  lastRegion: text("last_region"),
  trustedUntil: text("trusted_until").notNull(),
  revokedAt: text("revoked_at"),
  lastUsedAt: datetime("last_used_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  ...timestamps,
}, table => [uniqueIndex("trusted_user_device_unique").on(table.userId, table.deviceId)]);

export const authSessions = mysqlTable("auth_sessions", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("user_id").notNull().references(() => users.id),
  tokenHash: varchar("token_hash", { length: 191 }).notNull().unique(),
  deviceId: varchar("device_id", { length: 191 }).notNull(),
  ipAddress: text("ip_address"),
  region: text("region"),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: datetime("last_seen_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  createdAt: datetime("created_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const writerFences = mysqlTable("writer_fences", {
  resource: varchar("resource", { length: 191 }).primaryKey(),
  owner: varchar("owner", { length: 191 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  generation: int("generation").notNull().default(1),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
});

export const commandIdempotency = mysqlTable("command_idempotency", {
  id: int("id").autoincrement().primaryKey(),
  commandName: varchar("command_name", { length: 191 }).notNull(),
  actorScope: varchar("actor_scope", { length: 191 }).notNull(),
  idempotencyKey: varchar("idempotency_key", { length: 191 }).notNull(),
  requestDigest: varchar("request_digest", { length: 191 }).notNull(),
  status: text("status", { enum: ["pending", "completed", "unknown"] }).notNull().default("pending"),
  responseStatus: int("response_status"),
  responseJson: text("response_json"),
  expiresAt: text("expires_at").notNull(),
  ...timestamps,
}, table => [uniqueIndex("command_idempotency_scope_key_unique").on(table.commandName, table.actorScope, table.idempotencyKey)]);

export const outboxMessages = mysqlTable("outbox_messages", {
  id: int("id").autoincrement().primaryKey(),
  topic: varchar("topic", { length: 191 }).notNull(),
  aggregateType: varchar("aggregate_type", { length: 191 }).notNull(),
  aggregateId: varchar("aggregate_id", { length: 191 }).notNull(),
  deduplicationKey: varchar("deduplication_key", { length: 191 }).notNull().unique(),
  payloadJson: text("payload_json").notNull(),
  status: text("status", { enum: ["pending", "processing", "completed", "dead"] }).notNull().default("pending"),
  availableAt: text("available_at").notNull(),
  attempts: int("attempts").notNull().default(0),
  maxAttempts: int("max_attempts").notNull().default(8),
  lockedBy: text("locked_by"),
  lockedAt: text("locked_at"),
  lastErrorCode: text("last_error_code"),
  completedAt: text("completed_at"),
  ...timestamps,
});

export const resourceVersions = mysqlTable("resource_versions", {
  resourceType: varchar("resource_type", { length: 191 }).notNull(),
  resourceId: varchar("resource_id", { length: 191 }).notNull(),
  version: int("version").notNull().default(1),
  updatedAt: datetime("updated_at", { mode: "string", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, table => [uniqueIndex("resource_versions_identity_unique").on(table.resourceType, table.resourceId)]);
