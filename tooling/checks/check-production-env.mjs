import { ENVIRONMENT_CONTRACT } from "./environment-contract.mjs";

const required = Object.entries(ENVIRONMENT_CONTRACT)
  .filter(([, contract]) => contract.requiredProduction)
  .map(([name]) => name);
const placeholder = /<|replace|example|configure|changeme|请填写|请生成|占位/iu;
const errors = [];

for (const name of required) {
  const value = process.env[name]?.trim();
  if (!value) errors.push(`${name} 未配置`);
  else if (placeholder.test(value)) errors.push(`${name} 仍是示例值`);
}
if (process.env.PROJECT_ROOT !== "/opt/topology-scm-v2") {
  errors.push("PROJECT_ROOT 必须为 /opt/topology-scm-v2");
}
if (!/^mysql:\/\//u.test(process.env.DATABASE_URL ?? "")) {
  errors.push("DATABASE_URL 必须使用 mysql://");
}
if ((process.env.API_SESSION_SIGNING_KEY?.length ?? 0) < 32) {
  errors.push("API_SESSION_SIGNING_KEY 至少需要 32 个字符");
}
if (!/^[a-f\d]{64}$/iu.test(process.env.OTP_SEALING_KEY ?? "")) {
  errors.push("OTP_SEALING_KEY 必须是 32 字节十六进制密钥");
}
if ((process.env.LOCAL_FIXTURE_PASSWORD?.length ?? 0) < 12) {
  errors.push("LOCAL_FIXTURE_PASSWORD 至少需要 12 个字符");
}

if (errors.length > 0) {
  console.error("UAT 环境配置检查失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("UAT 环境配置检查通过，未输出任何密钥值。");
}
