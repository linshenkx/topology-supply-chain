CREATE TABLE `shipment_receipts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `delivery_batch_id` integer NOT NULL REFERENCES `delivery_batches`(`id`),
  `received_quantity` integer NOT NULL,
  `damaged_quantity` integer NOT NULL DEFAULT 0,
  `received_at` text NOT NULL,
  `evidence_file_key` text NOT NULL,
  `exception_reason` text NOT NULL DEFAULT '',
  `received_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `product_returns` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `return_no` text NOT NULL,
  `source_delivery_batch_id` integer NOT NULL REFERENCES `delivery_batches`(`id`),
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `quantity` integer NOT NULL,
  `batch_id` integer REFERENCES `inventory_batches`(`id`),
  `status` text NOT NULL,
  `proposed_disposition` text,
  `proposed_by` integer REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `product_returns_return_no_unique` ON `product_returns` (`return_no`);

CREATE TABLE `supply_risk_cases` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `risk_no` text NOT NULL,
  `assembly_factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `source_supplier_id` integer REFERENCES `suppliers`(`id`),
  `source_tier` integer NOT NULL,
  `affected_entity_type` text NOT NULL,
  `affected_entity_id` integer NOT NULL,
  `trigger_type` text NOT NULL,
  `impact_summary` text NOT NULL,
  `response_due_at` text NOT NULL,
  `factory_plan` text,
  `proposed_delivery_date` text,
  `status` text NOT NULL DEFAULT 'open',
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `supply_risk_cases_risk_no_unique` ON `supply_risk_cases` (`risk_no`);
