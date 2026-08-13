# Tier 1 请求模板与数据库证据

以下是当前 Contracts/handler 已固化的字段名，`${…}` 均须来自已 ready 的 fixture manifest；它们不是可直接造数的示例。共同前置：Tier 1 就绪、HTTPS 同源 session/CSRF、每请求唯一 `idempotency-key`、准确 `Origin`/Host，R2 可选 `x-request-digest`。R2/R3 成功响应均应含 `command.command`、`command.idempotencyKey`、`command.requestDigest`、`command.replayed`；首发应为 `replayed:false`，字节等同重放才允许 `true`。

通用 curl 形状（cookie jar 必须只在内存，不写 `jar.txt`）：

```text
METHOD https://<loopback-origin>/api/v1/<path>
Origin: https://<loopback-origin>
Cookie: topology_session=<in-memory>; topology_csrf=<in-memory>
x-csrf-token: <same in-memory csrf value>
idempotency-key: ${RUN_ID}-${SCENARIO}-${N}
Content-Type: application/json
```

每个成功写入至少查询本 `RUN_ID` 的业务实体、`audit_logs`（actor/action/module/entity）和 `outbox_messages`（aggregate/topic/status）；没有 fixture 支持的 action 一律 `BLOCKED`，不可只发请求碰运气。

## R2（成功码 / 模板 / 查询对象）

| 方法与路径 | 成功码 | body 模板（字段名） | 业务查询对象 |
| --- | --- | --- | --- |
| `POST /imports/preview` | 200 | `{type,fileName,fingerprint,sheets:[{name,rows:[…]}]}` | import preview audit |
| `POST /imports/stage` | 201 | `{type,fileObjectId,fileName,fingerprint,rows,errors:[],warnings:[],businessKey?}` | `import_batches`,`import_staging_rows` |
| `POST /imports/commit` | 200/202 | `{batchId,supplierMappings?:[{stagingRowId,tier,managedByFactoryId?,businessLicenseFileKey,legalName,unifiedSocialCreditCode,address,contactName,contactPhone,businessScope}],confirmDuplicate?}` | batch、supplier、approval；非 supplier 类型当前应为 `202 awaitingMapping`，不杜撰后续 mapping |
| `POST /master-data` | 201 | SKU：`{action:"create_sku",code,name,itemType,stockUnit,overproductionTolerance,purchaseOverTolerance,purchaseUnderTolerance,purchaseUnit?,purchaseUnitQuantity?,stockUnitQuantity?,effectiveFrom?}`；BOM：`{action:"create_bom",finishedSku,version,effectiveFrom,effectiveTo?,overlapAllowed?,overlapReason?,components:[{componentSku,isCore?,quantityPerFinished,issueTolerance,consumptionTolerance,lossTolerance}]}` | `skus` 或 `product_boms`、approval |
| `POST /suppliers` | 201 | `{code,name,tier,managedByFactoryId?,unifiedSocialCreditCode,businessLicenseFileKey,address,contactName,contactPhone,businessScope}` | `suppliers`、approval |
| `POST /supplier-skus` | 200/201 | `{factoryId,supplierId,sku,effectiveFrom,isPrimary?,priority?,minimumOrderQuantity?,packagingMultiple?,purchaseUnit?,leadTimeDays?,dailyCapacity?,monthlyCapacity?}` | `supplier_skus`,`resource_versions`、approval |
| `POST /supplier-prices` | 201 | `{supplierId,sku,taxIncludedMinor,taxExcludedMinor,taxRateBps,effectiveFrom,reason,evidenceFileKey,objectVersion?,challengeNo?}` | price agreement/change request、`resource_versions`、approval |
| `POST /supplier-performance` | 200 | review：`{action:"review",supplierId,quarter,reviewType,score,tags?,comment?}`；weights：`{action:"weights",tier,effectiveFrom,delivery,quality,exception,preparation,satisfaction,sampling}` | performance review/weight、Outbox |
| `POST /purchase-plans` | 201 | `{planNo,sourceFileKey?,items:[{expectedArrivalDate,factoryId,warehouseId,sku,productName,bomId,plannedQuantity}]}` | plan/item、approval/reminder |
| `PATCH /purchase-plans` | 200 | finalize：`{id,expectedUpdatedAt,action:"finalize_ordering"}`；factory：`{id,expectedUpdatedAt,decision:"confirmed"|"unable",expectedStartDate,expectedFinishDate,proposedArrivalDate?,reason?}` | plan/item、factory response、approval |
| `POST /purchase-orders` | 201 | `{orderNo,orderDate,sourceFileKey?,items:[{planItemId,supplierId,quantity,dueDate,sku,productName,itemType,unitPriceTaxIncludedMinor?}]}` | order/item/link、approval/reminder |
| `PATCH /purchase-orders` | 200 | `{id,expectedUpdatedAt,decision:"confirmed"|"unable",proposedDueDate?,reason?}` | order、factory scope、approval |

R2 route body schema在 Contracts 中目前是 generic JSON；上表提取自现有 handler，不替代版本化 fixture。所有合法 `reviewType` 需以 fixture owner 对应当前 handler/测试 SHA 核对；缺失则该动作 `BLOCKED`。

## R3（Contracts action 模板）

| 方法与路径 | 成功码 | 当前 body 模板 | 查询对象 |
| --- | --- | --- | --- |
| `POST /approvals` | 200 | `{id,decision:"approved"|"rejected",comment?,challengeNo?}` | approval/version/effect、audit/outbox |
| `POST /inventory` | 201 | `{batchId,entityType:"purchase_order"|"production_order"|"shipment_plan"|"historical",entityId?,requestedQuantity,priority?}` | reservation、batch |
| `POST /inventory/transfers` | 201 | `{fromWarehouseId,toWarehouseId,sku,quantity,reason}` | transfer/batch |
| `PATCH /inventory/transfers` | 200 | `{id,action:"ship"|"receive"}` | transfer/status |
| `POST /production-orders` | 201 | `{orderItemId,factoryId,bomId,plannedQuantity,plannedStartDate,plannedFinishDate,dueDate?}` | production order |
| `PATCH /production-orders` | 200 | start：`{id,action:"start"}`；materials：`{id,action:"materials",materials:[{id,issuedQuantity,consumedQuantity,lossQuantity}]}`；complete：`{id,action:"complete",actualFinishedQuantity,companyInventoryQuantity?,factoryOwnedQuantity?,materials?}` | order/material rows |
| `POST /quality-inspections` | 201 | `{executionOrderId,stage,inspectionMethod,batchQuantity,inspectedQuantity,passedQuantity,failedQuantity,inspectorType,defectReason?,requestedResult?,sourceInspectionId?}` | quality record |
| `POST /stocktakes` | 201 | `{warehouseId,scope,dueDate,assignedFactoryId?,skus?,batchIds?}` | stocktake/targets |
| `PATCH /stocktakes` | 200 | count：`{id,action:"submit_count",batchId?,sku,availableQuantity,lockedQuantity,defectiveQuantity,pendingInspectionQuantity}`；finish：`{id,action:"finish_round",estimatedProductionDate?,estimatedExpiryDate?}` | counts/status |
| `POST /shipments` | 201/200 | create：`{action:"create",executionOrderId,batchNo,quantity,plannedShipAt,destination}`；confirm：`{action:"confirm",deliveryBatchId}`；ship：`{action:"ship",deliveryBatchId,shippedAt,carrier,logisticsNo,evidenceFileId,deviationReason?,evidenceFileName?}`；receive：`{action:"receive",deliveryBatchId,receivedQuantity,damagedQuantity,receivedAt,receiptEvidenceFileId,exceptionReason?}`；resolve：`{action:"resolve_exception",exceptionId,resolution}` | shipment/receipt/exception |
| `POST /returns` | 201/200 | receive：`{action:"receive",returnNo,sourceDeliveryBatchId,warehouseId,quantity}`；inspect：`{action:"inspect",productReturnId,inspectedQuantity,passedQuantity,failedQuantity,evidenceFileId,defectReason?}`；propose：`{action:"propose",productReturnId,dispositions:[{type,quantity}]}`；review：`{action:"review",productReturnId,decision}` | return/inspection/disposition |
| `POST /finance` | 201/200 | create：`{action:"create_invoice",factoryId,purchaseOrderId,invoiceNo,invoiceType,coverageMode,deliveryBatchId?,amountTaxIncludedMinor,taxAmountMinor,expectedAmountMinor?,issuedAt,fileId}`；verify：`{action:"verify_invoice",invoiceId,verifierRole,decision,rejectionReason?}`；pay：`{action:"record_payment",paymentRequestId,amountMinor,paidAt,bankReference,challengeNo}`；invalidate：`{action:"invalidate_invoice",invoiceId,exceptionType,reason,replacementDeadline}`；link：`{action:"link_replacement_invoice",invoiceExceptionId,replacementInvoiceId,coveredAmountMinor}`；refund：`{action:"record_refund",invoiceExceptionId,paymentRequestId,amountMinor,paidAt,bankReference,challengeNo}`；correct：`{action:"request_record_correction",paymentRecordId,reason,challengeNo,proposedPaymentRequestId?,proposedAmountMinor?,proposedPaidAt?,proposedBankReference?}`；release：`{action:"release_invoice_risk",invoiceExceptionId,reason,evidenceFileId,challengeNo}` | invoice/payment/exception/allocation |
| `POST /warehouses` | 201/200 | create：`{action:"create",code,name,type,factoryId?,address?}`；merge：`{action:"request_merge",id,targetId,reason}`；deactivate：`{action:"deactivate",id}` | warehouse/approval |

财务的逐 action 最小对象、生产/质检/发货/退货的合法状态前置不是统一 fixture；fixture manifest 必须为本次目标 action 给出所有字段和状态，否则标 `BLOCKED`。这不是 Scope B 行为的定义。
