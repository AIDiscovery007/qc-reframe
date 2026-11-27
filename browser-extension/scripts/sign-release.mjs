// Signs a release's SHA256SUMS with the Ed25519 key in RELEASE_SIGNING_KEY (PKCS8 PEM) and prints the base64 signature:
//   RELEASE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-release.mjs .output/SHA256SUMS > .output/SHA256SUMS.sig
// The signature is checked against the public key embedded in scripts/install.sh before it is printed, so a release can
// never ship with a signature that installed copies reject. Only the release workflow holds the key.
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The public key that the given installer script trusts. */
export function installerSigningKey(script) {
  const keys = [...script.matchAll(/^\s*local signing_key="([A-Za-z0-9+/]+={0,2})"$/gm)];
  if (keys.length !== 1) throw new Error("scripts/install.sh 中应有且只有一个 signing_key。");
  const key = createPublicKey({ key: Buffer.from(keys[0][1], "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("scripts/install.sh 的 signing_key 不是 Ed25519 公钥。");
  return key;
}

/** The base64 signature line for `sums`, refused unless `trusted` accepts it. */
export function signChecksums(sums, privatePem, trusted) {
  if (!privatePem) throw new Error("缺少 RELEASE_SIGNING_KEY：请在仓库的 Actions secrets 中设置发布签名私钥。");
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RELEASE_SIGNING_KEY 不是 Ed25519 私钥。");
  const signature = sign(null, Buffer.from(sums), key);
  if (!verify(null, Buffer.from(sums), trusted, signature)) throw new Error("RELEASE_SIGNING_KEY 与 scripts/install.sh 内置的公钥不匹配。");
  return `${signature.toString("base64")}\n`;
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("用法：node scripts/sign-release.mjs <SHA256SUMS>");
    const installer = join(dirname(fileURLToPath(import.meta.url)), "install.sh");
    process.stdout.write(signChecksums(await readFile(process.argv[2]), process.env.RELEASE_SIGNING_KEY, installerSigningKey(await readFile(installer, "utf8"))));
  } catch (error) { console.error(`QC-Reframe 发布签名失败：${error.message}`); process.exitCode = 1; }
}
