import { createHash, scrypt } from "node:crypto";
import { HttpException } from "@nestjs/common";
import type { DatabaseService } from "./database.service.js";

export class RateLimitError extends HttpException {
  constructor(
    readonly retryAfter: number,
    message = "请求过于频繁，请稍后重试",
  ) {
    super({ statusCode: 429, message, retryAfter }, 429);
  }
}

// Bound CPU/memory use; never queue an unbounded number of password jobs.
let passwordJobs = 0;
export const passwordOptions = {
  N: 65_536,
  r: 8,
  p: 2,
  maxmem: 128 * 1024 * 1024,
};
export async function derivePassword(
  password: string,
  salt: string,
  modern = true,
) {
  if (passwordJobs >= 4) throw new RateLimitError(2);
  passwordJobs++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        modern ? passwordOptions : {},
        (error, value) => (error ? reject(error) : resolve(value)),
      ),
    );
  } finally {
    passwordJobs--;
  }
}

export class LoginProtection {
  static readonly windowMs = 15 * 60_000;
  constructor(private database: DatabaseService) {}
  private keys(username: string, ip: string) {
    const digest = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const name = username.trim().normalize("NFKC").toLowerCase();
    return [
      { key: "account:" + digest(name), threshold: 5 },
      { key: "ip:" + digest(ip), threshold: 20 },
    ];
  }
  check(username: string, ip: string, now = Date.now()) {
    for (const { key } of this.keys(username, ip)) {
      const row = this.database.connection
        .prepare("SELECT locked_until FROM login_attempts WHERE key=?")
        .get(key) as { locked_until: number } | undefined;
      if (row && row.locked_until > now)
        throw new RateLimitError(
          Math.ceil((row.locked_until - now) / 1000),
          "登录尝试过多，账号或 IP 已暂时锁定，请稍后重试",
        );
    }
  }
  fail(username: string, ip: string, now = Date.now()) {
    this.database.connection.transaction(() => {
      for (const { key, threshold } of this.keys(username, ip)) {
        const previous = this.database.connection
          .prepare(
            "SELECT count, window_start, locked_until FROM login_attempts WHERE key=?",
          )
          .get(key) as
          | { count: number; window_start: number; locked_until: number }
          | undefined;
        // Requests that started before a lock cannot extend it indefinitely.
        if (previous && previous.locked_until > now) continue;
        const fresh =
          !previous || now - previous.window_start >= LoginProtection.windowMs;
        const count = fresh ? 1 : previous.count + 1;
        this.database.connection
          .prepare(
            "INSERT INTO login_attempts(key,count,window_start,locked_until) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,window_start=excluded.window_start,locked_until=excluded.locked_until",
          )
          .run(
            key,
            count,
            fresh ? now : previous.window_start,
            count >= threshold ? now + LoginProtection.windowMs : 0,
          );
        if (count === threshold)
          this.database.addAuditLog(
            "auth.lock",
            JSON.stringify({
              scope: key.split(":")[0],
              username: username.slice(0, 100),
              ip,
              unlockAt: new Date(now + LoginProtection.windowMs).toISOString(),
            }),
            "security",
          );
      }
    })();
    this.check(username, ip, now);
  }
  success(username: string, ip: string) {
    // Successful logins must not erase an IP's password-spraying history.
    this.database.connection
      .prepare("DELETE FROM login_attempts WHERE key=?")
      .run(this.keys(username, ip)[0]!.key);
  }
}

export class RequestLimiter {
  private buckets = new Map<string, { count: number; end: number }>();
  private cleaned = 0;
  consume(key: string, limit: number, now = Date.now()) {
    if (now - this.cleaned >= 60_000) {
      for (const [k, row] of this.buckets)
        if (row.end <= now) this.buckets.delete(k);
      this.cleaned = now;
    }
    let row = this.buckets.get(key);
    if (!row || row.end <= now) {
      if (this.buckets.size >= 10_000 && !row) throw new RateLimitError(60);
      row = { count: 0, end: now + 60_000 };
      this.buckets.set(key, row);
    }
    if (++row.count > limit)
      throw new RateLimitError(Math.ceil((row.end - now) / 1000));
  }
}
