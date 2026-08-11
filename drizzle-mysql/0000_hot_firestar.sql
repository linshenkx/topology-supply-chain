CREATE TABLE `ai_conversations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`retain_until` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_conversations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversation_id` int NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`citation_json` text,
	`confidence_status` text NOT NULL DEFAULT ('confirmed'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ai_operation_drafts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`conversation_id` int NOT NULL,
	`operation_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`high_risk` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('draft'),
	`confirmed_by` int,
	`confirmed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `ai_operation_drafts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `approval_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`request_no` varchar(191) NOT NULL,
	`workflow_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` int NOT NULL,
	`summary` text NOT NULL,
	`payload_json` text NOT NULL,
	`high_risk` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('pending'),
	`requested_by` int NOT NULL,
	`requested_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`reviewed_by` int,
	`reviewed_at` text,
	`review_comment` text,
	`sms_verified_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `approval_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `approval_requests_request_no_unique` UNIQUE(`request_no`)
);
--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` int AUTO_INCREMENT NOT NULL,
	`exception_id` int NOT NULL,
	`decision` text NOT NULL,
	`comment` text NOT NULL DEFAULT (''),
	`approved_by` int NOT NULL,
	`approved_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `approvals_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`actor_user_id` int,
	`action` text NOT NULL,
	`module` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`business_no` text,
	`before_json` text,
	`after_json` text,
	`ip_address` text,
	`device_id` varchar(191),
	`sensitive_view` boolean NOT NULL DEFAULT false,
	`exported` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`archive_after` text NOT NULL,
	CONSTRAINT `audit_logs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `auth_challenges` (
	`id` int AUTO_INCREMENT NOT NULL,
	`challenge_no` varchar(191) NOT NULL,
	`user_id` int NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`device_id` varchar(191) NOT NULL,
	`ip_address` text,
	`region` text,
	`expires_at` text NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`verified_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auth_challenges_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_challenges_challenge_no_unique` UNIQUE(`challenge_no`)
);
--> statement-breakpoint
CREATE TABLE `auth_credentials` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`password_hash` text NOT NULL,
	`password_salt` text NOT NULL,
	`failed_attempts` int NOT NULL DEFAULT 0,
	`locked_at` text,
	`password_changed_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auth_credentials_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_credentials_user_id_unique` UNIQUE(`user_id`)
);
--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`token_hash` varchar(191) NOT NULL,
	`device_id` varchar(191) NOT NULL,
	`ip_address` text,
	`region` text,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	`last_seen_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auth_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `auth_sessions_token_hash_unique` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `bom_components` (
	`id` int AUTO_INCREMENT NOT NULL,
	`bom_id` int NOT NULL,
	`component_sku` varchar(191) NOT NULL,
	`item_type` text NOT NULL,
	`is_core` boolean NOT NULL DEFAULT false,
	`quantity_per_finished` int NOT NULL,
	`issue_tolerance_bps` int NOT NULL DEFAULT 0,
	`consumption_tolerance_bps` int NOT NULL DEFAULT 0,
	`loss_tolerance_bps` int NOT NULL DEFAULT 0,
	CONSTRAINT `bom_components_id` PRIMARY KEY(`id`),
	CONSTRAINT `bom_component_unique` UNIQUE(`bom_id`,`component_sku`)
);
--> statement-breakpoint
CREATE TABLE `core_order_reschedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`core_supplier_order_id` int NOT NULL,
	`previous_ship_date` text NOT NULL,
	`proposed_ship_date` text NOT NULL,
	`supplier_reason` text NOT NULL,
	`factory_decision` text NOT NULL DEFAULT ('pending'),
	`factory_confirmed_by` int,
	`factory_confirmed_at` text,
	`supply_chain_decision` text NOT NULL DEFAULT ('pending'),
	`supply_chain_reviewed_by` int,
	`supply_chain_reviewed_at` text,
	`review_comment` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `core_order_reschedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `core_price_agreements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplier_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`currency` text NOT NULL DEFAULT ('CNY'),
	`unit_price_tax_included_minor` int NOT NULL,
	`unit_price_tax_excluded_minor` int NOT NULL,
	`tax_rate_bps` int NOT NULL,
	`effective_from` varchar(191) NOT NULL,
	`effective_to` text,
	`status` text NOT NULL DEFAULT ('active'),
	`maintained_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `core_price_agreements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `core_price_change_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`current_agreement_id` int,
	`supplier_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`proposed_tax_included_minor` int NOT NULL,
	`proposed_tax_excluded_minor` int NOT NULL,
	`proposed_tax_rate_bps` int NOT NULL,
	`proposed_effective_from` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_file_key` text NOT NULL,
	`requested_by` int NOT NULL,
	`reviewed_by` int,
	`decision` text NOT NULL DEFAULT ('pending'),
	`review_comment` text,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `core_price_change_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `core_supplier_order_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`core_supplier_order_id` int NOT NULL,
	`component_sku` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`price_agreement_id` int NOT NULL,
	`currency` text NOT NULL,
	`unit_price_tax_included_minor` int NOT NULL,
	`unit_price_tax_excluded_minor` int NOT NULL,
	`tax_rate_bps` int NOT NULL,
	`amount_tax_included_minor` int NOT NULL,
	`amount_tax_excluded_minor` int NOT NULL,
	CONSTRAINT `core_supplier_order_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `core_supplier_order_item_unique` UNIQUE(`core_supplier_order_id`,`component_sku`)
);
--> statement-breakpoint
CREATE TABLE `core_supplier_orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`order_no` varchar(191) NOT NULL,
	`source_purchase_order_id` int NOT NULL,
	`assembly_factory_id` int NOT NULL,
	`supplier_id` int NOT NULL,
	`planned_ship_date` text NOT NULL,
	`status` text NOT NULL DEFAULT ('awaiting_confirmation'),
	`confirmed_by` int,
	`confirmed_at` text,
	`inability_reason` text,
	`proposed_ship_date` text,
	`alert_status` text NOT NULL DEFAULT ('none'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `core_supplier_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `core_supplier_orders_order_no_unique` UNIQUE(`order_no`)
);
--> statement-breakpoint
CREATE TABLE `defect_catalog` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(191) NOT NULL,
	`name` text NOT NULL,
	`item_type` text,
	`description` text NOT NULL DEFAULT (''),
	`status` text NOT NULL DEFAULT ('proposed'),
	`proposed_by` int,
	`approved_by` int,
	`approved_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `defect_catalog_id` PRIMARY KEY(`id`),
	CONSTRAINT `defect_catalog_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `defect_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inspection_defect_id` int NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `defect_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `delivery_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_order_id` int NOT NULL,
	`batch_no` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`planned_ship_at` text NOT NULL,
	`shipped_at` text,
	`carrier` text NOT NULL,
	`logistics_no` text NOT NULL,
	`destination` text NOT NULL,
	`requires_approval` boolean NOT NULL DEFAULT false,
	`deviation_reason` text,
	`status` text NOT NULL DEFAULT ('planned'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `delivery_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `delivery_batch_unique` UNIQUE(`execution_order_id`,`batch_no`)
);
--> statement-breakpoint
CREATE TABLE `delivery_setting_changes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`setting_id` int NOT NULL,
	`old_days` int NOT NULL,
	`new_days` int NOT NULL,
	`reason` text NOT NULL,
	`changed_by` int NOT NULL,
	`supply_chain_notified_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `delivery_setting_changes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_order_id` int,
	`factory_id` int,
	`type` varchar(191) NOT NULL,
	`description` text NOT NULL,
	`evidence_file_key` text,
	`status` text NOT NULL DEFAULT ('pending_supply_chain'),
	`submitted_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `execution_orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_no` varchar(191) NOT NULL,
	`order_item_id` int NOT NULL,
	`factory_id` int NOT NULL,
	`bom_id` int,
	`planned_quantity` int NOT NULL,
	`completed_quantity` int NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT ('factory_confirmation'),
	`due_date` text,
	`planned_start_date` text,
	`planned_finish_date` text,
	`actual_start_at` text,
	`actual_finish_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `execution_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `execution_orders_execution_no_unique` UNIQUE(`execution_no`)
);
--> statement-breakpoint
CREATE TABLE `factories` (
	`id` int AUTO_INCREMENT NOT NULL,
	`name` text NOT NULL,
	`code` varchar(191) NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factories_id` PRIMARY KEY(`id`),
	CONSTRAINT `factories_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `factory_change_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sku` varchar(191) NOT NULL,
	`from_factory_id` int NOT NULL,
	`to_factory_id` int NOT NULL,
	`reason` text NOT NULL,
	`requested_by` int NOT NULL,
	`reviewed_by` int,
	`decision` text NOT NULL DEFAULT ('pending'),
	`review_comment` text,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_change_requests_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_invoices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`factory_id` int NOT NULL,
	`purchase_order_id` int NOT NULL,
	`coverage_mode` text NOT NULL,
	`delivery_batch_id` int,
	`invoice_no` varchar(191) NOT NULL,
	`invoice_type` text NOT NULL,
	`amount_tax_included_minor` int NOT NULL,
	`tax_amount_minor` int NOT NULL,
	`issued_at` text NOT NULL,
	`received_at` text,
	`file_key` text,
	`status` text NOT NULL DEFAULT ('pending'),
	`expected_amount_minor` int NOT NULL,
	`amount_matches_expected` boolean NOT NULL DEFAULT false,
	`mismatch_amount_minor` int NOT NULL DEFAULT 0,
	`maintained_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_invoices_id` PRIMARY KEY(`id`),
	CONSTRAINT `factory_invoices_invoice_no_unique` UNIQUE(`invoice_no`)
);
--> statement-breakpoint
CREATE TABLE `factory_payment_request_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`payment_request_id` int NOT NULL,
	`payment_schedule_id` int NOT NULL,
	`purchase_order_id` int NOT NULL,
	`triggered_by_delivery_batch_id` int NOT NULL,
	`amount_minor` int NOT NULL,
	CONSTRAINT `factory_payment_request_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `payment_request_schedule_unique` UNIQUE(`payment_request_id`,`payment_schedule_id`)
);
--> statement-breakpoint
CREATE TABLE `factory_payment_requests` (
	`id` int AUTO_INCREMENT NOT NULL,
	`request_no` varchar(191) NOT NULL,
	`factory_id` int NOT NULL,
	`actual_shipment_date` text NOT NULL,
	`planned_payment_date` varchar(191) NOT NULL,
	`total_amount_minor` int NOT NULL,
	`auto_generated` boolean NOT NULL DEFAULT true,
	`status` text NOT NULL DEFAULT ('waiting_invoice'),
	`invoice_covered_amount_minor` int NOT NULL DEFAULT 0,
	`maintained_by` int NOT NULL,
	`submitted_to_finance_at` text,
	`supply_chain_notified_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finance_notified_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`paid_at` text,
	`payment_reference` text,
	`payment_note` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_payment_requests_id` PRIMARY KEY(`id`),
	CONSTRAINT `factory_payment_requests_request_no_unique` UNIQUE(`request_no`),
	CONSTRAINT `factory_payment_request_group_unique` UNIQUE(`factory_id`,`planned_payment_date`)
);
--> statement-breakpoint
CREATE TABLE `factory_payment_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_order_id` int NOT NULL,
	`factory_id` int NOT NULL,
	`delivery_batch_id` int NOT NULL,
	`payment_type` text NOT NULL,
	`rate_bps` int,
	`shipped_quantity` int NOT NULL,
	`unit_price_minor` int NOT NULL,
	`amount_minor` int NOT NULL,
	`payment_term_id` int NOT NULL,
	`payment_rule_snapshot` text NOT NULL,
	`planned_payment_date` varchar(191) NOT NULL,
	`trigger_event` text NOT NULL DEFAULT ('actual_shipment'),
	`status` text NOT NULL DEFAULT ('planned'),
	`maintained_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_payment_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_payment_terms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`factory_id` int NOT NULL,
	`name` text NOT NULL,
	`mode` text NOT NULL,
	`days_after_shipment` int,
	`cutoff_day` int,
	`settlement_month_offset` int,
	`payment_day` int,
	`invoice_required` boolean NOT NULL DEFAULT true,
	`active` boolean NOT NULL DEFAULT true,
	`maintained_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_payment_terms_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_plan_responses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_plan_id` int NOT NULL,
	`factory_id` int NOT NULL,
	`decision` text NOT NULL,
	`expected_start_date` text NOT NULL,
	`expected_finish_date` text NOT NULL,
	`proposed_arrival_date` text,
	`reason` text NOT NULL DEFAULT (''),
	`status` text NOT NULL,
	`responded_by` int NOT NULL,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_plan_responses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `factory_supplier_delivery_settings` (
	`id` int AUTO_INCREMENT NOT NULL,
	`factory_id` int NOT NULL,
	`supplier_id` int NOT NULL,
	`component_sku` varchar(191) NOT NULL,
	`arrival_buffer_days` int NOT NULL,
	`maintained_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `factory_supplier_delivery_settings_id` PRIMARY KEY(`id`),
	CONSTRAINT `factory_supplier_sku_buffer_unique` UNIQUE(`factory_id`,`supplier_id`,`component_sku`)
);
--> statement-breakpoint
CREATE TABLE `file_objects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`object_key` varchar(191) NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` int NOT NULL,
	`category` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`owner_user_id` int NOT NULL,
	`factory_id` int,
	`supplier_id` int,
	`sensitive` boolean NOT NULL DEFAULT false,
	`retain_until` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `file_objects_id` PRIMARY KEY(`id`),
	CONSTRAINT `file_objects_object_key_unique` UNIQUE(`object_key`)
);
--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`import_no` varchar(191) NOT NULL,
	`type` varchar(191) NOT NULL,
	`file_object_id` int,
	`file_name` text NOT NULL,
	`fingerprint` text NOT NULL,
	`business_key` text,
	`status` text NOT NULL DEFAULT ('preview'),
	`total_rows` int NOT NULL DEFAULT 0,
	`valid_rows` int NOT NULL DEFAULT 0,
	`error_count` int NOT NULL DEFAULT 0,
	`warning_count` int NOT NULL DEFAULT 0,
	`duplicate_of_batch_id` int,
	`committed_by` int,
	`committed_at` text,
	`created_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `import_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `import_batches_import_no_unique` UNIQUE(`import_no`)
);
--> statement-breakpoint
CREATE TABLE `import_staging_rows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`import_batch_id` int NOT NULL,
	`sheet_name` text NOT NULL,
	`source_row_no` int NOT NULL,
	`business_key` text,
	`normalized_json` text NOT NULL,
	`raw_json` text NOT NULL,
	`validation_status` text NOT NULL,
	`validation_messages_json` text NOT NULL DEFAULT ('[]'),
	`mapping_confirmed` boolean NOT NULL DEFAULT false,
	CONSTRAINT `import_staging_rows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inspection_defects` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inspection_id` int NOT NULL,
	`defect_id` int NOT NULL,
	`quantity` int NOT NULL,
	`note` text NOT NULL DEFAULT (''),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inspection_defects_id` PRIMARY KEY(`id`),
	CONSTRAINT `inspection_defect_unique` UNIQUE(`inspection_id`,`defect_id`)
);
--> statement-breakpoint
CREATE TABLE `inspection_images` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inspection_id` int NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inspection_images_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory` (
	`id` int AUTO_INCREMENT NOT NULL,
	`warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`item_type` text NOT NULL,
	`available_quantity` int NOT NULL DEFAULT 0,
	`locked_quantity` int NOT NULL DEFAULT 0,
	`quarantined_quantity` int NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventory_warehouse_sku_unique` UNIQUE(`warehouse_id`,`sku`)
);
--> statement-breakpoint
CREATE TABLE `inventory_batches` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batch_no` varchar(191) NOT NULL,
	`warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`production_date` text,
	`inbound_date` text NOT NULL,
	`expiry_date` text,
	`production_date_estimated` boolean NOT NULL DEFAULT false,
	`expiry_date_estimated` boolean NOT NULL DEFAULT false,
	`available_quantity` int NOT NULL DEFAULT 0,
	`locked_quantity` int NOT NULL DEFAULT 0,
	`defective_quantity` int NOT NULL DEFAULT 0,
	`pending_inspection_quantity` int NOT NULL DEFAULT 0,
	`quarantine_quantity` int NOT NULL DEFAULT 0,
	`ownership` text NOT NULL DEFAULT ('company'),
	`expiry_status` text NOT NULL DEFAULT ('normal'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_batches_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventory_batches_batch_no_unique` UNIQUE(`batch_no`),
	CONSTRAINT `inventory_batch_warehouse_unique` UNIQUE(`warehouse_id`,`batch_no`)
);
--> statement-breakpoint
CREATE TABLE `inventory_movements` (
	`id` int AUTO_INCREMENT NOT NULL,
	`warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`type` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`delivery_batch_id` int,
	`occurred_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_by` int NOT NULL,
	CONSTRAINT `inventory_movements_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory_reservations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`batch_id` int NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` int,
	`requested_quantity` int NOT NULL,
	`reserved_quantity` int NOT NULL,
	`shortage_quantity` int NOT NULL DEFAULT 0,
	`priority` int NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT ('active'),
	`created_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_reservations_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `inventory_transfers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`transfer_no` varchar(191) NOT NULL,
	`from_warehouse_id` int NOT NULL,
	`to_warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`reason` text NOT NULL,
	`status` text NOT NULL DEFAULT ('pending_supply_chain'),
	`requested_by` int NOT NULL,
	`approved_by` int,
	`approved_at` text,
	`shipped_at` text,
	`received_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `inventory_transfers_id` PRIMARY KEY(`id`),
	CONSTRAINT `inventory_transfers_transfer_no_unique` UNIQUE(`transfer_no`)
);
--> statement-breakpoint
CREATE TABLE `invoice_exceptions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`exception_type` text NOT NULL,
	`affected_amount_minor` int NOT NULL,
	`replacement_deadline` text NOT NULL,
	`replacement_covered_amount_minor` int NOT NULL DEFAULT 0,
	`refunded_amount_minor` int NOT NULL DEFAULT 0,
	`status` text NOT NULL DEFAULT ('awaiting_remediation'),
	`reason` text NOT NULL,
	`created_by` int NOT NULL,
	`risk_released_by` int,
	`risk_released_at` text,
	`risk_release_reason` text,
	`risk_release_evidence_file_key` text,
	`resolved_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invoice_exceptions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invoice_payment_allocations` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`payment_request_id` int NOT NULL,
	`allocated_amount_minor` int NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`created_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invoice_payment_allocations_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_payment_request_unique` UNIQUE(`invoice_id`,`payment_request_id`)
);
--> statement-breakpoint
CREATE TABLE `invoice_verifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_id` int NOT NULL,
	`verifier_role` varchar(191) NOT NULL,
	`decision` text NOT NULL,
	`rejection_reason` text,
	`verified_by` int NOT NULL,
	`verified_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `invoice_verifications_id` PRIMARY KEY(`id`),
	CONSTRAINT `invoice_role_verification_unique` UNIQUE(`invoice_id`,`verifier_role`)
);
--> statement-breakpoint
CREATE TABLE `nonconformance_dispositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`inspection_id` int NOT NULL,
	`type` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`comment` text NOT NULL DEFAULT (''),
	`requires_supply_chain_approval` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('factory_confirmation'),
	`confirmed_by` int,
	`exception_id` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `nonconformance_dispositions_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notification_messages` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recipient_user_id` int,
	`recipient_role` text,
	`recipient_factory_id` int,
	`recipient_supplier_id` int,
	`channel` text NOT NULL,
	`type` varchar(191) NOT NULL,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` int NOT NULL,
	`business_no` text,
	`status` text NOT NULL DEFAULT ('queued'),
	`sent_at` text,
	`read_at` text,
	`error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notification_messages_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`recipient_role` text NOT NULL,
	`type` varchar(191) NOT NULL,
	`title` text NOT NULL,
	`message` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` int NOT NULL,
	`read_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_order_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`product_name` text NOT NULL,
	`item_type` text NOT NULL,
	`supplier_id` int,
	`quantity` int NOT NULL,
	`unit_price_tax_included_minor` int NOT NULL DEFAULT 0,
	`amount_tax_included_minor` int NOT NULL DEFAULT 0,
	`due_date` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `order_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `order_item_unique` UNIQUE(`purchase_order_id`,`sku`,`supplier_id`)
);
--> statement-breakpoint
CREATE TABLE `payment_records` (
	`id` int AUTO_INCREMENT NOT NULL,
	`payment_request_id` int NOT NULL,
	`amount_minor` int NOT NULL,
	`paid_at` text NOT NULL,
	`bank_reference` text NOT NULL,
	`record_type` text NOT NULL DEFAULT ('payment'),
	`reverses_payment_record_id` int,
	`invoice_exception_id` int,
	`recorded_by` int NOT NULL,
	`reviewed_by` int,
	`review_status` text NOT NULL DEFAULT ('not_required'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `payment_records_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_boms` (
	`id` int AUTO_INCREMENT NOT NULL,
	`finished_sku` varchar(191) NOT NULL,
	`version` varchar(191) NOT NULL,
	`effective_from` varchar(191) NOT NULL,
	`effective_to` text,
	`overlap_allowed` boolean NOT NULL DEFAULT false,
	`overlap_reason` text NOT NULL DEFAULT (''),
	`approval_status` text NOT NULL DEFAULT ('draft'),
	`reviewed_by` int,
	`reviewed_at` text,
	`active` boolean NOT NULL DEFAULT true,
	`created_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_boms_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_bom_version_unique` UNIQUE(`finished_sku`,`version`)
);
--> statement-breakpoint
CREATE TABLE `product_return_dispositions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`product_return_id` int NOT NULL,
	`type` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`proposed_by` int NOT NULL,
	`status` text NOT NULL DEFAULT ('pending_supply_chain'),
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_return_dispositions_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_return_disposition_unique` UNIQUE(`product_return_id`,`type`)
);
--> statement-breakpoint
CREATE TABLE `product_return_inspections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`product_return_id` int NOT NULL,
	`inspected_quantity` int NOT NULL,
	`passed_quantity` int NOT NULL,
	`failed_quantity` int NOT NULL,
	`defect_reason` text NOT NULL DEFAULT (''),
	`evidence_file_key` text NOT NULL,
	`inspected_by` int NOT NULL,
	`inspected_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_return_inspections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `product_returns` (
	`id` int AUTO_INCREMENT NOT NULL,
	`return_no` varchar(191) NOT NULL,
	`source_delivery_batch_id` int NOT NULL,
	`warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`quantity` int NOT NULL,
	`batch_id` int,
	`status` text NOT NULL,
	`proposed_disposition` text,
	`proposed_by` int,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `product_returns_id` PRIMARY KEY(`id`),
	CONSTRAINT `product_returns_return_no_unique` UNIQUE(`return_no`)
);
--> statement-breakpoint
CREATE TABLE `production_material_lines` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_order_id` int NOT NULL,
	`bom_component_id` int NOT NULL,
	`theoretical_quantity` int NOT NULL,
	`reserved_quantity` int NOT NULL DEFAULT 0,
	`issued_quantity` int NOT NULL DEFAULT 0,
	`consumed_quantity` int NOT NULL DEFAULT 0,
	`loss_quantity` int NOT NULL DEFAULT 0,
	`deviation_status` text NOT NULL DEFAULT ('within_tolerance'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `production_material_lines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `production_reports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_order_id` int NOT NULL,
	`actual_finished_quantity` int NOT NULL,
	`variance_quantity` int NOT NULL,
	`variance_rate_bps` int NOT NULL,
	`result` text NOT NULL,
	`company_inventory_quantity` int NOT NULL DEFAULT 0,
	`factory_owned_quantity` int NOT NULL DEFAULT 0,
	`reported_by` int NOT NULL,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `production_reports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_import_diffs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_import_id` int NOT NULL,
	`sheet_name` text NOT NULL,
	`row_key` text NOT NULL,
	`field_name` text NOT NULL,
	`old_value` text,
	`new_value` text,
	`change_type` text NOT NULL,
	CONSTRAINT `purchase_import_diffs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_imports` (
	`id` int AUTO_INCREMENT NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`detected_order_no` text,
	`matched_purchase_order_id` int,
	`is_possible_duplicate` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('analyzing'),
	`imported_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_imports_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`order_no` varchar(191) NOT NULL,
	`source` text NOT NULL DEFAULT ('lingxing_excel'),
	`source_file_key` text,
	`status` text NOT NULL DEFAULT ('draft'),
	`order_date` text,
	`total_tax_included_minor` int NOT NULL DEFAULT 0,
	`payment_term_id` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_orders_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_orders_order_no_unique` UNIQUE(`order_no`)
);
--> statement-breakpoint
CREATE TABLE `purchase_plan_items` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_plan_id` int NOT NULL,
	`expected_arrival_date` varchar(191) NOT NULL,
	`factory_id` int NOT NULL,
	`warehouse_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`product_name` text NOT NULL,
	`bom_id` int NOT NULL,
	`planned_quantity` int NOT NULL,
	`ordered_quantity` int NOT NULL DEFAULT 0,
	`over_tolerance_bps` int NOT NULL DEFAULT 0,
	`under_tolerance_bps` int NOT NULL DEFAULT 0,
	`completion_status` text NOT NULL DEFAULT ('not_ordered'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_plan_items_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_plan_summary_key` UNIQUE(`purchase_plan_id`,`expected_arrival_date`,`factory_id`,`warehouse_id`,`sku`)
);
--> statement-breakpoint
CREATE TABLE `purchase_plan_order_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_plan_item_id` int NOT NULL,
	`order_item_id` int NOT NULL,
	`allocated_quantity` int NOT NULL,
	`match_method` text NOT NULL,
	`confirmed_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_plan_order_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_plan_order_link_unique` UNIQUE(`purchase_plan_item_id`,`order_item_id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_plan_source_rows` (
	`id` int AUTO_INCREMENT NOT NULL,
	`purchase_plan_id` int NOT NULL,
	`source_row_no` int NOT NULL,
	`source_plan_no` text NOT NULL,
	`is_combination_main` boolean NOT NULL DEFAULT false,
	`ignored_expanded_item` boolean NOT NULL DEFAULT false,
	`raw_json` text NOT NULL,
	CONSTRAINT `purchase_plan_source_rows_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `purchase_plans` (
	`id` int AUTO_INCREMENT NOT NULL,
	`plan_no` varchar(191) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`source` text NOT NULL DEFAULT ('lingxing_excel'),
	`source_file_key` text,
	`status` text NOT NULL DEFAULT ('draft'),
	`confirmation_due_at` text,
	`confirmed_at` text,
	`created_by` int NOT NULL,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `purchase_plans_id` PRIMARY KEY(`id`),
	CONSTRAINT `purchase_plan_version_unique` UNIQUE(`plan_no`,`version`)
);
--> statement-breakpoint
CREATE TABLE `quality_inspections` (
	`id` int AUTO_INCREMENT NOT NULL,
	`execution_order_id` int NOT NULL,
	`stage` text NOT NULL,
	`inspection_method` text NOT NULL,
	`batch_quantity` int NOT NULL,
	`inspected_quantity` int NOT NULL,
	`passed_quantity` int NOT NULL,
	`failed_quantity` int NOT NULL,
	`pass_rate_bps` int NOT NULL,
	`quality_rule_id` int NOT NULL,
	`used_item_type_fallback` boolean NOT NULL DEFAULT false,
	`sku_rule_reminder_status` text NOT NULL DEFAULT ('not_needed'),
	`defect_reason` text NOT NULL DEFAULT (''),
	`system_result` text NOT NULL,
	`requested_result` text,
	`requires_approval` boolean NOT NULL DEFAULT false,
	`final_result` text NOT NULL,
	`quarantine_triggered` boolean NOT NULL DEFAULT false,
	`full_inspection_required` boolean NOT NULL DEFAULT false,
	`source_inspection_id` int,
	`released_quantity` int NOT NULL DEFAULT 0,
	`disposition_status` text NOT NULL DEFAULT ('not_needed'),
	`inspector_type` text NOT NULL,
	`submitted_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `quality_inspections_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `quality_rules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`scope` text NOT NULL,
	`sku` varchar(191),
	`item_type` text,
	`stage` text NOT NULL,
	`minimum_pass_rate_bps` int NOT NULL,
	`active` boolean NOT NULL DEFAULT true,
	`source` text NOT NULL DEFAULT ('manual'),
	`created_by` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `quality_rules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reminder_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`reminder_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` int NOT NULL,
	`business_no` text,
	`due_at` text NOT NULL,
	`next_run_at` text NOT NULL,
	`recurrence` text NOT NULL,
	`milestone_days_json` text NOT NULL DEFAULT ('[]'),
	`recipient_role_json` text NOT NULL,
	`recipient_user_ids_json` text NOT NULL DEFAULT ('[]'),
	`channels_json` text NOT NULL DEFAULT ('["in_app","email"]'),
	`severity` text NOT NULL DEFAULT ('normal'),
	`quiet_hours_bypass` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('active'),
	`last_run_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `reminder_schedules_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `replacement_invoice_links` (
	`id` int AUTO_INCREMENT NOT NULL,
	`invoice_exception_id` int NOT NULL,
	`replacement_invoice_id` int NOT NULL,
	`covered_amount_minor` int NOT NULL,
	`status` text NOT NULL DEFAULT ('pending_verification'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `replacement_invoice_links_id` PRIMARY KEY(`id`),
	CONSTRAINT `replacement_invoice_unique` UNIQUE(`invoice_exception_id`,`replacement_invoice_id`)
);
--> statement-breakpoint
CREATE TABLE `shipment_evidence` (
	`id` int AUTO_INCREMENT NOT NULL,
	`delivery_batch_id` int NOT NULL,
	`file_key` text NOT NULL,
	`file_name` text NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shipment_evidence_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `shipment_receipts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`delivery_batch_id` int NOT NULL,
	`received_quantity` int NOT NULL,
	`damaged_quantity` int NOT NULL DEFAULT 0,
	`received_at` text NOT NULL,
	`evidence_file_key` text NOT NULL,
	`exception_reason` text NOT NULL DEFAULT (''),
	`received_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `shipment_receipts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sku_factory_defaults` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sku` varchar(191) NOT NULL,
	`factory_id` int NOT NULL,
	`selected_by` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sku_factory_defaults_id` PRIMARY KEY(`id`),
	CONSTRAINT `sku_factory_defaults_sku_unique` UNIQUE(`sku`)
);
--> statement-breakpoint
CREATE TABLE `sku_unit_conversions` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sku_id` int NOT NULL,
	`purchase_unit` varchar(191) NOT NULL,
	`stock_unit` text NOT NULL,
	`purchase_unit_quantity` int NOT NULL,
	`stock_unit_quantity` int NOT NULL,
	`effective_from` varchar(191) NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sku_unit_conversions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sku_purchase_unit_unique` UNIQUE(`sku_id`,`purchase_unit`,`effective_from`)
);
--> statement-breakpoint
CREATE TABLE `skus` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(191) NOT NULL,
	`name` text NOT NULL,
	`item_type` text,
	`stock_unit` text,
	`serial_tracking_enabled` boolean NOT NULL DEFAULT false,
	`overproduction_tolerance_bps` int NOT NULL DEFAULT 0,
	`purchase_over_tolerance_bps` int NOT NULL DEFAULT 0,
	`purchase_under_tolerance_bps` int NOT NULL DEFAULT 0,
	`verification_status` text NOT NULL DEFAULT ('pending'),
	`status` text NOT NULL DEFAULT ('draft'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `skus_id` PRIMARY KEY(`id`),
	CONSTRAINT `skus_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `stocktake_adjustments` (
	`id` int AUTO_INCREMENT NOT NULL,
	`stocktake_id` int NOT NULL,
	`stocktake_count_id` int NOT NULL,
	`variance_quantity` int NOT NULL,
	`generated_batch_no` text,
	`estimated_production_date` text,
	`estimated_expiry_date` text,
	`decision` text NOT NULL DEFAULT ('pending'),
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `stocktake_adjustments_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `stocktake_counts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`stocktake_id` int NOT NULL,
	`batch_id` int,
	`sku` varchar(191) NOT NULL,
	`count_round` int NOT NULL,
	`available_quantity` int NOT NULL,
	`locked_quantity` int NOT NULL,
	`defective_quantity` int NOT NULL,
	`pending_inspection_quantity` int NOT NULL,
	`total_quantity` int NOT NULL,
	`counted_by` int NOT NULL,
	`counted_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `stocktake_counts_id` PRIMARY KEY(`id`),
	CONSTRAINT `stocktake_count_round_unique` UNIQUE(`stocktake_id`,`sku`,`batch_id`,`count_round`)
);
--> statement-breakpoint
CREATE TABLE `stocktakes` (
	`id` int AUTO_INCREMENT NOT NULL,
	`stocktake_no` varchar(191) NOT NULL,
	`warehouse_id` int NOT NULL,
	`scope` text NOT NULL,
	`due_date` text NOT NULL,
	`status` text NOT NULL DEFAULT ('draft'),
	`frozen_at` text,
	`created_by` int NOT NULL,
	`assigned_factory_id` int,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `stocktakes_id` PRIMARY KEY(`id`),
	CONSTRAINT `stocktakes_stocktake_no_unique` UNIQUE(`stocktake_no`)
);
--> statement-breakpoint
CREATE TABLE `supplier_bank_accounts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplier_id` int NOT NULL,
	`account_name` text NOT NULL,
	`bank_name` text NOT NULL,
	`encrypted_account_no` text NOT NULL,
	`usage` text NOT NULL,
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supplier_bank_accounts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supplier_contacts` (
	`id` int AUTO_INCREMENT NOT NULL,
	`supplier_id` int NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`email` varchar(191) NOT NULL DEFAULT '',
	`wechat` text NOT NULL DEFAULT (''),
	`responsibility` text NOT NULL DEFAULT ('other'),
	`is_primary` boolean NOT NULL DEFAULT false,
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supplier_contacts_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `supplier_skus` (
	`id` int AUTO_INCREMENT NOT NULL,
	`factory_id` int NOT NULL,
	`supplier_id` int NOT NULL,
	`sku` varchar(191) NOT NULL,
	`is_primary` boolean NOT NULL DEFAULT false,
	`priority` int NOT NULL DEFAULT 1,
	`minimum_order_quantity` int NOT NULL DEFAULT 1,
	`packaging_multiple` int NOT NULL DEFAULT 1,
	`purchase_unit` varchar(191) NOT NULL DEFAULT '',
	`lead_time_days` int,
	`daily_capacity` int,
	`monthly_capacity` int,
	`effective_from` varchar(191) NOT NULL,
	`status` text NOT NULL DEFAULT ('pending'),
	`requested_by` int NOT NULL,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supplier_skus_id` PRIMARY KEY(`id`),
	CONSTRAINT `supplier_sku_unique` UNIQUE(`factory_id`,`supplier_id`,`sku`)
);
--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(191) NOT NULL,
	`name` text NOT NULL,
	`tier` int,
	`supplier_type` text,
	`managed_by_factory_id` int,
	`legal_name` text NOT NULL DEFAULT (''),
	`unified_social_credit_code` text NOT NULL DEFAULT (''),
	`business_license_file_key` text,
	`business_license_expires_at` text,
	`business_license_long_term` boolean NOT NULL DEFAULT false,
	`address` text NOT NULL DEFAULT (''),
	`contact_name` text NOT NULL DEFAULT (''),
	`contact_phone` text NOT NULL DEFAULT (''),
	`business_scope` text NOT NULL DEFAULT (''),
	`source` text NOT NULL DEFAULT ('manual'),
	`source_created_at` text,
	`verification_status` text NOT NULL DEFAULT ('pending'),
	`verified_by` int,
	`verified_at` text,
	`supply_risk` text NOT NULL DEFAULT ('low'),
	`risk_reason` text NOT NULL DEFAULT (''),
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `suppliers_id` PRIMARY KEY(`id`),
	CONSTRAINT `suppliers_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
CREATE TABLE `supply_risk_cases` (
	`id` int AUTO_INCREMENT NOT NULL,
	`risk_no` varchar(191) NOT NULL,
	`assembly_factory_id` int NOT NULL,
	`source_supplier_id` int,
	`source_tier` int NOT NULL,
	`affected_entity_type` text NOT NULL,
	`affected_entity_id` int NOT NULL,
	`trigger_type` text NOT NULL,
	`impact_summary` text NOT NULL,
	`response_due_at` text NOT NULL,
	`factory_plan` text,
	`proposed_delivery_date` text,
	`status` text NOT NULL DEFAULT ('open'),
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `supply_risk_cases_id` PRIMARY KEY(`id`),
	CONSTRAINT `supply_risk_cases_risk_no_unique` UNIQUE(`risk_no`)
);
--> statement-breakpoint
CREATE TABLE `trusted_devices` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`device_id` varchar(191) NOT NULL,
	`device_name` text NOT NULL DEFAULT (''),
	`last_ip_address` text,
	`last_region` text,
	`trusted_until` text NOT NULL,
	`revoked_at` text,
	`last_used_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `trusted_devices_id` PRIMARY KEY(`id`),
	CONSTRAINT `trusted_user_device_unique` UNIQUE(`user_id`,`device_id`)
);
--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`user_id` int NOT NULL,
	`role_code` text NOT NULL,
	`effective_from` varchar(191) NOT NULL,
	`effective_to` text,
	`status` text NOT NULL DEFAULT ('pending'),
	`requested_by` int NOT NULL,
	`reviewed_by` int,
	`reviewed_at` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `user_roles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`email` varchar(191) NOT NULL,
	`mobile` text NOT NULL DEFAULT (''),
	`name` text NOT NULL,
	`role` text NOT NULL,
	`factory_id` int,
	`supplier_id` int,
	`organization_name` text NOT NULL DEFAULT (''),
	`account_status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`),
	CONSTRAINT `users_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `warehouses` (
	`id` int AUTO_INCREMENT NOT NULL,
	`code` varchar(191) NOT NULL,
	`name` text NOT NULL,
	`type` varchar(191) NOT NULL,
	`factory_id` int,
	`address` text NOT NULL DEFAULT (''),
	`status` text NOT NULL DEFAULT ('active'),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `warehouses_id` PRIMARY KEY(`id`),
	CONSTRAINT `warehouses_code_unique` UNIQUE(`code`)
);
--> statement-breakpoint
ALTER TABLE `ai_conversations` ADD CONSTRAINT `ai_conversations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_messages` ADD CONSTRAINT `ai_messages_conversation_id_ai_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_operation_drafts` ADD CONSTRAINT `ai_operation_drafts_conversation_id_ai_conversations_id_fk` FOREIGN KEY (`conversation_id`) REFERENCES `ai_conversations`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `ai_operation_drafts` ADD CONSTRAINT `ai_operation_drafts_confirmed_by_users_id_fk` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_exception_id_exceptions_id_fk` FOREIGN KEY (`exception_id`) REFERENCES `exceptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `approvals` ADD CONSTRAINT `approvals_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_user_id_users_id_fk` FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_challenges` ADD CONSTRAINT `auth_challenges_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_credentials` ADD CONSTRAINT `auth_credentials_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `auth_sessions` ADD CONSTRAINT `auth_sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bom_components` ADD CONSTRAINT `bom_components_bom_id_product_boms_id_fk` FOREIGN KEY (`bom_id`) REFERENCES `product_boms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_order_reschedules` ADD CONSTRAINT `core_order_reschedules_core_supplier_order_id_c_de15af857a0ed2f8` FOREIGN KEY (`core_supplier_order_id`) REFERENCES `core_supplier_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_order_reschedules` ADD CONSTRAINT `core_order_reschedules_factory_confirmed_by_users_id_fk` FOREIGN KEY (`factory_confirmed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_order_reschedules` ADD CONSTRAINT `core_order_reschedules_supply_chain_reviewed_by_users_id_fk` FOREIGN KEY (`supply_chain_reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_agreements` ADD CONSTRAINT `core_price_agreements_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_agreements` ADD CONSTRAINT `core_price_agreements_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_change_requests` ADD CONSTRAINT `core_price_change_requests_current_agreement_id_50887df6d9b1647c` FOREIGN KEY (`current_agreement_id`) REFERENCES `core_price_agreements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_change_requests` ADD CONSTRAINT `core_price_change_requests_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_change_requests` ADD CONSTRAINT `core_price_change_requests_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_price_change_requests` ADD CONSTRAINT `core_price_change_requests_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_order_items` ADD CONSTRAINT `core_supplier_order_items_core_supplier_order_i_f723509c11a8c5cf` FOREIGN KEY (`core_supplier_order_id`) REFERENCES `core_supplier_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_order_items` ADD CONSTRAINT `core_supplier_order_items_price_agreement_id_co_639530df3d295ec5` FOREIGN KEY (`price_agreement_id`) REFERENCES `core_price_agreements`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_orders` ADD CONSTRAINT `core_supplier_orders_source_purchase_order_id_p_be7a832068314361` FOREIGN KEY (`source_purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_orders` ADD CONSTRAINT `core_supplier_orders_assembly_factory_id_factories_id_fk` FOREIGN KEY (`assembly_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_orders` ADD CONSTRAINT `core_supplier_orders_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `core_supplier_orders` ADD CONSTRAINT `core_supplier_orders_confirmed_by_users_id_fk` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `defect_catalog` ADD CONSTRAINT `defect_catalog_proposed_by_users_id_fk` FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `defect_catalog` ADD CONSTRAINT `defect_catalog_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `defect_images` ADD CONSTRAINT `defect_images_inspection_defect_id_inspection_defects_id_fk` FOREIGN KEY (`inspection_defect_id`) REFERENCES `inspection_defects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_batches` ADD CONSTRAINT `delivery_batches_execution_order_id_execution_orders_id_fk` FOREIGN KEY (`execution_order_id`) REFERENCES `execution_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_setting_changes` ADD CONSTRAINT `delivery_setting_changes_setting_id_factory_sup_53a6d0327a276471` FOREIGN KEY (`setting_id`) REFERENCES `factory_supplier_delivery_settings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `delivery_setting_changes` ADD CONSTRAINT `delivery_setting_changes_changed_by_users_id_fk` FOREIGN KEY (`changed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_execution_order_id_execution_orders_id_fk` FOREIGN KEY (`execution_order_id`) REFERENCES `execution_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `exceptions` ADD CONSTRAINT `exceptions_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `execution_orders` ADD CONSTRAINT `execution_orders_order_item_id_order_items_id_fk` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `execution_orders` ADD CONSTRAINT `execution_orders_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `execution_orders` ADD CONSTRAINT `execution_orders_bom_id_product_boms_id_fk` FOREIGN KEY (`bom_id`) REFERENCES `product_boms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_change_requests` ADD CONSTRAINT `factory_change_requests_from_factory_id_factories_id_fk` FOREIGN KEY (`from_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_change_requests` ADD CONSTRAINT `factory_change_requests_to_factory_id_factories_id_fk` FOREIGN KEY (`to_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_change_requests` ADD CONSTRAINT `factory_change_requests_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_change_requests` ADD CONSTRAINT `factory_change_requests_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_invoices` ADD CONSTRAINT `factory_invoices_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_invoices` ADD CONSTRAINT `factory_invoices_purchase_order_id_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_invoices` ADD CONSTRAINT `factory_invoices_delivery_batch_id_delivery_batches_id_fk` FOREIGN KEY (`delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_invoices` ADD CONSTRAINT `factory_invoices_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_request_items` ADD CONSTRAINT `factory_payment_request_items_payment_request_i_5a271b353f92023e` FOREIGN KEY (`payment_request_id`) REFERENCES `factory_payment_requests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_request_items` ADD CONSTRAINT `factory_payment_request_items_payment_schedule__88dd176c4d397cb7` FOREIGN KEY (`payment_schedule_id`) REFERENCES `factory_payment_schedules`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_request_items` ADD CONSTRAINT `factory_payment_request_items_purchase_order_id_48b159065f600f15` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_request_items` ADD CONSTRAINT `factory_payment_request_items_triggered_by_deli_54a478a121d2937b` FOREIGN KEY (`triggered_by_delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_requests` ADD CONSTRAINT `factory_payment_requests_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_requests` ADD CONSTRAINT `factory_payment_requests_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_schedules` ADD CONSTRAINT `factory_payment_schedules_purchase_order_id_pur_25f3df85e702189d` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_schedules` ADD CONSTRAINT `factory_payment_schedules_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_schedules` ADD CONSTRAINT `factory_payment_schedules_delivery_batch_id_del_adbdac85e4bea087` FOREIGN KEY (`delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_schedules` ADD CONSTRAINT `factory_payment_schedules_payment_term_id_facto_405a7ee91373a247` FOREIGN KEY (`payment_term_id`) REFERENCES `factory_payment_terms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_schedules` ADD CONSTRAINT `factory_payment_schedules_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_terms` ADD CONSTRAINT `factory_payment_terms_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_payment_terms` ADD CONSTRAINT `factory_payment_terms_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_plan_responses` ADD CONSTRAINT `factory_plan_responses_purchase_plan_id_purchase_plans_id_fk` FOREIGN KEY (`purchase_plan_id`) REFERENCES `purchase_plans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_plan_responses` ADD CONSTRAINT `factory_plan_responses_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_plan_responses` ADD CONSTRAINT `factory_plan_responses_responded_by_users_id_fk` FOREIGN KEY (`responded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_plan_responses` ADD CONSTRAINT `factory_plan_responses_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_supplier_delivery_settings` ADD CONSTRAINT `factory_supplier_delivery_settings_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_supplier_delivery_settings` ADD CONSTRAINT `factory_supplier_delivery_settings_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `factory_supplier_delivery_settings` ADD CONSTRAINT `factory_supplier_delivery_settings_maintained_by_users_id_fk` FOREIGN KEY (`maintained_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_owner_user_id_users_id_fk` FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `file_objects` ADD CONSTRAINT `file_objects_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_file_object_id_file_objects_id_fk` FOREIGN KEY (`file_object_id`) REFERENCES `file_objects`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_committed_by_users_id_fk` FOREIGN KEY (`committed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_batches` ADD CONSTRAINT `import_batches_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `import_staging_rows` ADD CONSTRAINT `import_staging_rows_import_batch_id_import_batches_id_fk` FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_defects` ADD CONSTRAINT `inspection_defects_inspection_id_quality_inspections_id_fk` FOREIGN KEY (`inspection_id`) REFERENCES `quality_inspections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_defects` ADD CONSTRAINT `inspection_defects_defect_id_defect_catalog_id_fk` FOREIGN KEY (`defect_id`) REFERENCES `defect_catalog`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inspection_images` ADD CONSTRAINT `inspection_images_inspection_id_quality_inspections_id_fk` FOREIGN KEY (`inspection_id`) REFERENCES `quality_inspections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory` ADD CONSTRAINT `inventory_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_batches` ADD CONSTRAINT `inventory_batches_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_delivery_batch_id_delivery_batches_id_fk` FOREIGN KEY (`delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_movements` ADD CONSTRAINT `inventory_movements_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_reservations` ADD CONSTRAINT `inventory_reservations_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_reservations` ADD CONSTRAINT `inventory_reservations_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `inventory_transfers_from_warehouse_id_warehouses_id_fk` FOREIGN KEY (`from_warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `inventory_transfers_to_warehouse_id_warehouses_id_fk` FOREIGN KEY (`to_warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `inventory_transfers_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `inventory_transfers` ADD CONSTRAINT `inventory_transfers_approved_by_users_id_fk` FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_exceptions` ADD CONSTRAINT `invoice_exceptions_invoice_id_factory_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `factory_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_exceptions` ADD CONSTRAINT `invoice_exceptions_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_exceptions` ADD CONSTRAINT `invoice_exceptions_risk_released_by_users_id_fk` FOREIGN KEY (`risk_released_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_payment_allocations` ADD CONSTRAINT `invoice_payment_allocations_invoice_id_factory_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `factory_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_payment_allocations` ADD CONSTRAINT `invoice_payment_allocations_payment_request_id__1414da7029500a5d` FOREIGN KEY (`payment_request_id`) REFERENCES `factory_payment_requests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_payment_allocations` ADD CONSTRAINT `invoice_payment_allocations_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_verifications` ADD CONSTRAINT `invoice_verifications_invoice_id_factory_invoices_id_fk` FOREIGN KEY (`invoice_id`) REFERENCES `factory_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `invoice_verifications` ADD CONSTRAINT `invoice_verifications_verified_by_users_id_fk` FOREIGN KEY (`verified_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nonconformance_dispositions` ADD CONSTRAINT `nonconformance_dispositions_inspection_id_quali_c71953bfdb446c20` FOREIGN KEY (`inspection_id`) REFERENCES `quality_inspections`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nonconformance_dispositions` ADD CONSTRAINT `nonconformance_dispositions_confirmed_by_users_id_fk` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `nonconformance_dispositions` ADD CONSTRAINT `nonconformance_dispositions_exception_id_exceptions_id_fk` FOREIGN KEY (`exception_id`) REFERENCES `exceptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_messages` ADD CONSTRAINT `notification_messages_recipient_user_id_users_id_fk` FOREIGN KEY (`recipient_user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_messages` ADD CONSTRAINT `notification_messages_recipient_factory_id_factories_id_fk` FOREIGN KEY (`recipient_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `notification_messages` ADD CONSTRAINT `notification_messages_recipient_supplier_id_suppliers_id_fk` FOREIGN KEY (`recipient_supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_purchase_order_id_purchase_orders_id_fk` FOREIGN KEY (`purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `order_items` ADD CONSTRAINT `order_items_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_records` ADD CONSTRAINT `payment_records_payment_request_id_factory_paym_706233bd059a8132` FOREIGN KEY (`payment_request_id`) REFERENCES `factory_payment_requests`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_records` ADD CONSTRAINT `payment_records_invoice_exception_id_invoice_exceptions_id_fk` FOREIGN KEY (`invoice_exception_id`) REFERENCES `invoice_exceptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_records` ADD CONSTRAINT `payment_records_recorded_by_users_id_fk` FOREIGN KEY (`recorded_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `payment_records` ADD CONSTRAINT `payment_records_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_boms` ADD CONSTRAINT `product_boms_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_boms` ADD CONSTRAINT `product_boms_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_return_dispositions` ADD CONSTRAINT `product_return_dispositions_product_return_id_p_4b3ff4334fdcf82e` FOREIGN KEY (`product_return_id`) REFERENCES `product_returns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_return_dispositions` ADD CONSTRAINT `product_return_dispositions_proposed_by_users_id_fk` FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_return_dispositions` ADD CONSTRAINT `product_return_dispositions_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_return_inspections` ADD CONSTRAINT `product_return_inspections_product_return_id_pr_9c839a0a7f0b5ac0` FOREIGN KEY (`product_return_id`) REFERENCES `product_returns`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_return_inspections` ADD CONSTRAINT `product_return_inspections_inspected_by_users_id_fk` FOREIGN KEY (`inspected_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_returns` ADD CONSTRAINT `product_returns_source_delivery_batch_id_delivery_batches_id_fk` FOREIGN KEY (`source_delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_returns` ADD CONSTRAINT `product_returns_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_returns` ADD CONSTRAINT `product_returns_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_returns` ADD CONSTRAINT `product_returns_proposed_by_users_id_fk` FOREIGN KEY (`proposed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `product_returns` ADD CONSTRAINT `product_returns_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_material_lines` ADD CONSTRAINT `production_material_lines_execution_order_id_ex_dde7c9ee31f81f5e` FOREIGN KEY (`execution_order_id`) REFERENCES `execution_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_material_lines` ADD CONSTRAINT `production_material_lines_bom_component_id_bom_components_id_fk` FOREIGN KEY (`bom_component_id`) REFERENCES `bom_components`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_reports` ADD CONSTRAINT `production_reports_execution_order_id_execution_orders_id_fk` FOREIGN KEY (`execution_order_id`) REFERENCES `execution_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_reports` ADD CONSTRAINT `production_reports_reported_by_users_id_fk` FOREIGN KEY (`reported_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `production_reports` ADD CONSTRAINT `production_reports_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_import_diffs` ADD CONSTRAINT `purchase_import_diffs_purchase_import_id_purchase_imports_id_fk` FOREIGN KEY (`purchase_import_id`) REFERENCES `purchase_imports`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_imports` ADD CONSTRAINT `purchase_imports_matched_purchase_order_id_purchase_orders_id_fk` FOREIGN KEY (`matched_purchase_order_id`) REFERENCES `purchase_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_imports` ADD CONSTRAINT `purchase_imports_imported_by_users_id_fk` FOREIGN KEY (`imported_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_items` ADD CONSTRAINT `purchase_plan_items_purchase_plan_id_purchase_plans_id_fk` FOREIGN KEY (`purchase_plan_id`) REFERENCES `purchase_plans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_items` ADD CONSTRAINT `purchase_plan_items_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_items` ADD CONSTRAINT `purchase_plan_items_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_items` ADD CONSTRAINT `purchase_plan_items_bom_id_product_boms_id_fk` FOREIGN KEY (`bom_id`) REFERENCES `product_boms`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_order_links` ADD CONSTRAINT `purchase_plan_order_links_purchase_plan_item_id_2920864ae38de57d` FOREIGN KEY (`purchase_plan_item_id`) REFERENCES `purchase_plan_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_order_links` ADD CONSTRAINT `purchase_plan_order_links_order_item_id_order_items_id_fk` FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_order_links` ADD CONSTRAINT `purchase_plan_order_links_confirmed_by_users_id_fk` FOREIGN KEY (`confirmed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plan_source_rows` ADD CONSTRAINT `purchase_plan_source_rows_purchase_plan_id_purchase_plans_id_fk` FOREIGN KEY (`purchase_plan_id`) REFERENCES `purchase_plans`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plans` ADD CONSTRAINT `purchase_plans_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `purchase_plans` ADD CONSTRAINT `purchase_plans_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quality_inspections` ADD CONSTRAINT `quality_inspections_execution_order_id_execution_orders_id_fk` FOREIGN KEY (`execution_order_id`) REFERENCES `execution_orders`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quality_inspections` ADD CONSTRAINT `quality_inspections_quality_rule_id_quality_rules_id_fk` FOREIGN KEY (`quality_rule_id`) REFERENCES `quality_rules`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quality_inspections` ADD CONSTRAINT `quality_inspections_submitted_by_users_id_fk` FOREIGN KEY (`submitted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `quality_rules` ADD CONSTRAINT `quality_rules_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `replacement_invoice_links` ADD CONSTRAINT `replacement_invoice_links_invoice_exception_id__e3cfd03b8537a122` FOREIGN KEY (`invoice_exception_id`) REFERENCES `invoice_exceptions`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `replacement_invoice_links` ADD CONSTRAINT `replacement_invoice_links_replacement_invoice_i_d1626588229a9a1a` FOREIGN KEY (`replacement_invoice_id`) REFERENCES `factory_invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_evidence` ADD CONSTRAINT `shipment_evidence_delivery_batch_id_delivery_batches_id_fk` FOREIGN KEY (`delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_receipts` ADD CONSTRAINT `shipment_receipts_delivery_batch_id_delivery_batches_id_fk` FOREIGN KEY (`delivery_batch_id`) REFERENCES `delivery_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `shipment_receipts` ADD CONSTRAINT `shipment_receipts_received_by_users_id_fk` FOREIGN KEY (`received_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sku_factory_defaults` ADD CONSTRAINT `sku_factory_defaults_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sku_factory_defaults` ADD CONSTRAINT `sku_factory_defaults_selected_by_users_id_fk` FOREIGN KEY (`selected_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sku_unit_conversions` ADD CONSTRAINT `sku_unit_conversions_sku_id_skus_id_fk` FOREIGN KEY (`sku_id`) REFERENCES `skus`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_adjustments` ADD CONSTRAINT `stocktake_adjustments_stocktake_id_stocktakes_id_fk` FOREIGN KEY (`stocktake_id`) REFERENCES `stocktakes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_adjustments` ADD CONSTRAINT `stocktake_adjustments_stocktake_count_id_stocktake_counts_id_fk` FOREIGN KEY (`stocktake_count_id`) REFERENCES `stocktake_counts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_adjustments` ADD CONSTRAINT `stocktake_adjustments_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_counts` ADD CONSTRAINT `stocktake_counts_stocktake_id_stocktakes_id_fk` FOREIGN KEY (`stocktake_id`) REFERENCES `stocktakes`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_counts` ADD CONSTRAINT `stocktake_counts_batch_id_inventory_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `inventory_batches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktake_counts` ADD CONSTRAINT `stocktake_counts_counted_by_users_id_fk` FOREIGN KEY (`counted_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakes` ADD CONSTRAINT `stocktakes_warehouse_id_warehouses_id_fk` FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakes` ADD CONSTRAINT `stocktakes_created_by_users_id_fk` FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `stocktakes` ADD CONSTRAINT `stocktakes_assigned_factory_id_factories_id_fk` FOREIGN KEY (`assigned_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_bank_accounts` ADD CONSTRAINT `supplier_bank_accounts_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_contacts` ADD CONSTRAINT `supplier_contacts_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_skus` ADD CONSTRAINT `supplier_skus_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_skus` ADD CONSTRAINT `supplier_skus_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_skus` ADD CONSTRAINT `supplier_skus_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supplier_skus` ADD CONSTRAINT `supplier_skus_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `suppliers` ADD CONSTRAINT `suppliers_managed_by_factory_id_factories_id_fk` FOREIGN KEY (`managed_by_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supply_risk_cases` ADD CONSTRAINT `supply_risk_cases_assembly_factory_id_factories_id_fk` FOREIGN KEY (`assembly_factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supply_risk_cases` ADD CONSTRAINT `supply_risk_cases_source_supplier_id_suppliers_id_fk` FOREIGN KEY (`source_supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `supply_risk_cases` ADD CONSTRAINT `supply_risk_cases_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `trusted_devices` ADD CONSTRAINT `trusted_devices_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_requested_by_users_id_fk` FOREIGN KEY (`requested_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_reviewed_by_users_id_fk` FOREIGN KEY (`reviewed_by`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `users` ADD CONSTRAINT `users_supplier_id_suppliers_id_fk` FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `warehouses` ADD CONSTRAINT `warehouses_factory_id_factories_id_fk` FOREIGN KEY (`factory_id`) REFERENCES `factories`(`id`) ON DELETE no action ON UPDATE no action;