import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import type { Store, Vault } from "@splitin/spiderman-core";
interface SecretRow {
  id: string;
  owner: string;
  iv: string;
  tag: string;
  ciphertext: string;
  expiresAt?: number;
}
export class EncryptedVault implements Vault {
  constructor(
    readonly store: Store,
    readonly key: Buffer,
    readonly now = () => Date.now(),
  ) {
    if (key.length !== 32) throw new Error("vault_key_must_be_32_bytes");
  }
  async put(owner: string, key: string, value: unknown, expiresAt?: number) {
    const id = createHash("sha256")
        .update(owner + "\0" + key)
        .digest("hex"),
      iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(owner + "\0" + id));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const row: SecretRow = {
      id,
      owner,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      expiresAt,
    };
    await this.store.transaction((tx) => tx.put("secret", id, owner, row));
    return id;
  }
  async get<T>(owner: string, ref: string): Promise<T> {
    const row = await this.store.transaction((tx) =>
      tx.get<SecretRow>("secret", ref),
    );
    if (
      !row ||
      row.owner !== owner ||
      (row.expiresAt !== undefined && row.expiresAt <= this.now())
    )
      throw new Error("secret_unavailable");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(row.iv, "base64"),
    );
    decipher.setAAD(Buffer.from(owner + "\0" + ref));
    decipher.setAuthTag(Buffer.from(row.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, "base64")),
        decipher.final(),
      ]).toString(),
    ) as T;
  }
  async delete(owner: string, ref: string) {
    await this.store.transaction(async (tx) => {
      const row = await tx.get<SecretRow>("secret", ref);
      if (row?.owner === owner) await tx.remove("secret", ref);
    });
  }
  async purge() {
    return this.store.transaction(async (tx) => {
      let n = 0;
      for (const row of await tx.list<SecretRow>("secret")) {
        if (row.expiresAt !== undefined && row.expiresAt <= this.now()) {
          await tx.remove("secret", row.id);
          n++;
        }
      }
      return n;
    });
  }
}
export function masterKey(profile = "default", create = false): Buffer {
  const entry = new Entry("net.splitin.spiderman", profile);
  let value = entry.getPassword();
  if (!value && create) {
    value = randomBytes(32).toString("hex");
    entry.setPassword(value);
  }
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("keychain_master_key_missing");
  return Buffer.from(value, "hex");
}
export function apiToken(profile = "default", create = false): string {
  const entry = new Entry("net.splitin.spiderman.api", profile);
  let value = entry.getPassword();
  if (!value && create) {
    value = randomBytes(32).toString("hex");
    entry.setPassword(value);
  }
  if (!value) throw new Error("keychain_api_token_missing");
  return value;
}
