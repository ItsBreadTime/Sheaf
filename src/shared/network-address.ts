/**
 * Host classification shared by every policy that cares where an address points:
 * which tabs count as local or private-network (browser/domain-policy) and which
 * provider origins may use plain HTTP (provider/request-policy). One copy, so a
 * fix to either rule cannot silently diverge from the other.
 */

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }

  const first = octets[0];
  const second = octets[1];
  if (first === undefined || second === undefined) {
    return false;
  }

  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!normalized.includes(":")) {
    return false;
  }

  if (normalized === "::1" || normalized === "::") {
    return true;
  }

  // IPv4-mapped forms carry a private IPv4 behind the ::ffff: prefix, in either
  // dotted ("::ffff:127.0.0.1") or hextet ("::ffff:7f00:1") notation.
  const mapped = normalized.match(/^::ffff:(.+)$/);
  if (mapped) {
    const tail = mapped[1]!;
    if (tail.includes(".")) return isPrivateIpv4(tail);
    const groups = tail.split(":");
    if (groups.length === 2) {
      const high = Number.parseInt(groups[0]!, 16);
      const low = Number.parseInt(groups[1]!, 16);
      if (Number.isInteger(high) && Number.isInteger(low)) {
        return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff].join("."));
      }
    }
    return false;
  }

  const firstHextet = Number.parseInt(normalized.split(":").find((part) => part !== "") ?? "", 16);
  if (!Number.isInteger(firstHextet)) {
    return false;
  }

  const uniqueLocal = (firstHextet & 0xfe00) === 0xfc00;
  const linkLocal = (firstHextet & 0xffc0) === 0xfe80;
  return uniqueLocal || linkLocal;
}

/** localhost, *.localhost, and loopback, private, link-local, and unique-local IPs. */
export function isLocalNetworkHostname(rawHostname: string): boolean {
  const hostname = rawHostname.toLowerCase().replace(/\.$/, "");
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    isPrivateIpv4(hostname) ||
    isPrivateIpv6(hostname)
  );
}

/**
 * The loopback hosts a provider may reach over plain HTTP. Exactly the three the
 * manifest's optional host permissions name, because Chromium can grant nothing
 * else over http.
 */
export function isLoopbackProviderHostname(rawHostname: string): boolean {
  const hostname = rawHostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
