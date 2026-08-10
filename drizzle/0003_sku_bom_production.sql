CREATE TABLE `skus` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `code` text NOT NULL,
  `name` text NOT NULL,
  `item_type` text,
  `stock_unit` text,
  `serial_tracking_enabled` integer NOT NULL DEFAULT 0,
  `overproduction_tolerance_bps` integer NOT NULL DEFAULT 0,
  `purchase_over_tolerance_bps` integer NOT NULL DEFAULT 0,
  `purchase_under_tolerance_bps` integer NOT NULL DEFAULT 0,
  `verification_status` text NOT NULL DEFAULT 'pending',
  `status` text NOT NULL DEFAULT 'draft',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `skus_code_unique` ON `skus` (`code`);

CREATE TABLE `sku_unit_conversions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `sku_id` integer NOT NULL REFERENCES `skus`(`id`),
  `purchase_unit` text NOT NULL,
  `stock_unit` text NOT NULL,
  `purchase_unit_quantity` integer NOT NULL,
  `stock_unit_quantity` integer NOT NULL,
  `effective_from` text NOT NULL,
  `status` text NOT NULL DEFAULT 'active',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `sku_purchase_unit_unique` ON `sku_unit_conversions` (`sku_id`,`purchase_unit`,`effective_from`);

ALTER TABLE `product_boms` ADD `effective_to` text;
ALTER TABLE `product_boms` ADD `overlap_allowed` integer NOT NULL DEFAULT 0;
ALTER TABLE `product_boms` ADD `overlap_reason` text NOT NULL DEFAULT '';
ALTER TABLE `product_boms` ADD `approval_status` text NOT NULL DEFAULT 'draft';
ALTER TABLE `product_boms` ADD `reviewed_by` integer REFERENCES `users`(`id`);
ALTER TABLE `product_boms` ADD `reviewed_at` text;

ALTER TABLE `bom_components` ADD `issue_tolerance_bps` integer NOT NULL DEFAULT 0;
ALTER TABLE `bom_components` ADD `consumption_tolerance_bps` integer NOT NULL DEFAULT 0;
ALTER TABLE `bom_components` ADD `loss_tolerance_bps` integer NOT NULL DEFAULT 0;

ALTER TABLE `execution_orders` ADD `planned_start_date` text;
ALTER TABLE `execution_orders` ADD `planned_finish_date` text;
ALTER TABLE `execution_orders` ADD `actual_start_at` text;
ALTER TABLE `execution_orders` ADD `actual_finish_at` text;

CREATE TABLE `production_material_lines` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_order_id` integer NOT NULL REFERENCES `execution_orders`(`id`),
  `bom_component_id` integer NOT NULL REFERENCES `bom_components`(`id`),
  `theoretical_quantity` integer NOT NULL,
  `reserved_quantity` integer NOT NULL DEFAULT 0,
  `issued_quantity` integer NOT NULL DEFAULT 0,
  `consumed_quantity` integer NOT NULL DEFAULT 0,
  `loss_quantity` integer NOT NULL DEFAULT 0,
  `deviation_status` text NOT NULL DEFAULT 'within_tolerance',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `production_reports` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `execution_order_id` integer NOT NULL REFERENCES `execution_orders`(`id`),
  `actual_finished_quantity` integer NOT NULL,
  `variance_quantity` integer NOT NULL,
  `variance_rate_bps` integer NOT NULL,
  `result` text NOT NULL,
  `company_inventory_quantity` integer NOT NULL DEFAULT 0,
  `factory_owned_quantity` integer NOT NULL DEFAULT 0,
  `reported_by` integer NOT NULL REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
