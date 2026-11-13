import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Names the store accepts. Anything else is rejected so callers cannot stash arbitrary data. */
export const SECRET_NAMES = ['HIERO_LLM_TOKENS', 'HIERO_LLM_PROVIDERS', 'HIERO_BRAVE_API_KEY'] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

interface SealedValue {
  iv: string;
  tag: string;
  data: string;
}

interface SecretFile {
  version: 1;
  secrets: Partial<Record<SecretName, SealedValue>>;
}

export function isSecretName(name: string): name is SecretName {
  return (SECRET_NAMES as readonly string[]).includes(name);
}

/**
 * Hiero-only encrypted secret store.
 * Values are sealed with AES-256-GCM. The master key lives in a separate file (owner-only permissions)
 * so the ciphertext file alone is not enough to read secrets. This protects against accidental disclosure
 * (copying the config folder, committing it, screen-sharing the file). It does not defend against
 * an attacker who already runs code as the same user.
 */
export class SecretStore {
  constructor(private readonly dir: string = join(homedir(), '.hiero')) {}

  private get filePath(): string {
    return join(this.dir, 'secrets.enc.json');
  }

  private get keyPath(): string {
    return join(this.dir, 'secrets.key');
  }

  /** Returns the master key, creating it on first use. */
  private masterKey(create: boolean): Buffer | undefined {
    if (existsSync(this.keyPath)) return Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64');
    if (!create) return undefined;
    mkdirSync(this.dir, { recursive: true });
    const key = randomBytes(32);
    writeFileSync(this.keyPath, key.toString('base64') + '\n', { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(this.keyPath, 0o600); } catch { /* Windows ignores POSIX modes; ACLs still apply */ }
    return key;
  }

  private readFile(): SecretFile {
    if (!existsSync(this.filePath)) return { version: 1, secrets: {} };
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as SecretFile;
    return { version: 1, secrets: parsed.secrets ?? {} };
  }

  private writeFile(file: SecretFile): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.filePath);
  }

  /** Names of secrets that currently have a value. Never returns values. */
  list(): SecretName[] {
    const file = this.readFile();
    return SECRET_NAMES.filter((name) => file.secrets[name] !== undefined);
  }

  has(name: SecretName): boolean {
    return this.readFile().secrets[name] !== undefined;
  }

  get(name: SecretName): string | undefined {
    const sealed = this.readFile().secrets[name];
    if (!sealed) return undefined;
    const key = this.masterKey(false);
    if (!key) throw new Error('Secret store key is missing; secrets cannot be decrypted.');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8');
  }

  set(name: SecretName, value: string): void {
    if (!isSecretName(name)) throw new Error(`Unknown secret name: ${name}`);
    const key = this.masterKey(true);
    if (!key) throw new Error('Secret store key could not be created.');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const file = this.readFile();
    file.secrets[name] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
    this.writeFile(file);
  }

  delete(name: SecretName): boolean {
    const file = this.readFile();
    if (file.secrets[name] === undefined) return false;
    delete file.secrets[name];
    this.writeFile(file);
    return true;
  }
}
