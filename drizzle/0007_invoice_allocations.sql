CREATE TABLE `invoice_payment_allocations` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invoice_id` integer NOT NULL,
  `payment_request_id` integer NOT NULL,
  `allocated_amount_minor` integer NOT NULL,
  `status` text DEFAULT 'active' NOT NULL,
  `created_by` integer NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`invoice_id`) REFERENCES `factory_invoices`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`payment_request_id`) REFERENCES `factory_payment_requests`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoice_payment_request_unique`
ON `invoice_payment_allocations` (`invoice_id`, `payment_request_id`);
