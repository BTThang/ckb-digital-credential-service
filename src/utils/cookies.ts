/**
 * Minimal cookie handling.
 *
 * The service only ever reads one cookie and writes one cookie, so a full
 * `cookie-parser` dependency would not earn its keep. Parsing is deliberately
 * forgiving about malformed input (a browser is the only real client, but a
 * hand-rolled request could send anything) while serialisation stays strict
 * enough that a value can never break out of its attribute.
 */
export type SameSite = "strict" | "lax" | "none";

export interface CookieOptions {
  /** Lifetime in seconds. Omitted means a session cookie. */
  maxAge?: number;
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: SameSite;
}

/**
 * Parses a `Cookie:` request header into a name/value map.
 *
 * A duplicated name keeps the *first* occurrence, which is what browsers do.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 1) continue;

    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name.length === 0 || name in cookies) continue;

    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      // A malformed percent-escape must not throw on the hot path; the raw
      // value simply will not match any stored hash.
      cookies[name] = value;
    }
  }

  return cookies;
}

/** Builds a `Set-Cookie` header value. */
export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];

  // `__Host-` requires `Path=/` and no `Domain`, so the default is not negotiable.
  parts.push(`Path=${options.path ?? "/"}`);

  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`);
  }
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite[0]!.toUpperCase()}${options.sameSite.slice(1)}`);
  }

  return parts.join("; ");
}

/**
 * Builds the `Set-Cookie` value that removes a cookie.
 *
 * The attributes must match the ones used when setting it, otherwise the
 * browser keeps the original and the "logout" silently does nothing.
 */
export function serializeExpiredCookie(
  name: string,
  options: Pick<CookieOptions, "path" | "secure" | "sameSite"> = {},
): string {
  return serializeCookie(name, "", {
    ...options,
    maxAge: 0,
    httpOnly: true,
  });
}

/** Reads a single cookie from a request's headers. */
export function readCookie(
  headers: { cookie?: string },
  name: string,
): string | undefined {
  return parseCookies(headers.cookie)[name];
}