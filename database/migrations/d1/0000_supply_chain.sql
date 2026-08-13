CREATE TABLE `factories` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `name` text NOT NULL,
  `code` text NOT NULL UNIQUE,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `suppliers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `tier` integer NOT NULL,
  `supplier_type` text,
  `managed_by_factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `unified_social_credit_code` text DEFAULT '' NOT NULL,
  `business_license_file_key` text,
  `address` text DEFAULT '' NOT NULL,
  `contact_name` text DEFAULT '' NOT NULL,
  `contact_phone` text DEFAULT '' NOT NULL,
  `business_scope` text DEFAULT '' NOT NULL,
  `supply_risk` text DEFAULT 'low' NOT NULL,
  `risk_reason` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `users` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `email` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `role` text NOT NULL,
  `factory_id` integer REFERENCES `factories`(`id`),
  `supplier_id` integer REFERENCES `suppliers`(`id`),
  `organization_name` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `purchase_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_no` text NOT NULL UNIQUE,
  `source` text DEFAULT 'lingxing_excel' NOT NULL,
  `source_file_key` text,
  `status` text DEFAULT 'draft' NOT NULL,
  `order_date` text,
  `total_tax_included_minor` integer DEFAULT 0 NOT NULL,
  `payment_term_id` integer,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `purchase_imports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `file_key` text NOT NULL,
  `file_name` text NOT NULL,
  `detected_order_no` text,
  `matched_purchase_order_id` integer REFERENCES `purchase_orders`(`id`),
  `is_possible_duplicate` integer DEFAULT false NOT NULL,
  `status` text DEFAULT 'analyzing' NOT NULL,
  `imported_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `purchase_import_diffs` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_import_id` integer NOT NULL REFERENCES `purchase_imports`(`id`),
  `sheet_name` text NOT NULL,
  `row_key` text NOT NULL,
  `field_name` text NOT NULL,
  `old_value` text,
  `new_value` text,
  `change_type` text NOT NULL
);
CREATE TABLE `order_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_order_id` integer NOT NULL REFERENCES `purchase_orders`(`id`),
  `sku` text NOT NULL,
  `product_name` text NOT NULL,
  `item_type` text NOT NULL,
  `supplier_id` integer REFERENCES `suppliers`(`id`),
  `quantity` integer NOT NULL,
  `unit_price_tax_included_minor` integer DEFAULT 0 NOT NULL,
  `amount_tax_included_minor` integer DEFAULT 0 NOT NULL,
  `due_date` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `order_item_unique` ON `order_items` (`purchase_order_id`,`sku`,`supplier_id`);
CREATE TABLE `supplier_skus` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `sku` text NOT NULL,
  `is_primary` integer DEFAULT false NOT NULL,
  `lead_time_days` integer,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `supplier_sku_unique` ON `supplier_skus` (`supplier_id`,`sku`);
CREATE TABLE `core_price_agreements` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `sku` text NOT NULL,
  `currency` text DEFAULT 'CNY' NOT NULL,
  `unit_price_tax_included_minor` integer NOT NULL,
  `unit_price_tax_excluded_minor` integer NOT NULL,
  `tax_rate_bps` integer NOT NULL,
  `effective_from` text NOT NULL,
  `effective_to` text,
  `status` text DEFAULT 'active' NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `core_price_change_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `current_agreement_id` integer REFERENCES `core_price_agreements`(`id`),
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `sku` text NOT NULL,
  `proposed_tax_included_minor` integer NOT NULL,
  `proposed_tax_excluded_minor` integer NOT NULL,
  `proposed_tax_rate_bps` integer NOT NULL,
  `proposed_effective_from` text NOT NULL,
  `reason` text NOT NULL,
  `requested_by` integer NOT NULL REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `decision` text DEFAULT 'pending' NOT NULL,
  `review_comment` text,
  `reviewed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TRIGGER `prevent_self_review_price_change`
BEFORE UPDATE OF `decision` ON `core_price_change_requests`
WHEN NEW.`decision` IN ('approved', 'rejected')
  AND (NEW.`reviewed_by` IS NULL OR NEW.`reviewed_by` = NEW.`requested_by`)
BEGIN
  SELECT RAISE(ABORT, 'price change requires a different reviewer');
END;
CREATE TABLE `factory_supplier_delivery_settings` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `component_sku` text NOT NULL,
  `arrival_buffer_days` integer NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `factory_supplier_sku_buffer_unique` ON `factory_supplier_delivery_settings` (`factory_id`,`supplier_id`,`component_sku`);
CREATE TABLE `delivery_setting_changes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `setting_id` integer NOT NULL REFERENCES `factory_supplier_delivery_settings`(`id`),
  `old_days` integer NOT NULL,
  `new_days` integer NOT NULL,
  `reason` text NOT NULL,
  `changed_by` integer NOT NULL REFERENCES `users`(`id`),
  `supply_chain_notified_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `product_boms` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `finished_sku` text NOT NULL,
  `version` text NOT NULL,
  `effective_from` text NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `created_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `product_bom_version_unique` ON `product_boms` (`finished_sku`,`version`);
CREATE TABLE `bom_components` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `bom_id` integer NOT NULL REFERENCES `product_boms`(`id`),
  `component_sku` text NOT NULL,
  `item_type` text NOT NULL,
  `is_core` integer DEFAULT false NOT NULL,
  `quantity_per_finished` integer NOT NULL
);
CREATE UNIQUE INDEX `bom_component_unique` ON `bom_components` (`bom_id`,`component_sku`);
CREATE TABLE `sku_factory_defaults` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sku` text NOT NULL UNIQUE,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `selected_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `factory_change_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sku` text NOT NULL,
  `from_factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `to_factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `reason` text NOT NULL,
  `requested_by` integer NOT NULL REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `decision` text DEFAULT 'pending' NOT NULL,
  `review_comment` text,
  `reviewed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TRIGGER `prevent_self_review_factory_change`
BEFORE UPDATE OF `decision` ON `factory_change_requests`
WHEN NEW.`decision` IN ('approved', 'rejected')
  AND (NEW.`reviewed_by` IS NULL OR NEW.`reviewed_by` = NEW.`requested_by`)
BEGIN
  SELECT RAISE(ABORT, 'factory change requires a different reviewer');
END;
CREATE TABLE `execution_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_no` text NOT NULL UNIQUE,
  `order_item_id` integer NOT NULL REFERENCES `order_items`(`id`),
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `bom_id` integer REFERENCES `product_boms`(`id`),
  `planned_quantity` integer NOT NULL,
  `completed_quantity` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'factory_confirmation' NOT NULL,
  `due_date` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `core_supplier_orders` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `order_no` text NOT NULL UNIQUE,
  `source_purchase_order_id` integer NOT NULL REFERENCES `purchase_orders`(`id`),
  `assembly_factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `supplier_id` integer NOT NULL REFERENCES `suppliers`(`id`),
  `planned_ship_date` text NOT NULL,
  `status` text DEFAULT 'awaiting_confirmation' NOT NULL,
  `confirmed_by` integer REFERENCES `users`(`id`),
  `confirmed_at` text,
  `inability_reason` text,
  `proposed_ship_date` text,
  `alert_status` text DEFAULT 'none' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `core_supplier_order_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `core_supplier_order_id` integer NOT NULL REFERENCES `core_supplier_orders`(`id`),
  `component_sku` text NOT NULL,
  `quantity` integer NOT NULL,
  `price_agreement_id` integer NOT NULL REFERENCES `core_price_agreements`(`id`),
  `currency` text NOT NULL,
  `unit_price_tax_included_minor` integer NOT NULL,
  `unit_price_tax_excluded_minor` integer NOT NULL,
  `tax_rate_bps` integer NOT NULL,
  `amount_tax_included_minor` integer NOT NULL,
  `amount_tax_excluded_minor` integer NOT NULL
);
CREATE UNIQUE INDEX `core_supplier_order_item_unique` ON `core_supplier_order_items` (`core_supplier_order_id`,`component_sku`);
CREATE TABLE `factory_payment_terms` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `name` text NOT NULL,
  `mode` text NOT NULL,
  `days_after_shipment` integer,
  `cutoff_day` integer,
  `settlement_month_offset` integer,
  `payment_day` integer,
  `invoice_required` integer DEFAULT true NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `factory_payment_schedules` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_order_id` integer NOT NULL REFERENCES `purchase_orders`(`id`),
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `delivery_batch_id` integer NOT NULL REFERENCES `delivery_batches`(`id`),
  `payment_type` text NOT NULL,
  `rate_bps` integer,
  `shipped_quantity` integer NOT NULL,
  `unit_price_minor` integer NOT NULL,
  `amount_minor` integer NOT NULL,
  `payment_term_id` integer NOT NULL REFERENCES `factory_payment_terms`(`id`),
  `payment_rule_snapshot` text NOT NULL,
  `planned_payment_date` text NOT NULL,
  `trigger_event` text DEFAULT 'actual_shipment' NOT NULL,
  `status` text DEFAULT 'planned' NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `factory_payment_requests` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `request_no` text NOT NULL UNIQUE,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `actual_shipment_date` text NOT NULL,
  `planned_payment_date` text NOT NULL,
  `total_amount_minor` integer NOT NULL,
  `auto_generated` integer DEFAULT true NOT NULL,
  `status` text DEFAULT 'waiting_invoice' NOT NULL,
  `invoice_covered_amount_minor` integer DEFAULT 0 NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `submitted_to_finance_at` text,
  `supply_chain_notified_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `finance_notified_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `paid_at` text,
  `payment_reference` text,
  `payment_note` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `factory_payment_request_group_unique` ON `factory_payment_requests` (`factory_id`,`planned_payment_date`);
CREATE TABLE `factory_payment_request_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `payment_request_id` integer NOT NULL REFERENCES `factory_payment_requests`(`id`),
  `payment_schedule_id` integer NOT NULL REFERENCES `factory_payment_schedules`(`id`),
  `purchase_order_id` integer NOT NULL REFERENCES `purchase_orders`(`id`),
  `triggered_by_delivery_batch_id` integer NOT NULL REFERENCES `delivery_batches`(`id`),
  `amount_minor` integer NOT NULL
);
CREATE UNIQUE INDEX `payment_request_schedule_unique` ON `factory_payment_request_items` (`payment_request_id`,`payment_schedule_id`);
CREATE TABLE `factory_invoices` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `purchase_order_id` integer NOT NULL REFERENCES `purchase_orders`(`id`),
  `coverage_mode` text NOT NULL,
  `delivery_batch_id` integer REFERENCES `delivery_batches`(`id`),
  `invoice_no` text NOT NULL UNIQUE,
  `invoice_type` text NOT NULL,
  `amount_tax_included_minor` integer NOT NULL,
  `tax_amount_minor` integer NOT NULL,
  `issued_at` text NOT NULL,
  `received_at` text,
  `file_key` text,
  `status` text DEFAULT 'pending' NOT NULL,
  `expected_amount_minor` integer NOT NULL,
  `amount_matches_expected` integer DEFAULT false NOT NULL,
  `mismatch_amount_minor` integer DEFAULT 0 NOT NULL,
  `maintained_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `factory_invoice_full_order_unique`
ON `factory_invoices` (`purchase_order_id`)
WHERE `coverage_mode` = 'full_order';
CREATE UNIQUE INDEX `factory_invoice_delivery_batch_unique`
ON `factory_invoices` (`delivery_batch_id`)
WHERE `coverage_mode` = 'delivery_batch';
CREATE TRIGGER `prevent_invoice_amount_mismatch`
BEFORE UPDATE OF `status` ON `factory_invoices`
WHEN NEW.`status` = 'verified'
  AND NEW.`amount_tax_included_minor` <> NEW.`expected_amount_minor`
BEGIN
  SELECT RAISE(ABORT, 'invoice amount must match expected order or delivery batch amount');
END;
CREATE TABLE `notifications` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `recipient_role` text NOT NULL,
  `type` text NOT NULL,
  `title` text NOT NULL,
  `message` text NOT NULL,
  `entity_type` text NOT NULL,
  `entity_id` integer NOT NULL,
  `read_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `core_order_reschedules` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `core_supplier_order_id` integer NOT NULL REFERENCES `core_supplier_orders`(`id`),
  `previous_ship_date` text NOT NULL,
  `proposed_ship_date` text NOT NULL,
  `supplier_reason` text NOT NULL,
  `factory_decision` text DEFAULT 'pending' NOT NULL,
  `factory_confirmed_by` integer REFERENCES `users`(`id`),
  `factory_confirmed_at` text,
  `supply_chain_decision` text DEFAULT 'pending' NOT NULL,
  `supply_chain_reviewed_by` integer REFERENCES `users`(`id`),
  `supply_chain_reviewed_at` text,
  `review_comment` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `delivery_batches` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_order_id` integer NOT NULL REFERENCES `execution_orders`(`id`),
  `batch_no` text NOT NULL,
  `quantity` integer NOT NULL,
  `planned_ship_at` text NOT NULL,
  `shipped_at` text,
  `carrier` text NOT NULL,
  `logistics_no` text NOT NULL,
  `destination` text NOT NULL,
  `requires_approval` integer DEFAULT false NOT NULL,
  `deviation_reason` text,
  `status` text DEFAULT 'planned' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `delivery_batch_unique` ON `delivery_batches` (`execution_order_id`,`batch_no`);
CREATE TABLE `shipment_evidence` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `delivery_batch_id` integer NOT NULL REFERENCES `delivery_batches`(`id`),
  `file_key` text NOT NULL,
  `file_name` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `exceptions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_order_id` integer REFERENCES `execution_orders`(`id`),
  `factory_id` integer REFERENCES `factories`(`id`),
  `type` text NOT NULL,
  `description` text NOT NULL,
  `evidence_file_key` text,
  `status` text DEFAULT 'pending_supply_chain' NOT NULL,
  `submitted_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `approvals` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `exception_id` integer NOT NULL REFERENCES `exceptions`(`id`),
  `decision` text NOT NULL,
  `comment` text DEFAULT '' NOT NULL,
  `approved_by` integer NOT NULL REFERENCES `users`(`id`),
  `approved_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `warehouses` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `type` text NOT NULL,
  `factory_id` integer REFERENCES `factories`(`id`),
  `address` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `inventory` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `item_type` text NOT NULL,
  `available_quantity` integer DEFAULT 0 NOT NULL,
  `locked_quantity` integer DEFAULT 0 NOT NULL,
  `quarantined_quantity` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `inventory_warehouse_sku_unique` ON `inventory` (`warehouse_id`,`sku`);
CREATE TABLE `inventory_movements` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `type` text NOT NULL,
  `quantity` integer NOT NULL,
  `delivery_batch_id` integer REFERENCES `delivery_batches`(`id`),
  `occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `created_by` integer NOT NULL REFERENCES `users`(`id`)
);
CREATE TABLE `inventory_transfers` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `transfer_no` text NOT NULL UNIQUE,
  `from_warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `to_warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `quantity` integer NOT NULL,
  `reason` text NOT NULL,
  `status` text DEFAULT 'pending_supply_chain' NOT NULL,
  `requested_by` integer NOT NULL REFERENCES `users`(`id`),
  `approved_by` integer REFERENCES `users`(`id`),
  `approved_at` text,
  `shipped_at` text,
  `received_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `quality_rules` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `scope` text NOT NULL,
  `sku` text,
  `item_type` text,
  `stage` text NOT NULL,
  `minimum_pass_rate_bps` integer NOT NULL,
  `active` integer DEFAULT true NOT NULL,
  `source` text DEFAULT 'manual' NOT NULL,
  `created_by` integer REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `quality_inspections` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_order_id` integer NOT NULL REFERENCES `execution_orders`(`id`),
  `stage` text NOT NULL,
  `inspection_method` text NOT NULL,
  `batch_quantity` integer NOT NULL,
  `inspected_quantity` integer NOT NULL,
  `passed_quantity` integer NOT NULL,
  `failed_quantity` integer NOT NULL,
  `pass_rate_bps` integer NOT NULL,
  `quality_rule_id` integer NOT NULL REFERENCES `quality_rules`(`id`),
  `used_item_type_fallback` integer DEFAULT false NOT NULL,
  `sku_rule_reminder_status` text DEFAULT 'not_needed' NOT NULL,
  `defect_reason` text DEFAULT '' NOT NULL,
  `system_result` text NOT NULL,
  `requested_result` text,
  `requires_approval` integer DEFAULT false NOT NULL,
  `final_result` text NOT NULL,
  `quarantine_triggered` integer DEFAULT false NOT NULL,
  `full_inspection_required` integer DEFAULT false NOT NULL,
  `source_inspection_id` integer,
  `released_quantity` integer DEFAULT 0 NOT NULL,
  `disposition_status` text DEFAULT 'not_needed' NOT NULL,
  `inspector_type` text NOT NULL,
  `submitted_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `defect_catalog` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL UNIQUE,
  `name` text NOT NULL,
  `item_type` text,
  `description` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'proposed' NOT NULL,
  `proposed_by` integer REFERENCES `users`(`id`),
  `approved_by` integer REFERENCES `users`(`id`),
  `approved_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `inspection_defects` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `inspection_id` integer NOT NULL REFERENCES `quality_inspections`(`id`),
  `defect_id` integer NOT NULL REFERENCES `defect_catalog`(`id`),
  `quantity` integer NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE UNIQUE INDEX `inspection_defect_unique` ON `inspection_defects` (`inspection_id`,`defect_id`);
CREATE TABLE `defect_images` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `inspection_defect_id` integer NOT NULL REFERENCES `inspection_defects`(`id`),
  `file_key` text NOT NULL,
  `file_name` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE `nonconformance_dispositions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `inspection_id` integer NOT NULL REFERENCES `quality_inspections`(`id`),
  `type` text NOT NULL,
  `quantity` integer NOT NULL,
  `comment` text DEFAULT '' NOT NULL,
  `requires_supply_chain_approval` integer DEFAULT false NOT NULL,
  `status` text DEFAULT 'factory_confirmation' NOT NULL,
  `confirmed_by` integer REFERENCES `users`(`id`),
  `exception_id` integer REFERENCES `exceptions`(`id`),
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TRIGGER `validate_disposition_completion`
BEFORE UPDATE OF `disposition_status` ON `quality_inspections`
WHEN NEW.`disposition_status` = 'completed'
  AND (
    SELECT COALESCE(SUM(`quantity`), 0)
    FROM `nonconformance_dispositions`
    WHERE `inspection_id` = NEW.`id`
  ) <> NEW.`failed_quantity`
BEGIN
  SELECT RAISE(ABORT, 'disposition quantities must equal failed quantity');
END;
CREATE TABLE `inspection_images` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `inspection_id` integer NOT NULL REFERENCES `quality_inspections`(`id`),
  `file_key` text NOT NULL,
  `file_name` text NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO `quality_rules`
  (`scope`, `sku`, `item_type`, `stage`, `minimum_pass_rate_bps`, `active`, `source`)
VALUES
  ('item_type', NULL, 'auxiliary', 'incoming', 9500, true, 'system_default'),
  ('item_type', NULL, 'component', 'incoming', 9500, true, 'system_default'),
  ('item_type', NULL, 'finished', 'finished_goods', 9500, true, 'system_default');
