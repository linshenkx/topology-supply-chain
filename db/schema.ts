import { sql } from "drizzle-orm";
import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const timestamps = {
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
};

export const factories = sqliteTable("factories", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  code: text("code").notNull().unique(),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const suppliers = sqliteTable("suppliers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  tier: integer("tier"),
  supplierType: text("supplier_type", { enum: ["core_component", "noncore_component", "auxiliary"] }),
  managedByFactoryId: integer("managed_by_factory_id").references(() => factories.id),
  legalName: text("legal_name").notNull().default(""),
  unifiedSocialCreditCode: text("unified_social_credit_code").notNull().default(""),
  businessLicenseFileKey: text("business_license_file_key"),
  businessLicenseExpiresAt: text("business_license_expires_at"),
  businessLicenseLongTerm: integer("business_license_long_term", { mode: "boolean" }).notNull().default(false),
  address: text("address").notNull().default(""),
  contactName: text("contact_name").notNull().default(""),
  contactPhone: text("contact_phone").notNull().default(""),
  businessScope: text("business_scope").notNull().default(""),
  source: text("source").notNull().default("manual"),
  sourceCreatedAt: text("source_created_at"),
  verificationStatus: text("verification_status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  verifiedBy: integer("verified_by"),
  verifiedAt: text("verified_at"),
  supplyRisk: text("supply_risk", { enum: ["low", "medium", "high", "critical"] }).notNull().default("low"),
  riskReason: text("risk_reason").notNull().default(""),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const supplierContacts = sqliteTable("supplier_contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  email: text("email").notNull().default(""),
  wechat: text("wechat").notNull().default(""),
  responsibility: text("responsibility", { enum: ["purchasing", "production", "quality", "finance", "other"] }).notNull().default("other"),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
});

export const supplierBankAccounts = sqliteTable("supplier_bank_accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  accountName: text("account_name").notNull(),
  bankName: text("bank_name").notNull(),
  encryptedAccountNo: text("encrypted_account_no").notNull(),
  usage: text("usage", { enum: ["company_payment", "restricted_reference", "factory_only"] }).notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
});

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  mobile: text("mobile").notNull().default(""),
  name: text("name").notNull(),
  role: text("role", { enum: ["supply_chain", "finance", "factory", "supplier_qc", "company_qc"] }).notNull(),
  factoryId: integer("factory_id").references(() => factories.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  organizationName: text("organization_name").notNull().default(""),
  accountStatus: text("account_status", { enum: ["pending", "active", "locked", "disabled"] }).notNull().default("active"),
  ...timestamps,
});

export const purchaseOrders = sqliteTable("purchase_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderNo: text("order_no").notNull().unique(),
  source: text("source").notNull().default("lingxing_excel"),
  sourceFileKey: text("source_file_key"),
  status: text("status").notNull().default("draft"),
  orderDate: text("order_date"),
  totalTaxIncludedMinor: integer("total_tax_included_minor").notNull().default(0),
  paymentTermId: integer("payment_term_id"),
  ...timestamps,
});

export const purchaseImports = sqliteTable("purchase_imports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  detectedOrderNo: text("detected_order_no"),
  matchedPurchaseOrderId: integer("matched_purchase_order_id").references(() => purchaseOrders.id),
  isPossibleDuplicate: integer("is_possible_duplicate", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["analyzing", "awaiting_confirmation", "applied", "cancelled"] }).notNull().default("analyzing"),
  importedBy: integer("imported_by").notNull().references(() => users.id),
  ...timestamps,
});

export const purchaseImportDiffs = sqliteTable("purchase_import_diffs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseImportId: integer("purchase_import_id").notNull().references(() => purchaseImports.id),
  sheetName: text("sheet_name").notNull(),
  rowKey: text("row_key").notNull(),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  changeType: text("change_type", { enum: ["added", "changed", "removed"] }).notNull(),
});

export const orderItems = sqliteTable("order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  sku: text("sku").notNull(),
  productName: text("product_name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }).notNull(),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  quantity: integer("quantity").notNull(),
  unitPriceTaxIncludedMinor: integer("unit_price_tax_included_minor").notNull().default(0),
  amountTaxIncludedMinor: integer("amount_tax_included_minor").notNull().default(0),
  dueDate: text("due_date"),
  ...timestamps,
}, table => [uniqueIndex("order_item_unique").on(table.purchaseOrderId, table.sku, table.supplierId)]);

export const supplierSkus = sqliteTable("supplier_skus", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  sku: text("sku").notNull(),
  isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
  priority: integer("priority").notNull().default(1),
  minimumOrderQuantity: integer("minimum_order_quantity").notNull().default(1),
  packagingMultiple: integer("packaging_multiple").notNull().default(1),
  purchaseUnit: text("purchase_unit").notNull().default(""),
  leadTimeDays: integer("lead_time_days"),
  dailyCapacity: integer("daily_capacity"),
  monthlyCapacity: integer("monthly_capacity"),
  effectiveFrom: text("effective_from").notNull(),
  status: text("status", { enum: ["pending", "active", "inactive"] }).notNull().default("pending"),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("supplier_sku_unique").on(table.factoryId, table.supplierId, table.sku)]);

export const corePriceAgreements = sqliteTable("core_price_agreements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  sku: text("sku").notNull(),
  currency: text("currency").notNull().default("CNY"),
  unitPriceTaxIncludedMinor: integer("unit_price_tax_included_minor").notNull(),
  unitPriceTaxExcludedMinor: integer("unit_price_tax_excluded_minor").notNull(),
  taxRateBps: integer("tax_rate_bps").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  status: text("status").notNull().default("active"),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const corePriceChangeRequests = sqliteTable("core_price_change_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  currentAgreementId: integer("current_agreement_id").references(() => corePriceAgreements.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  sku: text("sku").notNull(),
  proposedTaxIncludedMinor: integer("proposed_tax_included_minor").notNull(),
  proposedTaxExcludedMinor: integer("proposed_tax_excluded_minor").notNull(),
  proposedTaxRateBps: integer("proposed_tax_rate_bps").notNull(),
  proposedEffectiveFrom: text("proposed_effective_from").notNull(),
  reason: text("reason").notNull(),
  evidenceFileKey: text("evidence_file_key").notNull(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewComment: text("review_comment"),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const factorySupplierDeliverySettings = sqliteTable("factory_supplier_delivery_settings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  componentSku: text("component_sku").notNull(),
  arrivalBufferDays: integer("arrival_buffer_days").notNull(),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("factory_supplier_sku_buffer_unique").on(table.factoryId, table.supplierId, table.componentSku)]);

export const deliverySettingChanges = sqliteTable("delivery_setting_changes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  settingId: integer("setting_id").notNull().references(() => factorySupplierDeliverySettings.id),
  oldDays: integer("old_days").notNull(),
  newDays: integer("new_days").notNull(),
  reason: text("reason").notNull(),
  changedBy: integer("changed_by").notNull().references(() => users.id),
  supplyChainNotifiedAt: text("supply_chain_notified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const skus = sqliteTable("skus", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  stockUnit: text("stock_unit"),
  serialTrackingEnabled: integer("serial_tracking_enabled", { mode: "boolean" }).notNull().default(false),
  overproductionToleranceBps: integer("overproduction_tolerance_bps").notNull().default(0),
  purchaseOverToleranceBps: integer("purchase_over_tolerance_bps").notNull().default(0),
  purchaseUnderToleranceBps: integer("purchase_under_tolerance_bps").notNull().default(0),
  verificationStatus: text("verification_status", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  status: text("status", { enum: ["draft", "active", "inactive"] }).notNull().default("draft"),
  ...timestamps,
});

export const skuUnitConversions = sqliteTable("sku_unit_conversions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skuId: integer("sku_id").notNull().references(() => skus.id),
  purchaseUnit: text("purchase_unit").notNull(),
  stockUnit: text("stock_unit").notNull(),
  purchaseUnitQuantity: integer("purchase_unit_quantity").notNull(),
  stockUnitQuantity: integer("stock_unit_quantity").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  ...timestamps,
}, table => [uniqueIndex("sku_purchase_unit_unique").on(table.skuId, table.purchaseUnit, table.effectiveFrom)]);

export const productBoms = sqliteTable("product_boms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  finishedSku: text("finished_sku").notNull(),
  version: text("version").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  overlapAllowed: integer("overlap_allowed", { mode: "boolean" }).notNull().default(false),
  overlapReason: text("overlap_reason").notNull().default(""),
  approvalStatus: text("approval_status", { enum: ["draft", "pending", "approved", "rejected"] }).notNull().default("draft"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdBy: integer("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("product_bom_version_unique").on(table.finishedSku, table.version)]);

export const bomComponents = sqliteTable("bom_components", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  bomId: integer("bom_id").notNull().references(() => productBoms.id),
  componentSku: text("component_sku").notNull(),
  itemType: text("item_type", { enum: ["auxiliary", "component"] }).notNull(),
  isCore: integer("is_core", { mode: "boolean" }).notNull().default(false),
  quantityPerFinished: integer("quantity_per_finished").notNull(),
  issueToleranceBps: integer("issue_tolerance_bps").notNull().default(0),
  consumptionToleranceBps: integer("consumption_tolerance_bps").notNull().default(0),
  lossToleranceBps: integer("loss_tolerance_bps").notNull().default(0),
}, table => [uniqueIndex("bom_component_unique").on(table.bomId, table.componentSku)]);

export const skuFactoryDefaults = sqliteTable("sku_factory_defaults", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: text("sku").notNull().unique(),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  selectedBy: integer("selected_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryChangeRequests = sqliteTable("factory_change_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  sku: text("sku").notNull(),
  fromFactoryId: integer("from_factory_id").notNull().references(() => factories.id),
  toFactoryId: integer("to_factory_id").notNull().references(() => factories.id),
  reason: text("reason").notNull(),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewComment: text("review_comment"),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const purchasePlans = sqliteTable("purchase_plans", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  planNo: text("plan_no").notNull(),
  version: integer("version").notNull().default(1),
  source: text("source").notNull().default("lingxing_excel"),
  sourceFileKey: text("source_file_key"),
  status: text("status", { enum: ["draft", "pending_approval", "awaiting_factory_confirmation", "confirmed", "disputed", "ordering", "ordered_complete", "superseded"] }).notNull().default("draft"),
  confirmationDueAt: text("confirmation_due_at"),
  confirmedAt: text("confirmed_at"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_version_unique").on(table.planNo, table.version)]);

export const purchasePlanItems = sqliteTable("purchase_plan_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchasePlanId: integer("purchase_plan_id").notNull().references(() => purchasePlans.id),
  expectedArrivalDate: text("expected_arrival_date").notNull(),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  productName: text("product_name").notNull(),
  bomId: integer("bom_id").notNull().references(() => productBoms.id),
  plannedQuantity: integer("planned_quantity").notNull(),
  orderedQuantity: integer("ordered_quantity").notNull().default(0),
  overToleranceBps: integer("over_tolerance_bps").notNull().default(0),
  underToleranceBps: integer("under_tolerance_bps").notNull().default(0),
  completionStatus: text("completion_status", { enum: ["not_ordered", "within_tolerance", "over_plan_pending", "under_plan_pending", "exception_approved"] }).notNull().default("not_ordered"),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_summary_key").on(table.purchasePlanId, table.expectedArrivalDate, table.factoryId, table.warehouseId, table.sku)]);

export const purchasePlanSourceRows = sqliteTable("purchase_plan_source_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchasePlanId: integer("purchase_plan_id").notNull().references(() => purchasePlans.id),
  sourceRowNo: integer("source_row_no").notNull(),
  sourcePlanNo: text("source_plan_no").notNull(),
  isCombinationMain: integer("is_combination_main", { mode: "boolean" }).notNull().default(false),
  ignoredExpandedItem: integer("ignored_expanded_item", { mode: "boolean" }).notNull().default(false),
  rawJson: text("raw_json").notNull(),
});

export const purchasePlanOrderLinks = sqliteTable("purchase_plan_order_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchasePlanItemId: integer("purchase_plan_item_id").notNull().references(() => purchasePlanItems.id),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id),
  allocatedQuantity: integer("allocated_quantity").notNull(),
  matchMethod: text("match_method", { enum: ["automatic", "manual"] }).notNull(),
  confirmedBy: integer("confirmed_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("purchase_plan_order_link_unique").on(table.purchasePlanItemId, table.orderItemId)]);

export const factoryPlanResponses = sqliteTable("factory_plan_responses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchasePlanId: integer("purchase_plan_id").notNull().references(() => purchasePlans.id),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  decision: text("decision", { enum: ["confirmed", "unable"] }).notNull(),
  expectedStartDate: text("expected_start_date").notNull(),
  expectedFinishDate: text("expected_finish_date").notNull(),
  proposedArrivalDate: text("proposed_arrival_date"),
  reason: text("reason").notNull().default(""),
  status: text("status", { enum: ["accepted", "pending_supply_chain", "approved", "rejected"] }).notNull(),
  respondedBy: integer("responded_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const executionOrders = sqliteTable("execution_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionNo: text("execution_no").notNull().unique(),
  orderItemId: integer("order_item_id").notNull().references(() => orderItems.id),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  bomId: integer("bom_id").references(() => productBoms.id),
  plannedQuantity: integer("planned_quantity").notNull(),
  completedQuantity: integer("completed_quantity").notNull().default(0),
  status: text("status").notNull().default("factory_confirmation"),
  dueDate: text("due_date"),
  plannedStartDate: text("planned_start_date"),
  plannedFinishDate: text("planned_finish_date"),
  actualStartAt: text("actual_start_at"),
  actualFinishAt: text("actual_finish_at"),
  ...timestamps,
});

export const productionMaterialLines = sqliteTable("production_material_lines", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionOrderId: integer("execution_order_id").notNull().references(() => executionOrders.id),
  bomComponentId: integer("bom_component_id").notNull().references(() => bomComponents.id),
  theoreticalQuantity: integer("theoretical_quantity").notNull(),
  reservedQuantity: integer("reserved_quantity").notNull().default(0),
  issuedQuantity: integer("issued_quantity").notNull().default(0),
  consumedQuantity: integer("consumed_quantity").notNull().default(0),
  lossQuantity: integer("loss_quantity").notNull().default(0),
  deviationStatus: text("deviation_status", { enum: ["within_tolerance", "pending_approval", "approved", "rejected"] }).notNull().default("within_tolerance"),
  ...timestamps,
});

export const productionReports = sqliteTable("production_reports", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionOrderId: integer("execution_order_id").notNull().references(() => executionOrders.id),
  actualFinishedQuantity: integer("actual_finished_quantity").notNull(),
  varianceQuantity: integer("variance_quantity").notNull(),
  varianceRateBps: integer("variance_rate_bps").notNull(),
  result: text("result", { enum: ["within_tolerance", "overproduction_quarantined", "underproduction_pending", "approved", "rejected_factory_owned"] }).notNull(),
  companyInventoryQuantity: integer("company_inventory_quantity").notNull().default(0),
  factoryOwnedQuantity: integer("factory_owned_quantity").notNull().default(0),
  reportedBy: integer("reported_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const coreSupplierOrders = sqliteTable("core_supplier_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  orderNo: text("order_no").notNull().unique(),
  sourcePurchaseOrderId: integer("source_purchase_order_id").notNull().references(() => purchaseOrders.id),
  assemblyFactoryId: integer("assembly_factory_id").notNull().references(() => factories.id),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  plannedShipDate: text("planned_ship_date").notNull(),
  status: text("status", { enum: ["awaiting_confirmation", "confirmed", "unable_to_fulfill", "shipped", "completed"] }).notNull().default("awaiting_confirmation"),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  confirmedAt: text("confirmed_at"),
  inabilityReason: text("inability_reason"),
  proposedShipDate: text("proposed_ship_date"),
  alertStatus: text("alert_status", { enum: ["none", "open", "resolved"] }).notNull().default("none"),
  ...timestamps,
});

export const coreOrderReschedules = sqliteTable("core_order_reschedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coreSupplierOrderId: integer("core_supplier_order_id").notNull().references(() => coreSupplierOrders.id),
  previousShipDate: text("previous_ship_date").notNull(),
  proposedShipDate: text("proposed_ship_date").notNull(),
  supplierReason: text("supplier_reason").notNull(),
  factoryDecision: text("factory_decision", { enum: ["pending", "confirmed", "rejected"] }).notNull().default("pending"),
  factoryConfirmedBy: integer("factory_confirmed_by").references(() => users.id),
  factoryConfirmedAt: text("factory_confirmed_at"),
  supplyChainDecision: text("supply_chain_decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  supplyChainReviewedBy: integer("supply_chain_reviewed_by").references(() => users.id),
  supplyChainReviewedAt: text("supply_chain_reviewed_at"),
  reviewComment: text("review_comment"),
  ...timestamps,
});

export const coreSupplierOrderItems = sqliteTable("core_supplier_order_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  coreSupplierOrderId: integer("core_supplier_order_id").notNull().references(() => coreSupplierOrders.id),
  componentSku: text("component_sku").notNull(),
  quantity: integer("quantity").notNull(),
  priceAgreementId: integer("price_agreement_id").notNull().references(() => corePriceAgreements.id),
  currency: text("currency").notNull(),
  unitPriceTaxIncludedMinor: integer("unit_price_tax_included_minor").notNull(),
  unitPriceTaxExcludedMinor: integer("unit_price_tax_excluded_minor").notNull(),
  taxRateBps: integer("tax_rate_bps").notNull(),
  amountTaxIncludedMinor: integer("amount_tax_included_minor").notNull(),
  amountTaxExcludedMinor: integer("amount_tax_excluded_minor").notNull(),
}, table => [uniqueIndex("core_supplier_order_item_unique").on(table.coreSupplierOrderId, table.componentSku)]);

export const factoryPaymentTerms = sqliteTable("factory_payment_terms", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  name: text("name").notNull(),
  mode: text("mode", { enum: ["shipment_plus_days", "monthly_cutoff"] }).notNull(),
  daysAfterShipment: integer("days_after_shipment"),
  cutoffDay: integer("cutoff_day"),
  settlementMonthOffset: integer("settlement_month_offset"),
  paymentDay: integer("payment_day"),
  invoiceRequired: integer("invoice_required", { mode: "boolean" }).notNull().default(true),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryPaymentSchedules = sqliteTable("factory_payment_schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  deliveryBatchId: integer("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  paymentType: text("payment_type", { enum: ["prepayment", "progress", "balance", "other"] }).notNull(),
  rateBps: integer("rate_bps"),
  shippedQuantity: integer("shipped_quantity").notNull(),
  unitPriceMinor: integer("unit_price_minor").notNull(),
  amountMinor: integer("amount_minor").notNull(),
  paymentTermId: integer("payment_term_id").notNull().references(() => factoryPaymentTerms.id),
  paymentRuleSnapshot: text("payment_rule_snapshot").notNull(),
  plannedPaymentDate: text("planned_payment_date").notNull(),
  triggerEvent: text("trigger_event", { enum: ["actual_shipment"] }).notNull().default("actual_shipment"),
  status: text("status", { enum: ["planned", "requested", "paid", "cancelled"] }).notNull().default("planned"),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const factoryPaymentRequests = sqliteTable("factory_payment_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestNo: text("request_no").notNull().unique(),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  actualShipmentDate: text("actual_shipment_date").notNull(),
  plannedPaymentDate: text("planned_payment_date").notNull(),
  totalAmountMinor: integer("total_amount_minor").notNull(),
  autoGenerated: integer("auto_generated", { mode: "boolean" }).notNull().default(true),
  status: text("status", { enum: ["waiting_invoice", "generated", "submitted_to_finance", "paid", "partially_paid", "invoice_exception_frozen", "failed", "cancelled"] }).notNull().default("waiting_invoice"),
  invoiceCoveredAmountMinor: integer("invoice_covered_amount_minor").notNull().default(0),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  submittedToFinanceAt: text("submitted_to_finance_at"),
  supplyChainNotifiedAt: text("supply_chain_notified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  financeNotifiedAt: text("finance_notified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  paidAt: text("paid_at"),
  paymentReference: text("payment_reference"),
  paymentNote: text("payment_note"),
  ...timestamps,
}, table => [uniqueIndex("factory_payment_request_group_unique").on(table.factoryId, table.plannedPaymentDate)]);

export const factoryPaymentRequestItems = sqliteTable("factory_payment_request_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  paymentRequestId: integer("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  paymentScheduleId: integer("payment_schedule_id").notNull().references(() => factoryPaymentSchedules.id),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  triggeredByDeliveryBatchId: integer("triggered_by_delivery_batch_id").notNull().references(() => deliveryBatches.id),
  amountMinor: integer("amount_minor").notNull(),
}, table => [uniqueIndex("payment_request_schedule_unique").on(table.paymentRequestId, table.paymentScheduleId)]);

export const factoryInvoices = sqliteTable("factory_invoices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  factoryId: integer("factory_id").notNull().references(() => factories.id),
  purchaseOrderId: integer("purchase_order_id").notNull().references(() => purchaseOrders.id),
  coverageMode: text("coverage_mode", { enum: ["full_order", "delivery_batch"] }).notNull(),
  deliveryBatchId: integer("delivery_batch_id").references(() => deliveryBatches.id),
  invoiceNo: text("invoice_no").notNull().unique(),
  invoiceType: text("invoice_type", { enum: ["vat_special", "vat_general", "other"] }).notNull(),
  amountTaxIncludedMinor: integer("amount_tax_included_minor").notNull(),
  taxAmountMinor: integer("tax_amount_minor").notNull(),
  issuedAt: text("issued_at").notNull(),
  receivedAt: text("received_at"),
  fileKey: text("file_key"),
  status: text("status", { enum: ["pending", "received", "verified", "rejected", "invalidated"] }).notNull().default("pending"),
  expectedAmountMinor: integer("expected_amount_minor").notNull(),
  amountMatchesExpected: integer("amount_matches_expected", { mode: "boolean" }).notNull().default(false),
  mismatchAmountMinor: integer("mismatch_amount_minor").notNull().default(0),
  maintainedBy: integer("maintained_by").notNull().references(() => users.id),
  ...timestamps,
});

export const notifications = sqliteTable("notifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipientRole: text("recipient_role", { enum: ["supply_chain", "finance"] }).notNull(),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  readAt: text("read_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const deliveryBatches = sqliteTable("delivery_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionOrderId: integer("execution_order_id").notNull().references(() => executionOrders.id),
  batchNo: text("batch_no").notNull(),
  quantity: integer("quantity").notNull(),
  plannedShipAt: text("planned_ship_at").notNull(),
  shippedAt: text("shipped_at"),
  carrier: text("carrier").notNull(),
  logisticsNo: text("logistics_no").notNull(),
  destination: text("destination").notNull(),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
  deviationReason: text("deviation_reason"),
  status: text("status").notNull().default("planned"),
  ...timestamps,
}, table => [uniqueIndex("delivery_batch_unique").on(table.executionOrderId, table.batchNo)]);

export const shipmentEvidence = sqliteTable("shipment_evidence", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deliveryBatchId: integer("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const shipmentReceipts = sqliteTable("shipment_receipts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  deliveryBatchId: integer("delivery_batch_id").notNull().references(() => deliveryBatches.id),
  receivedQuantity: integer("received_quantity").notNull(),
  damagedQuantity: integer("damaged_quantity").notNull().default(0),
  receivedAt: text("received_at").notNull(),
  evidenceFileKey: text("evidence_file_key").notNull(),
  exceptionReason: text("exception_reason").notNull().default(""),
  receivedBy: integer("received_by").notNull().references(() => users.id),
  ...timestamps,
});

export const productReturns = sqliteTable("product_returns", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  returnNo: text("return_no").notNull().unique(),
  sourceDeliveryBatchId: integer("source_delivery_batch_id").notNull().references(() => deliveryBatches.id),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  batchId: integer("batch_id").references(() => inventoryBatches.id),
  status: text("status", { enum: ["return_in_transit", "quarantined", "inspection", "pending_supply_chain", "restocked", "rework", "scrapped"] }).notNull(),
  proposedDisposition: text("proposed_disposition", { enum: ["restock", "rework", "scrap"] }),
  proposedBy: integer("proposed_by").references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const productReturnInspections = sqliteTable("product_return_inspections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productReturnId: integer("product_return_id").notNull().references(() => productReturns.id),
  inspectedQuantity: integer("inspected_quantity").notNull(),
  passedQuantity: integer("passed_quantity").notNull(),
  failedQuantity: integer("failed_quantity").notNull(),
  defectReason: text("defect_reason").notNull().default(""),
  evidenceFileKey: text("evidence_file_key").notNull(),
  inspectedBy: integer("inspected_by").notNull().references(() => users.id),
  inspectedAt: text("inspected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const productReturnDispositions = sqliteTable("product_return_dispositions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  productReturnId: integer("product_return_id").notNull().references(() => productReturns.id),
  type: text("type", { enum: ["restock", "rework", "scrap"] }).notNull(),
  quantity: integer("quantity").notNull(),
  proposedBy: integer("proposed_by").notNull().references(() => users.id),
  status: text("status", { enum: ["pending_supply_chain", "approved", "rejected"] }).notNull().default("pending_supply_chain"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
}, table => [uniqueIndex("product_return_disposition_unique").on(table.productReturnId, table.type)]);

export const supplyRiskCases = sqliteTable("supply_risk_cases", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  riskNo: text("risk_no").notNull().unique(),
  assemblyFactoryId: integer("assembly_factory_id").notNull().references(() => factories.id),
  sourceSupplierId: integer("source_supplier_id").references(() => suppliers.id),
  sourceTier: integer("source_tier").notNull(),
  affectedEntityType: text("affected_entity_type").notNull(),
  affectedEntityId: integer("affected_entity_id").notNull(),
  triggerType: text("trigger_type", { enum: ["factory_reported", "system_predicted"] }).notNull(),
  impactSummary: text("impact_summary").notNull(),
  responseDueAt: text("response_due_at").notNull(),
  factoryPlan: text("factory_plan"),
  proposedDeliveryDate: text("proposed_delivery_date"),
  status: text("status", { enum: ["open", "pending_supply_chain", "approved", "rejected", "resolved"] }).notNull().default("open"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const exceptions = sqliteTable("exceptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionOrderId: integer("execution_order_id").references(() => executionOrders.id),
  factoryId: integer("factory_id").references(() => factories.id),
  type: text("type", { enum: ["quality_failure", "quality_override", "concession_acceptance", "overproduction", "stocktake_variance", "shortage", "shipment_deviation", "logistics_exception", "warehouse_transfer"] }).notNull(),
  description: text("description").notNull(),
  evidenceFileKey: text("evidence_file_key"),
  status: text("status").notNull().default("pending_supply_chain"),
  submittedBy: integer("submitted_by").notNull().references(() => users.id),
  ...timestamps,
});

export const approvals = sqliteTable("approvals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  exceptionId: integer("exception_id").notNull().references(() => exceptions.id),
  decision: text("decision", { enum: ["approved", "rejected", "rework"] }).notNull(),
  comment: text("comment").notNull().default(""),
  approvedBy: integer("approved_by").notNull().references(() => users.id),
  approvedAt: text("approved_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const warehouses = sqliteTable("warehouses", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  type: text("type", { enum: ["factory", "company", "other"] }).notNull(),
  factoryId: integer("factory_id").references(() => factories.id),
  address: text("address").notNull().default(""),
  status: text("status").notNull().default("active"),
  ...timestamps,
});

export const inventory = sqliteTable("inventory", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }).notNull(),
  availableQuantity: integer("available_quantity").notNull().default(0),
  lockedQuantity: integer("locked_quantity").notNull().default(0),
  quarantinedQuantity: integer("quarantined_quantity").notNull().default(0),
  ...timestamps,
}, table => [uniqueIndex("inventory_warehouse_sku_unique").on(table.warehouseId, table.sku)]);

export const inventoryBatches = sqliteTable("inventory_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchNo: text("batch_no").notNull().unique(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  productionDate: text("production_date"),
  inboundDate: text("inbound_date").notNull(),
  expiryDate: text("expiry_date"),
  productionDateEstimated: integer("production_date_estimated", { mode: "boolean" }).notNull().default(false),
  expiryDateEstimated: integer("expiry_date_estimated", { mode: "boolean" }).notNull().default(false),
  availableQuantity: integer("available_quantity").notNull().default(0),
  lockedQuantity: integer("locked_quantity").notNull().default(0),
  defectiveQuantity: integer("defective_quantity").notNull().default(0),
  pendingInspectionQuantity: integer("pending_inspection_quantity").notNull().default(0),
  quarantineQuantity: integer("quarantine_quantity").notNull().default(0),
  ownership: text("ownership", { enum: ["company", "factory"] }).notNull().default("company"),
  expiryStatus: text("expiry_status", { enum: ["normal", "yellow", "red", "expired_frozen"] }).notNull().default("normal"),
  ...timestamps,
}, table => [uniqueIndex("inventory_batch_warehouse_unique").on(table.warehouseId, table.batchNo)]);

export const inventoryReservations = sqliteTable("inventory_reservations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  batchId: integer("batch_id").notNull().references(() => inventoryBatches.id),
  entityType: text("entity_type", { enum: ["purchase_order", "production_order", "shipment_plan", "historical"] }).notNull(),
  entityId: integer("entity_id"),
  requestedQuantity: integer("requested_quantity").notNull(),
  reservedQuantity: integer("reserved_quantity").notNull(),
  shortageQuantity: integer("shortage_quantity").notNull().default(0),
  priority: integer("priority").notNull().default(0),
  status: text("status", { enum: ["active", "released", "consumed"] }).notNull().default("active"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  ...timestamps,
});

export const stocktakes = sqliteTable("stocktakes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stocktakeNo: text("stocktake_no").notNull().unique(),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  scope: text("scope", { enum: ["full_warehouse", "sku_sample", "batch"] }).notNull(),
  dueDate: text("due_date").notNull(),
  status: text("status", { enum: ["draft", "frozen", "first_count", "recount", "pending_approval", "completed"] }).notNull().default("draft"),
  frozenAt: text("frozen_at"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  assignedFactoryId: integer("assigned_factory_id").references(() => factories.id),
  ...timestamps,
});

export const stocktakeCounts = sqliteTable("stocktake_counts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stocktakeId: integer("stocktake_id").notNull().references(() => stocktakes.id),
  batchId: integer("batch_id").references(() => inventoryBatches.id),
  sku: text("sku").notNull(),
  countRound: integer("count_round").notNull(),
  availableQuantity: integer("available_quantity").notNull(),
  lockedQuantity: integer("locked_quantity").notNull(),
  defectiveQuantity: integer("defective_quantity").notNull(),
  pendingInspectionQuantity: integer("pending_inspection_quantity").notNull(),
  totalQuantity: integer("total_quantity").notNull(),
  countedBy: integer("counted_by").notNull().references(() => users.id),
  countedAt: text("counted_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("stocktake_count_round_unique").on(table.stocktakeId, table.sku, table.batchId, table.countRound)]);

export const stocktakeAdjustments = sqliteTable("stocktake_adjustments", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  stocktakeId: integer("stocktake_id").notNull().references(() => stocktakes.id),
  stocktakeCountId: integer("stocktake_count_id").notNull().references(() => stocktakeCounts.id),
  varianceQuantity: integer("variance_quantity").notNull(),
  generatedBatchNo: text("generated_batch_no"),
  estimatedProductionDate: text("estimated_production_date"),
  estimatedExpiryDate: text("estimated_expiry_date"),
  decision: text("decision", { enum: ["pending", "approved", "rejected"] }).notNull().default("pending"),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const inventoryMovements = sqliteTable("inventory_movements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  warehouseId: integer("warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  type: text("type", { enum: ["inbound", "shipment", "transfer_out", "transfer_in", "adjustment"] }).notNull(),
  quantity: integer("quantity").notNull(),
  deliveryBatchId: integer("delivery_batch_id").references(() => deliveryBatches.id),
  occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdBy: integer("created_by").notNull().references(() => users.id),
});

export const inventoryTransfers = sqliteTable("inventory_transfers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  transferNo: text("transfer_no").notNull().unique(),
  fromWarehouseId: integer("from_warehouse_id").notNull().references(() => warehouses.id),
  toWarehouseId: integer("to_warehouse_id").notNull().references(() => warehouses.id),
  sku: text("sku").notNull(),
  quantity: integer("quantity").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull().default("pending_supply_chain"),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  shippedAt: text("shipped_at"),
  receivedAt: text("received_at"),
  ...timestamps,
});

export const qualityRules = sqliteTable("quality_rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  scope: text("scope", { enum: ["sku", "item_type"] }).notNull(),
  sku: text("sku"),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  stage: text("stage", { enum: ["incoming", "finished_goods"] }).notNull(),
  minimumPassRateBps: integer("minimum_pass_rate_bps").notNull(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  source: text("source", { enum: ["system_default", "manual"] }).notNull().default("manual"),
  createdBy: integer("created_by").references(() => users.id),
  ...timestamps,
});

export const qualityInspections = sqliteTable("quality_inspections", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  executionOrderId: integer("execution_order_id").notNull().references(() => executionOrders.id),
  stage: text("stage", { enum: ["incoming", "finished_goods"] }).notNull(),
  inspectionMethod: text("inspection_method", { enum: ["sampling", "full"] }).notNull(),
  batchQuantity: integer("batch_quantity").notNull(),
  inspectedQuantity: integer("inspected_quantity").notNull(),
  passedQuantity: integer("passed_quantity").notNull(),
  failedQuantity: integer("failed_quantity").notNull(),
  passRateBps: integer("pass_rate_bps").notNull(),
  qualityRuleId: integer("quality_rule_id").notNull().references(() => qualityRules.id),
  usedItemTypeFallback: integer("used_item_type_fallback", { mode: "boolean" }).notNull().default(false),
  skuRuleReminderStatus: text("sku_rule_reminder_status", { enum: ["not_needed", "pending", "completed"] }).notNull().default("not_needed"),
  defectReason: text("defect_reason").notNull().default(""),
  systemResult: text("system_result", { enum: ["passed", "failed"] }).notNull(),
  requestedResult: text("requested_result", { enum: ["passed", "failed"] }),
  requiresApproval: integer("requires_approval", { mode: "boolean" }).notNull().default(false),
  finalResult: text("final_result", { enum: ["passed", "failed", "pending_approval"] }).notNull(),
  quarantineTriggered: integer("quarantine_triggered", { mode: "boolean" }).notNull().default(false),
  fullInspectionRequired: integer("full_inspection_required", { mode: "boolean" }).notNull().default(false),
  sourceInspectionId: integer("source_inspection_id"),
  releasedQuantity: integer("released_quantity").notNull().default(0),
  dispositionStatus: text("disposition_status", { enum: ["not_needed", "pending", "completed"] }).notNull().default("not_needed"),
  inspectorType: text("inspector_type", { enum: ["supplier_qc", "company_qc"] }).notNull(),
  submittedBy: integer("submitted_by").notNull().references(() => users.id),
  ...timestamps,
});

export const defectCatalog = sqliteTable("defect_catalog", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  itemType: text("item_type", { enum: ["finished", "auxiliary", "component"] }),
  description: text("description").notNull().default(""),
  status: text("status", { enum: ["proposed", "active", "inactive", "rejected"] }).notNull().default("proposed"),
  proposedBy: integer("proposed_by").references(() => users.id),
  approvedBy: integer("approved_by").references(() => users.id),
  approvedAt: text("approved_at"),
  ...timestamps,
});

export const inspectionDefects = sqliteTable("inspection_defects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inspectionId: integer("inspection_id").notNull().references(() => qualityInspections.id),
  defectId: integer("defect_id").notNull().references(() => defectCatalog.id),
  quantity: integer("quantity").notNull(),
  note: text("note").notNull().default(""),
  ...timestamps,
}, table => [uniqueIndex("inspection_defect_unique").on(table.inspectionId, table.defectId)]);

export const defectImages = sqliteTable("defect_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inspectionDefectId: integer("inspection_defect_id").notNull().references(() => inspectionDefects.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const nonconformanceDispositions = sqliteTable("nonconformance_dispositions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inspectionId: integer("inspection_id").notNull().references(() => qualityInspections.id),
  type: text("type", { enum: ["rework", "return", "scrap", "concession"] }).notNull(),
  quantity: integer("quantity").notNull(),
  comment: text("comment").notNull().default(""),
  requiresSupplyChainApproval: integer("requires_supply_chain_approval", { mode: "boolean" }).notNull().default(false),
  status: text("status").notNull().default("factory_confirmation"),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  exceptionId: integer("exception_id").references(() => exceptions.id),
  ...timestamps,
});

export const inspectionImages = sqliteTable("inspection_images", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  inspectionId: integer("inspection_id").notNull().references(() => qualityInspections.id),
  fileKey: text("file_key").notNull(),
  fileName: text("file_name").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const userRoles = sqliteTable("user_roles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  roleCode: text("role_code").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  effectiveTo: text("effective_to"),
  status: text("status", { enum: ["pending", "active", "expired", "revoked"] }).notNull().default("pending"),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  ...timestamps,
});

export const invoiceVerifications = sqliteTable("invoice_verifications", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id").notNull().references(() => factoryInvoices.id),
  verifierRole: text("verifier_role", { enum: ["supply_chain", "finance"] }).notNull(),
  decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
  rejectionReason: text("rejection_reason"),
  verifiedBy: integer("verified_by").notNull().references(() => users.id),
  verifiedAt: text("verified_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, table => [uniqueIndex("invoice_role_verification_unique").on(table.invoiceId, table.verifierRole)]);

export const invoicePaymentAllocations = sqliteTable("invoice_payment_allocations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id").notNull().references(() => factoryInvoices.id),
  paymentRequestId: integer("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  allocatedAmountMinor: integer("allocated_amount_minor").notNull(),
  status: text("status", { enum: ["active", "frozen", "released"] }).notNull().default("active"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("invoice_payment_request_unique").on(table.invoiceId, table.paymentRequestId)]);

export const invoiceExceptions = sqliteTable("invoice_exceptions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceId: integer("invoice_id").notNull().references(() => factoryInvoices.id),
  exceptionType: text("exception_type", { enum: ["red_invoice", "voided"] }).notNull(),
  affectedAmountMinor: integer("affected_amount_minor").notNull(),
  replacementDeadline: text("replacement_deadline").notNull(),
  replacementCoveredAmountMinor: integer("replacement_covered_amount_minor").notNull().default(0),
  refundedAmountMinor: integer("refunded_amount_minor").notNull().default(0),
  status: text("status", { enum: ["awaiting_remediation", "risk_warning", "resolved"] }).notNull().default("awaiting_remediation"),
  reason: text("reason").notNull(),
  createdBy: integer("created_by").notNull().references(() => users.id),
  riskReleasedBy: integer("risk_released_by").references(() => users.id),
  riskReleasedAt: text("risk_released_at"),
  riskReleaseReason: text("risk_release_reason"),
  riskReleaseEvidenceFileKey: text("risk_release_evidence_file_key"),
  resolvedAt: text("resolved_at"),
  ...timestamps,
});

export const replacementInvoiceLinks = sqliteTable("replacement_invoice_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  invoiceExceptionId: integer("invoice_exception_id").notNull().references(() => invoiceExceptions.id),
  replacementInvoiceId: integer("replacement_invoice_id").notNull().references(() => factoryInvoices.id),
  coveredAmountMinor: integer("covered_amount_minor").notNull(),
  status: text("status", { enum: ["pending_verification", "verified", "rejected"] }).notNull().default("pending_verification"),
  ...timestamps,
}, table => [uniqueIndex("replacement_invoice_unique").on(table.invoiceExceptionId, table.replacementInvoiceId)]);

export const paymentRecords = sqliteTable("payment_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  paymentRequestId: integer("payment_request_id").notNull().references(() => factoryPaymentRequests.id),
  amountMinor: integer("amount_minor").notNull(),
  paidAt: text("paid_at").notNull(),
  bankReference: text("bank_reference").notNull(),
  recordType: text("record_type", { enum: ["payment", "reversal", "correction", "refund"] }).notNull().default("payment"),
  reversesPaymentRecordId: integer("reverses_payment_record_id"),
  invoiceExceptionId: integer("invoice_exception_id").references(() => invoiceExceptions.id),
  recordedBy: integer("recorded_by").notNull().references(() => users.id),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewStatus: text("review_status", { enum: ["not_required", "pending", "approved", "rejected"] }).notNull().default("not_required"),
  ...timestamps,
});

export const auditLogs = sqliteTable("audit_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  actorUserId: integer("actor_user_id").references(() => users.id),
  action: text("action").notNull(),
  module: text("module").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  businessNo: text("business_no"),
  beforeJson: text("before_json"),
  afterJson: text("after_json"),
  ipAddress: text("ip_address"),
  deviceId: text("device_id"),
  sensitiveView: integer("sensitive_view", { mode: "boolean" }).notNull().default(false),
  exported: integer("exported", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  archiveAfter: text("archive_after").notNull(),
});

export const supplierPerformanceWeightVersions = sqliteTable("supplier_performance_weight_versions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tier: integer("tier").notNull(),
  effectiveFrom: text("effective_from").notNull(),
  deliveryWeightBps: integer("delivery_weight_bps").notNull(),
  qualityWeightBps: integer("quality_weight_bps").notNull(),
  exceptionWeightBps: integer("exception_weight_bps").notNull(),
  preparationWeightBps: integer("preparation_weight_bps").notNull(),
  satisfactionWeightBps: integer("satisfaction_weight_bps").notNull().default(0),
  samplingWeightBps: integer("sampling_weight_bps").notNull(),
  status: text("status", { enum: ["active", "inactive"] }).notNull().default("active"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("supplier_performance_weight_tier_date_unique").on(table.tier, table.effectiveFrom)]);

export const supplierPerformanceReviews = sqliteTable("supplier_performance_reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  supplierId: integer("supplier_id").notNull().references(() => suppliers.id),
  quarter: text("quarter").notNull(),
  reviewType: text("review_type", { enum: ["satisfaction", "sampling"] }).notNull(),
  score: integer("score").notNull(),
  tagsJson: text("tags_json").notNull().default("[]"),
  comment: text("comment").notNull().default(""),
  evaluatorUserId: integer("evaluator_user_id").notNull().references(() => users.id),
  ...timestamps,
}, table => [uniqueIndex("supplier_performance_review_unique").on(table.supplierId, table.quarter, table.reviewType, table.evaluatorUserId)]);

export const approvalRequests = sqliteTable("approval_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  requestNo: text("request_no").notNull().unique(),
  workflowType: text("workflow_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  summary: text("summary").notNull(),
  payloadJson: text("payload_json").notNull(),
  highRisk: integer("high_risk", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["pending", "approved", "rejected", "cancelled"] }).notNull().default("pending"),
  requestedBy: integer("requested_by").notNull().references(() => users.id),
  requestedAt: text("requested_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  reviewedBy: integer("reviewed_by").references(() => users.id),
  reviewedAt: text("reviewed_at"),
  reviewComment: text("review_comment"),
  smsVerifiedAt: text("sms_verified_at"),
  ...timestamps,
});

export const aiConversations = sqliteTable("ai_conversations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  title: text("title").notNull(),
  status: text("status", { enum: ["active", "closed"] }).notNull().default("active"),
  retainUntil: text("retain_until").notNull(),
  ...timestamps,
});

export const aiMessages = sqliteTable("ai_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => aiConversations.id),
  role: text("role", { enum: ["user", "assistant"] }).notNull(),
  content: text("content").notNull(),
  citationJson: text("citation_json"),
  confidenceStatus: text("confidence_status", { enum: ["confirmed", "unable_to_confirm", "conflict"] }).notNull().default("confirmed"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const aiOperationDrafts = sqliteTable("ai_operation_drafts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  conversationId: integer("conversation_id").notNull().references(() => aiConversations.id),
  operationType: text("operation_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  highRisk: integer("high_risk", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["draft", "confirmed", "submitted", "cancelled"] }).notNull().default("draft"),
  confirmedBy: integer("confirmed_by").references(() => users.id),
  confirmedAt: text("confirmed_at"),
  ...timestamps,
});

export const fileObjects = sqliteTable("file_objects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  objectKey: text("object_key").notNull().unique(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  category: text("category").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  ownerUserId: integer("owner_user_id").notNull().references(() => users.id),
  factoryId: integer("factory_id").references(() => factories.id),
  supplierId: integer("supplier_id").references(() => suppliers.id),
  sensitive: integer("sensitive", { mode: "boolean" }).notNull().default(false),
  retainUntil: text("retain_until"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const importBatches = sqliteTable("import_batches", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importNo: text("import_no").notNull().unique(),
  type: text("type").notNull(),
  fileObjectId: integer("file_object_id").references(() => fileObjects.id),
  fileName: text("file_name").notNull(),
  fingerprint: text("fingerprint").notNull(),
  businessKey: text("business_key"),
  status: text("status", { enum: ["preview", "blocked", "awaiting_mapping", "awaiting_duplicate_confirmation", "committed", "cancelled"] }).notNull().default("preview"),
  totalRows: integer("total_rows").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  errorCount: integer("error_count").notNull().default(0),
  warningCount: integer("warning_count").notNull().default(0),
  duplicateOfBatchId: integer("duplicate_of_batch_id"),
  committedBy: integer("committed_by").references(() => users.id),
  committedAt: text("committed_at"),
  createdBy: integer("created_by").notNull().references(() => users.id),
  ...timestamps,
});

export const importStagingRows = sqliteTable("import_staging_rows", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  importBatchId: integer("import_batch_id").notNull().references(() => importBatches.id),
  sheetName: text("sheet_name").notNull(),
  sourceRowNo: integer("source_row_no").notNull(),
  businessKey: text("business_key"),
  normalizedJson: text("normalized_json").notNull(),
  rawJson: text("raw_json").notNull(),
  validationStatus: text("validation_status", { enum: ["valid", "warning", "error"] }).notNull(),
  validationMessagesJson: text("validation_messages_json").notNull().default("[]"),
  mappingConfirmed: integer("mapping_confirmed", { mode: "boolean" }).notNull().default(false),
});

export const reminderSchedules = sqliteTable("reminder_schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  reminderType: text("reminder_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  businessNo: text("business_no"),
  dueAt: text("due_at").notNull(),
  nextRunAt: text("next_run_at").notNull(),
  recurrence: text("recurrence", { enum: ["once", "daily_overdue", "milestones"] }).notNull(),
  milestoneDaysJson: text("milestone_days_json").notNull().default("[]"),
  recipientRoleJson: text("recipient_role_json").notNull(),
  recipientUserIdsJson: text("recipient_user_ids_json").notNull().default("[]"),
  channelsJson: text("channels_json").notNull().default("[\"in_app\",\"email\"]"),
  severity: text("severity", { enum: ["normal", "yellow", "red", "approval"] }).notNull().default("normal"),
  quietHoursBypass: integer("quiet_hours_bypass", { mode: "boolean" }).notNull().default(false),
  status: text("status", { enum: ["active", "completed", "cancelled"] }).notNull().default("active"),
  lastRunAt: text("last_run_at"),
  ...timestamps,
});

export const notificationMessages = sqliteTable("notification_messages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  recipientUserId: integer("recipient_user_id").references(() => users.id),
  recipientRole: text("recipient_role"),
  recipientFactoryId: integer("recipient_factory_id").references(() => factories.id),
  recipientSupplierId: integer("recipient_supplier_id").references(() => suppliers.id),
  channel: text("channel", { enum: ["in_app", "email"] }).notNull(),
  type: text("type").notNull(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  businessNo: text("business_no"),
  status: text("status", { enum: ["queued", "sent", "failed", "read"] }).notNull().default("queued"),
  sentAt: text("sent_at"),
  readAt: text("read_at"),
  errorMessage: text("error_message"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const authCredentials = sqliteTable("auth_credentials", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().unique().references(() => users.id),
  passwordHash: text("password_hash").notNull(),
  passwordSalt: text("password_salt").notNull(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedAt: text("locked_at"),
  passwordChangedAt: text("password_changed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...timestamps,
});

export const authChallenges = sqliteTable("auth_challenges", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  challengeNo: text("challenge_no").notNull().unique(),
  userId: integer("user_id").notNull().references(() => users.id),
  purpose: text("purpose", { enum: ["login", "high_risk", "phone_change"] }).notNull(),
  codeHash: text("code_hash").notNull(),
  deviceId: text("device_id").notNull(),
  ipAddress: text("ip_address"),
  region: text("region"),
  expiresAt: text("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
  verifiedAt: text("verified_at"),
  ...timestamps,
});

export const trustedDevices = sqliteTable("trusted_devices", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  deviceId: text("device_id").notNull(),
  deviceName: text("device_name").notNull().default(""),
  lastIpAddress: text("last_ip_address"),
  lastRegion: text("last_region"),
  trustedUntil: text("trusted_until").notNull(),
  revokedAt: text("revoked_at"),
  lastUsedAt: text("last_used_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  ...timestamps,
}, table => [uniqueIndex("trusted_user_device_unique").on(table.userId, table.deviceId)]);

export const authSessions = sqliteTable("auth_sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: integer("user_id").notNull().references(() => users.id),
  tokenHash: text("token_hash").notNull().unique(),
  deviceId: text("device_id").notNull(),
  ipAddress: text("ip_address"),
  region: text("region"),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: text("last_seen_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
