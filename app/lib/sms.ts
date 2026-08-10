import Dysmsapi20170525, { SendSmsRequest } from "@alicloud/dysmsapi20170525";
import { $OpenApiUtil } from "@alicloud/openapi-core";
import { getEcsRamRoleCredential } from "./oss-store";
import { runtimeEnv } from "./runtime-env";

type SmsPurpose = "login" | "high-risk";

function configured(name: string) {
  const value = runtimeEnv(name);
  if (!value) throw new Error(`短信服务缺少 ${name} 配置。`);
  return value;
}

async function sendWithAliyun(input: { mobile: string; code: string; purpose: SmsPurpose }) {
  const roleName = runtimeEnv("SMS_ECS_RAM_ROLE") ?? runtimeEnv("OSS_ECS_RAM_ROLE");
  if (!roleName) throw new Error("短信服务缺少 ECS RAM 角色配置。");

  const credential = await getEcsRamRoleCredential(roleName);
  const client = new Dysmsapi20170525(new $OpenApiUtil.Config({
    accessKeyId: credential.accessKeyId,
    accessKeySecret: credential.accessKeySecret,
    securityToken: credential.securityToken,
    endpoint: "dysmsapi.aliyuncs.com",
    regionId: runtimeEnv("SMS_REGION_ID") ?? "cn-hangzhou",
    connectTimeout: 10_000,
    readTimeout: 10_000,
  }));
  const response = await client.sendSms(new SendSmsRequest({
    phoneNumbers: input.mobile,
    signName: configured("ALIYUN_SMS_SIGN_NAME"),
    templateCode: configured("ALIYUN_SMS_TEMPLATE_CODE"),
    templateParam: JSON.stringify({ code: input.code }),
    outId: `topology-scm-${input.purpose}`,
  }));

  if (response.body?.code !== "OK") {
    throw new Error(`阿里云短信发送失败：${response.body?.code ?? "UNKNOWN"} ${response.body?.message ?? ""}`.trim());
  }
}

async function sendWithWebhook(input: { mobile: string; code: string; purpose: SmsPurpose }) {
  const response = await fetch(configured("SMS_WEBHOOK_URL"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": runtimeEnv("SMS_WEBHOOK_API_KEY") ?? "",
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`短信 Webhook 返回 ${response.status}。`);
}

export function isSmsConfigured() {
  return Boolean(
    (runtimeEnv("ALIYUN_SMS_SIGN_NAME") && runtimeEnv("ALIYUN_SMS_TEMPLATE_CODE")) ||
    runtimeEnv("SMS_WEBHOOK_URL"),
  );
}

export async function sendVerificationSms(input: { mobile: string; code: string; purpose: SmsPurpose }) {
  if (runtimeEnv("ALIYUN_SMS_SIGN_NAME") && runtimeEnv("ALIYUN_SMS_TEMPLATE_CODE")) {
    await sendWithAliyun(input);
    return;
  }
  if (runtimeEnv("SMS_WEBHOOK_URL")) {
    await sendWithWebhook(input);
    return;
  }
  throw new Error("短信服务尚未配置。");
}
