-- Integration-owner hook. Apply through the shared migration owner, then enable
-- only after legacy writes are drained and the Fastify manifest is deployed.
INSERT INTO `writer_fences` (`resource`, `owner`, `enabled`, `generation`, `updated_at`) VALUES
  ('r2.imports.preview', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.imports.stage', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.imports.commit', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.master-data.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.suppliers.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-skus.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-prices.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.supplier-performance.write', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-plans.create', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-plans.update', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-orders.create', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3)),
  ('r2.purchase-orders.update', 'fastify-v1', false, 2, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
  `owner` = VALUES(`owner`), `enabled` = false,
  `generation` = VALUES(`generation`), `updated_at` = CURRENT_TIMESTAMP(3);
