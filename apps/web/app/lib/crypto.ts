const encoder = new TextEncoder();

const toHex = (bytes: ArrayBuffer) => Array.from(new Uint8Array(bytes)).map(value => value.toString(16).padStart(2, "0")).join("");

export async function hashPassword(password: string, saltHex: string) {
  const salt = new Uint8Array(saltHex.match(/.{1,2}/g)?.map(value => Number.parseInt(value, 16)) ?? []);
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  return toHex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210000 }, key, 256));
}

export function newSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes).map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function hashSecret(value: string) {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function randomDigits(length = 6) {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, value => String(value % 10)).join("");
}

export function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(value => value.toString(16).padStart(2, "0")).join("");
}
