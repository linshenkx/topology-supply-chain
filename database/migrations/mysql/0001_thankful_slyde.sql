CREATE TABLE `supplier_performance_reviews` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplier_id` int NOT NULL,
	`quarter` varchar(191) NOT NULL,
	`review_type` varchar(191) NOT NULL,
	`score` int NOT NULL,
	`tags_json` text NOT NULL DEFAULT ('[]'),
	`comment` text NOT NULL DEFAULT (''),
	`evaluator_user_id` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supplier_performance_reviews_id` PRIMARY KEY(`id`),
	CONSTRAINT `supplier_performance_review_unique` UNIQUE(`supplier_id`,`quarter`,`review_type`,`evaluator_user_id`)
);
--> statement-breakpoint
CREATE TABLE `supplier_performance_weight_versions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tier` int NOT NULL,
	`effective_from` varchar(191) NOT NULL,
	`delivery_weight_bps` int NOT NULL,
	`quality_weight_bps` int NOT NULL,
	`exception_weight_bps` int NOT NULL,
	`preparation_weight_bps` int NOT NULL,
	`satisfaction_weight_bps` int NOT NULL DEFAULT 0,
	`sampling_weight_bps` int NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`created_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supplier_performance_weight_versions_id` PRIMARY KEY(`id`),
	CONSTRAINT `supplier_performance_weight_tier_date_unique` UNIQUE(`tier`,`effective_from`)
);
--> statement-breakpoint
ALTER TABLE `supplier_performance_reviews` ADD CONSTRAINT `supplier_performance_reviews_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_performance_reviews` ADD CONSTRAINT `supplier_performance_reviews_evaluator_user_id_users_id_fk` FOREIGN KEY (`evaluator_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_performance_weight_versions` ADD CONSTRAINT `supplier_performance_weight_versions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;
