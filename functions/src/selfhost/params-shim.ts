/**
 * Drop-in for `firebase-functions/params`: parameters resolve from plain
 * environment variables instead of Cloud Secret Manager. `defineSecret()`
 * is called at module load in ~10 files, so this shim is required for the
 * index.ts barrel to boot at all.
 *
 * Secrets for the selfhost process are provided as env vars of the same
 * name (systemd EnvironmentFile / compose env_file). `.value()` throws on
 * missing values just like the real SecretParam does outside a function
 * that declared the secret — a loud failure beats an empty string flowing
 * into an encryption key.
 */

export class SecretParam {
  constructor(public readonly name: string) {}

  value(): string {
    const v = process.env[this.name];
    if (v === undefined) {
      throw new Error(
        `selfhost params-shim: secret "${this.name}" not set in environment`,
      );
    }
    return v;
  }
}

export function defineSecret(name: string): SecretParam {
  return new SecretParam(name);
}

class Param<T> {
  constructor(
    public readonly name: string,
    private readonly parse: (raw: string) => T,
    private readonly fallback?: T,
  ) {}

  value(): T {
    const v = process.env[this.name];
    if (v === undefined) {
      if (this.fallback !== undefined) return this.fallback;
      throw new Error(`selfhost params-shim: param "${this.name}" not set`);
    }
    return this.parse(v);
  }
}

interface ParamOptions<T> {
  default?: T;
}

export function defineString(name: string, opts?: ParamOptions<string>) {
  return new Param(name, (s) => s, opts?.default);
}

export function defineInt(name: string, opts?: ParamOptions<number>) {
  return new Param(name, (s) => parseInt(s, 10), opts?.default);
}

export function defineBoolean(name: string, opts?: ParamOptions<boolean>) {
  return new Param(name, (s) => s === "true", opts?.default);
}
