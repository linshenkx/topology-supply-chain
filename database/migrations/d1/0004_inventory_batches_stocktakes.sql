CREATE TABLE `inventory_batches` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `batch_no` text NOT NULL,
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `production_date` text,
  `inbound_date` text NOT NULL,
  `expiry_date` text,
  `production_date_estimated` integer NOT NULL DEFAULT 0,
  `expiry_date_estimated` integer NOT NULL DEFAULT 0,
  `available_quantity` integer NOT NULL DEFAULT 0,
  `locked_quantity` integer NOT NULL DEFAULT 0,
  `defective_quantity` integer NOT NULL DEFAULT 0,
  `pending_inspection_quantity` integer NOT NULL DEFAULT 0,
  `quarantine_quantity` integer NOT NULL DEFAULT 0,
  `ownership` text NOT NULL DEFAULT 'company',
  `expiry_status` text NOT NULL DEFAULT 'normal',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `inventory_batches_batch_no_unique` ON `inventory_batches` (`batch_no`);
CREATE UNIQUE INDEX `inventory_batch_warehouse_unique` ON `inventory_batches` (`warehouse_id`,`batch_no`);

CREATE TABLE `inventory_reservations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `batch_id` integer NOT NULL REFERENCES `inventory_batches`(`id`),
  `entity_type` text NOT NULL,
  `entity_id` integer,
  `requested_quantity` integer NOT NULL,
  `reserved_quantity` integer NOT NULL,
  `shortage_quantity` integer NOT NULL DEFAULT 0,
  `priority` integer NOT NULL DEFAULT 0,
  `status` text NOT NULL DEFAULT 'active',
  `created_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE `stocktakes` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `stocktake_no` text NOT NULL,
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `scope` text NOT NULL,
  `due_date` text NOT NULL,
  `status` text NOT NULL DEFAULT 'draft',
  `frozen_at` text,
  `created_by` integer NOT NULL REFERENCES `users`(`id`),
  `assigned_factory_id` integer REFERENCES `factories`(`id`),
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `stocktakes_stocktake_no_unique` ON `stocktakes` (`stocktake_no`);

CREATE TABLE `stocktake_counts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `stocktake_id` integer NOT NULL REFERENCES `stocktakes`(`id`),
  `batch_id` integer REFERENCES `inventory_batches`(`id`),
  `sku` text NOT NULL,
  `count_round` integer NOT NULL,
  `available_quantity` integer NOT NULL,
  `locked_quantity` integer NOT NULL,
  `defective_quantity` integer NOT NULL,
  `pending_inspection_quantity` integer NOT NULL,
  `total_quantity` integer NOT NULL,
  `counted_by` integer NOT NULL REFERENCES `users`(`id`),
  `counted_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `stocktake_count_round_unique` ON `stocktake_counts` (`stocktake_id`,`sku`,`batch_id`,`count_round`);

CREATE TABLE `stocktake_adjustments` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `stocktake_id` integer NOT NULL REFERENCES `stocktakes`(`id`),
  `stocktake_count_id` integer NOT NULL REFERENCES `stocktake_counts`(`id`),
  `variance_quantity` integer NOT NULL,
  `generated_batch_no` text,
  `estimated_production_date` text,
  `estimated_expiry_date` text,
  `decision` text NOT NULL DEFAULT 'pending',
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
