CREATE TABLE `purchase_plans` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `plan_no` text NOT NULL,
  `version` integer NOT NULL DEFAULT 1,
  `source` text NOT NULL DEFAULT 'lingxing_excel',
  `source_file_key` text,
  `status` text NOT NULL DEFAULT 'draft',
  `confirmation_due_at` text,
  `confirmed_at` text,
  `created_by` integer NOT NULL REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `purchase_plan_version_unique` ON `purchase_plans` (`plan_no`,`version`);

CREATE TABLE `purchase_plan_items` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_plan_id` integer NOT NULL REFERENCES `purchase_plans`(`id`),
  `expected_arrival_date` text NOT NULL,
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `warehouse_id` integer NOT NULL REFERENCES `warehouses`(`id`),
  `sku` text NOT NULL,
  `product_name` text NOT NULL,
  `bom_id` integer NOT NULL REFERENCES `product_boms`(`id`),
  `planned_quantity` integer NOT NULL,
  `ordered_quantity` integer NOT NULL DEFAULT 0,
  `over_tolerance_bps` integer NOT NULL DEFAULT 0,
  `under_tolerance_bps` integer NOT NULL DEFAULT 0,
  `completion_status` text NOT NULL DEFAULT 'not_ordered',
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `purchase_plan_summary_key` ON `purchase_plan_items` (`purchase_plan_id`,`expected_arrival_date`,`factory_id`,`warehouse_id`,`sku`);

CREATE TABLE `purchase_plan_source_rows` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_plan_id` integer NOT NULL REFERENCES `purchase_plans`(`id`),
  `source_row_no` integer NOT NULL,
  `source_plan_no` text NOT NULL,
  `is_combination_main` integer NOT NULL DEFAULT 0,
  `ignored_expanded_item` integer NOT NULL DEFAULT 0,
  `raw_json` text NOT NULL
);

CREATE TABLE `purchase_plan_order_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_plan_item_id` integer NOT NULL REFERENCES `purchase_plan_items`(`id`),
  `order_item_id` integer NOT NULL REFERENCES `order_items`(`id`),
  `allocated_quantity` integer NOT NULL,
  `match_method` text NOT NULL,
  `confirmed_by` integer NOT NULL REFERENCES `users`(`id`),
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX `purchase_plan_order_link_unique` ON `purchase_plan_order_links` (`purchase_plan_item_id`,`order_item_id`);

CREATE TABLE `factory_plan_responses` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `purchase_plan_id` integer NOT NULL REFERENCES `purchase_plans`(`id`),
  `factory_id` integer NOT NULL REFERENCES `factories`(`id`),
  `decision` text NOT NULL,
  `expected_start_date` text NOT NULL,
  `expected_finish_date` text NOT NULL,
  `proposed_arrival_date` text,
  `reason` text NOT NULL DEFAULT '',
  `status` text NOT NULL,
  `responded_by` integer NOT NULL REFERENCES `users`(`id`),
  `reviewed_by` integer REFERENCES `users`(`id`),
  `reviewed_at` text,
  `created_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` text NOT NULL DEFAULT CURRENT_TIMESTAMP
);
