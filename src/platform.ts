import { t } from './locale';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile, rename, chmod, open, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { LOCAL } from './config';

export async function run(command: string[], input?: string | Buffer, cwd?: string): Promise<string> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command[0]!, command.slice(1), { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', b => out.push(b));
    child.stderr.on('data', b => err.push(b));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolveResult(Buffer.concat(out).toString('utf8')) : reject(new Error(`${command[0]}: ${Buffer.concat(err).toString('utf8').slice(-1200) || `exit code ${code}`}`)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function openBrowser(url: string) {
  // The URL is a separate process argument. No shell interpolation or credential-bearing logging.
  let child;
  if (process.platform === 'win32') child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { windowsHide: true, stdio: 'ignore' });
  else child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

async function protect(value: string, decrypt = false): Promise<string> {
  if (process.platform !== 'win32') return value;
  const operation = decrypt
    ? '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : '[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Convert]::FromBase64String($v),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); [Console]::Out.Write(${operation})`;
  const result = await run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], decrypt ? value : Buffer.from(value).toString('base64'));
  return decrypt ? Buffer.from(result, 'base64').toString('utf8') : result;
}

export interface Account {
  clientId: string; subject: string; email?: string; issuer: string;
  accessToken: string; refreshToken?: string; idToken?: string; expiresAt: number; scopes: string[];
}
export interface Credentials { hostId?: string; discordToken?: string; account?: Account; registration?: Pick<Account, 'clientId' | 'subject' | 'issuer' | 'email'> }

export class CredentialStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path = resolve(LOCAL, process.platform === 'win32' ? 'credentials.dpapi' : 'credentials.json')) {}
  async read(): Promise<Credentials> {
    try { return JSON.parse(await protect(await readFile(this.path, 'utf8'), true)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new Error(t("Cannot read local credentials. Run as the same OS user.")); }
  }
  update(change: (value: Credentials) => Credentials | Promise<Credentials>): Promise<void> {
    const task = this.queue.then(async () => {
      const value = await change(await this.read());
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temp, await protect(JSON.stringify(value)), { mode: 0o600 });
        if (process.platform === 'win32') {
          const user = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
          await run(['icacls.exe', temp, '/inheritance:r', '/grant:r', `${user}:(F)`]);
        } else await chmod(temp, 0o600);
        await rename(temp, this.path);
      } finally { await rm(temp, { force: true }); }
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

export async function acquireLock(name = 'runtime') {
  if (!/^[a-z-]{1,30}$/.test(name)) throw new Error(t("Invalid lock name"));
  await mkdir(LOCAL, { recursive: true });
  const path = resolve(LOCAL, `${name}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const file = await open(path, 'wx', 0o600);
      await file.writeFile(String(process.pid));
      await file.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = Number(await readFile(path, 'utf8'));
      let running = false;
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, 0); running = true; } catch {} }
      if (running) throw new Error(t("A bot or setup process is already running. Stop it first."));
      await rm(path, { force: true });
    }
  }
  throw new Error(t("Could not acquire the runtime lock."));
}
