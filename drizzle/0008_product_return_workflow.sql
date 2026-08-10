CREATE TABLE `product_return_inspections` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_return_id` integer NOT NULL,
  `inspected_quantity` integer NOT NULL,
  `passed_quantity` integer NOT NULL,
  `failed_quantity` integer NOT NULL,
  `defect_reason` text DEFAULT '' NOT NULL,
  `evidence_file_key` text NOT NULL,
  `inspected_by` integer NOT NULL,
  `inspected_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`product_return_id`) REFERENCES `product_returns`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`inspected_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `product_return_dispositions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `product_return_id` integer NOT NULL,
  `type` text NOT NULL,
  `quantity` integer NOT NULL,
  `proposed_by` integer NOT NULL,
  `status` text DEFAULT 'pending_supply_chain' NOT NULL,
  `reviewed_by` integer,
  `reviewed_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`product_return_id`) REFERENCES `product_returns`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_return_disposition_unique`
ON `product_return_dispositions` (`product_return_id`, `type`);
