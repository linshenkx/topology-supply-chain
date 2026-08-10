CREATE TABLE `invoice_exceptions` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invoice_id` integer NOT NULL,
  `exception_type` text NOT NULL,
  `affected_amount_minor` integer NOT NULL,
  `replacement_deadline` text NOT NULL,
  `replacement_covered_amount_minor` integer DEFAULT 0 NOT NULL,
  `refunded_amount_minor` integer DEFAULT 0 NOT NULL,
  `status` text DEFAULT 'awaiting_remediation' NOT NULL,
  `reason` text NOT NULL,
  `created_by` integer NOT NULL,
  `risk_released_by` integer,
  `risk_released_at` text,
  `risk_release_reason` text,
  `risk_release_evidence_file_key` text,
  `resolved_at` text,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`invoice_id`) REFERENCES `factory_invoices`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`risk_released_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `replacement_invoice_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `invoice_exception_id` integer NOT NULL,
  `replacement_invoice_id` integer NOT NULL,
  `covered_amount_minor` integer NOT NULL,
  `status` text DEFAULT 'pending_verification' NOT NULL,
  `created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  `updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
  FOREIGN KEY (`invoice_exception_id`) REFERENCES `invoice_exceptions`(`id`) ON UPDATE no action ON DELETE no action,
  FOREIGN KEY (`replacement_invoice_id`) REFERENCES `factory_invoices`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `replacement_invoice_unique`
ON `replacement_invoice_links` (`invoice_exception_id`, `replacement_invoice_id`);
--> statement-breakpoint
ALTER TABLE `payment_records` ADD `invoice_exception_id` integer REFERENCES `invoice_exceptions`(`id`);
