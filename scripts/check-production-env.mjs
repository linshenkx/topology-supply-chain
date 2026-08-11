const required = [
  "APP_BASE_URL",
  "SESSION_SECRET",
  "API_SESSION_SIGNING_KEY",
  "JOB_TOKEN",
  "DATABASE_URL",
  "OSS_REGION",
  "OSS_BUCKET",
  "OTP_SEALING_KEY_ID",
  "OTP_SEALING_KEY",
  "OTP_SEALING_KEYS_JSON",
];

const placeholder = /replace|example|configure|changeme|请填写|请生成|占位/i;
const errors = [];
for (const name of required) {
  const value = process.env[name]?.trim();
  if (!value) errors.push(`${name} 未配置`);
  else if (placeholder.test(value)) errors.push(`${name} 仍是示例值`);
}

const roleName = process.env.OSS_ECS_RAM_ROLE?.trim();
const accessKeyId = process.env.OSS_ACCESS_KEY_ID?.trim();
const accessKeySecret = process.env.OSS_ACCESS_KEY_SECRET?.trim();
if (!roleName && !(accessKeyId && accessKeySecret)) {
  errors.push("必须配置OSS_ECS_RAM_ROLE，或同时配置OSS_ACCESS_KEY_ID与OSS_ACCESS_KEY_SECRET");
}

for (const [urlName, keyName, healthName] of [
  ["SMS_WEBHOOK_URL", "SMS_WEBHOOK_API_KEY", "SMS_WEBHOOK_HEALTH_URL"],
  ["EMAIL_WEBHOOK_URL", "EMAIL_WEBHOOK_API_KEY", "EMAIL_WEBHOOK_HEALTH_URL"],
  ["FILE_SCAN_WEBHOOK_URL", "FILE_SCAN_WEBHOOK_API_KEY", "FILE_SCAN_WEBHOOK_HEALTH_URL"],
]) {
  const url = process.env[urlName]?.trim();
  const key = process.env[keyName]?.trim();
  const health = process.env[healthName]?.trim();
  if (!url || !key || !health) errors.push(`${urlName}、${keyName}与${healthName}必须全部配置`);
}
if (!/^[a-f\d]{64}$/iu.test(process.env.OTP_SEALING_KEY ?? "")) errors.push("OTP_SEALING_KEY必须是32字节十六进制密钥");
try {
  const keys = JSON.parse(process.env.OTP_SEALING_KEYS_JSON ?? "");
  if (keys?.[process.env.OTP_SEALING_KEY_ID] !== process.env.OTP_SEALING_KEY) throw new Error();
} catch { errors.push("OTP_SEALING_KEYS_JSON必须包含当前OTP_SEALING_KEY_ID及对应密钥"); }

if (process.env.APP_BASE_URL !== "https://scm.topologygz.com") {
  errors.push("APP_BASE_URL 必须为 https://scm.topologygz.com");
}
if ((process.env.SESSION_SECRET?.length ?? 0) < 32) {
  errors.push("SESSION_SECRET 至少需要32个字符");
}
if ((process.env.API_SESSION_SIGNING_KEY?.length ?? 0) < 32) {
  errors.push("API_SESSION_SIGNING_KEY 至少需要32个字符");
}
if (process.env.API_SESSION_SIGNING_KEY === process.env.SESSION_SECRET) {
  errors.push("API_SESSION_SIGNING_KEY 与 SESSION_SECRET 必须使用不同随机值");
}
if ((process.env.JOB_TOKEN?.length ?? 0) < 32) {
  errors.push("JOB_TOKEN 至少需要32个字符");
}
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET === process.env.JOB_TOKEN) {
  errors.push("SESSION_SECRET与JOB_TOKEN必须使用不同随机值");
}
if (process.env.DATABASE_URL && !process.env.DATABASE_URL.startsWith("mysql://")) {
  errors.push("DATABASE_URL 必须使用mysql:// RDS MySQL连接串");
}
if (process.env.OSS_BUCKET && /[A-Z_]/.test(process.env.OSS_BUCKET)) {
  errors.push("OSS_BUCKET名称只能使用小写字母、数字和连字符");
}

if (errors.length) {
  console.error("生产环境配置检查失败：");
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log("生产环境配置检查通过，未输出任何密钥值。");
}
