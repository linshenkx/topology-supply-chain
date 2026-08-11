import { createCipheriv, randomBytes } from "node:crypto";

export interface OtpSealingConfig {
  key: Buffer;
  keyId: string;
}

export function readOtpSealingConfig(
  environment: Readonly<Record<string, string | undefined>>,
): OtpSealingConfig {
  const keyId = environment.OTP_SEALING_KEY_ID?.trim();
  const encoded = environment.OTP_SEALING_KEY?.trim();
  if (!keyId || !encoded || !/^[a-f\d]{64}$/iu.test(encoded)) {
    throw new Error("OTP_SEALING_KEY_ID and a 32-byte hexadecimal OTP_SEALING_KEY are required");
  }
  return { keyId, key: Buffer.from(encoded, "hex") };
}

export function sealOtp(config: OtpSealingConfig, code: string): Record<string, string> {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  const ciphertext = Buffer.concat([cipher.update(code, "utf8"), cipher.final()]);
  return {
    keyId: config.keyId,
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  };
}
