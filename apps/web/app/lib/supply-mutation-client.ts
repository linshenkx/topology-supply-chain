"use client";

import type { SupplyMutationPath } from "./supply-mutation-contract";
import { finalRequestDigest, mutateJson } from "./mutation-client";

type MasterProcurementMethod = "PATCH" | "POST";

export function mutateSupplyWrite<Result, Body extends Record<string, unknown>>(
  path: SupplyMutationPath,
  method: MasterProcurementMethod,
  body: Body,
  options: { digestBody?: Record<string, unknown>; idempotencyKey?: string } = {},
): Promise<Result> {
  return mutateJson<Result, Body>(path, method, body, options);
}

export const supplyImports = {
  preview: <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/imports/preview", "POST", body),
  stage: <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/imports/stage", "POST", body),
  commit: <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/imports/commit", "POST", body),
};

export const writeMasterData = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/master-data", "POST", body);
export const writeSupplier = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/suppliers", "POST", body);
export const writeSupplierSku = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/supplier-skus", "POST", body);
export const writeSupplierPrice = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/supplier-prices", "POST", body);
export const writeSupplierPerformance = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/supplier-performance", "POST", body);
export const createPurchasePlan = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/purchase-plans", "POST", body);
export const updatePurchasePlan = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/purchase-plans", "PATCH", body);
export const createPurchaseOrder = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/purchase-orders", "POST", body);
export const updatePurchaseOrder = <Result>(body: Record<string, unknown>) => mutateSupplyWrite<Result, Record<string, unknown>>("/api/v1/purchase-orders", "PATCH", body);

export async function writeSupplierPriceWithStepUp<Result>(
  body: Record<string, unknown>,
  objectVersion: number,
  requestCode: (destination: string) => Promise<string | null>,
): Promise<Result> {
  const payload = { ...body, objectVersion };
  const requestDigest = await finalRequestDigest({ command: "supplier-prices.write", payload });
  const challenge = await mutateJson<{ challengeNo: string; mobile?: string; previewCode?: string }, Record<string, unknown>>(
    "/api/v1/auth/step-up/request",
    "POST",
    { action: "supplier_price.activate", objectType: "r2:supplier_price", objectId: `${body.supplierId}:${body.sku}`, objectVersion, requestDigest },
  );
  const code = challenge.previewCode ?? await requestCode(challenge.mobile ?? "绑定手机");
  if (code === null) throw new Error("已取消手机验证");
  await mutateJson("/api/v1/auth/step-up/verify", "POST", { challengeNo: challenge.challengeNo, code });
  return mutateSupplyWrite<Result, Record<string, unknown>>(
    "/api/v1/supplier-prices",
    "POST",
    { ...payload, challengeNo: challenge.challengeNo },
    { digestBody: payload },
  );
}
