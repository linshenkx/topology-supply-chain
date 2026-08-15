CREATE TABLE `purchase_receipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`receipt_no` varchar(191) NOT NULL,
	`purchase_order_id` int NOT NULL,
	`order_item_id` int NOT NULL,
	`warehouse_id` int NOT NULL,
	`batch_id` int NOT NULL,
	`received_quantity` int NOT NULL,
	`received_at` text NOT NULL,
	`received_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_receipts_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_receipts_receipt_no_unique` UNIQUE(`receipt_no`),
	CONSTRAINT `purchase_receipt_order_item_unique` UNIQUE(`order_item_id`)
);
--> statement-breakpoint
ALTER TABLE `quality_inspections` MODIFY COLUMN `execution_order_id` int;--> statement-breakpoint
ALTER TABLE `order_items` ADD `received_quantity` int DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `quality_inspections` ADD `batch_id` int;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD CONSTRAINT `purchase_receipts_purchase_order_id_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD CONSTRAINT `purchase_receipts_order_item_id_order_items_id_fk` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD CONSTRAINT `purchase_receipts_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD CONSTRAINT `purchase_receipts_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_receipts` ADD CONSTRAINT `purchase_receipts_received_by_users_id_fk` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quality_inspections` ADD CONSTRAINT `quality_inspections_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`) VALUES
  ('r3.purchase-receipts.commands', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `owner` = VALUES(`owner`), `enabled` = false,
  `generation` = VALUES(`generation`), `updated_at` = CURRENT_TIMESTAMP(3);
--> statement-breakpoint
ALTER TABLE `production_reports` ADD `batch_id` int;--> statement-breakpoint
ALTER TABLE `production_reports` ADD CONSTRAINT `production_reports_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;
