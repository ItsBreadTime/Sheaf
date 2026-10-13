import { describe, expect, it } from "vitest";
import {
  getProtectedLocationReason,
  isBlankNewTabUrl,
} from "../src/browser/domain-policy";
import {
  findDomainRuleConflicts,
  getPrivacyExclusionReason,
  normalizeDomainRule,
} from "../src/privacy/domain-policy";

describe("getProtectedLocationReason", () => {
  it.each([
    "file:///Users/example/report.html",
    "chrome://settings/",
    "data:text/plain,private",
    "http://localhost:8080/model",
    "http://127.42.0.1/service",
    "http://10.20.30.40/",
    "https://172.20.0.1/",
    "https://192.168.1.10/",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
  ])("protects local or non-public location %s", (url) => {
    expect(getProtectedLocationReason(url)).not.toBeNull();
  });

  it.each([
    "https://example.com/path?secret=yes#fragment",
    "https://developer.chrome.com/docs/extensions/",
    "http://93.184.216.34/",
  ])("allows ordinary public HTTP(S) location %s", (url) => {
    expect(getProtectedLocationReason(url)).toBeNull();
  });

  it("allows local-network and file tabs only through their explicit settings", () => {
    const policy = { allowLocalNetworkTabs: true, allowFileTabs: true };
    expect(getProtectedLocationReason("http://localhost:3000/app", policy)).toBeNull();
    expect(getProtectedLocationReason("https://192.168.1.20/dashboard", policy)).toBeNull();
    expect(getProtectedLocationReason("file:///Users/example/notes.html", policy)).toBeNull();
    expect(getProtectedLocationReason("chrome://settings/", policy)).toContain("Protected");
  });

  it.each([
    "about:blank",
    "chrome://newtab/",
    "chrome://new-tab-page/",
    "helium://newtab/",
  ])("recognizes the exact blank new-tab location %s", (url) => {
    expect(isBlankNewTabUrl(url)).toBe(true);
  });

  it.each([
    "https://google.com/search?q=draft",
    "chrome://settings/",
    "file:///Users/example/newtab.html",
  ])("does not treat a navigated or unrelated page as a blank new tab %s", (url) => {
    expect(isBlankNewTabUrl(url)).toBe(false);
  });
});

describe("privacy domain rules", () => {
  it("normalizes pasted URLs and wildcard domains", () => {
    expect(normalizeDomainRule(" HTTPS://Docs.Example.com/path ")).toBe("docs.example.com");
    expect(normalizeDomainRule("*.Example.com")).toBe("*.example.com");
    expect(normalizeDomainRule("not a domain")).toBeNull();
    expect(normalizeDomainRule("*.*.example.com")).toBeNull();
    expect(normalizeDomainRule("foo.*.example.com")).toBeNull();
    expect(normalizeDomainRule("https://*.example.com")).toBeNull();
    expect(normalizeDomainRule("-bad.example.com")).toBeNull();
    expect(normalizeDomainRule("bad-.example.com")).toBeNull();
    expect(normalizeDomainRule("bad_.example.com")).toBeNull();
  });

  it("uses wildcards for subdomains without including the apex", () => {
    const settings = { allowlist: ["*.example.com"], denylist: [] };
    expect(getPrivacyExclusionReason("docs.example.com", "example.com", settings)).toBeNull();
    expect(getPrivacyExclusionReason("deep.docs.example.com", "example.com", settings)).toBeNull();
    expect(getPrivacyExclusionReason("example.com", "example.com", settings)).toContain("not included");
  });

  it("keeps bare registrable-domain rules compatible with apex and subdomains", () => {
    const settings = { allowlist: ["example.com"], denylist: [] };
    expect(getPrivacyExclusionReason("example.com", "example.com", settings)).toBeNull();
    expect(getPrivacyExclusionReason("docs.example.com", "example.com", settings)).toBeNull();
  });

  it("detects overlap between wildcard and parent or child rules", () => {
    expect(findDomainRuleConflicts(["*.example.com"], ["docs.example.com"]))
      .toEqual([{ allowRule: "*.example.com", denyRule: "docs.example.com" }]);
  });

  it("reports exact and parent-child allow/deny conflicts", () => {
    expect(findDomainRuleConflicts(
      ["docs.example.com", "allowed.test"],
      ["example.com", "allowed.test"],
    )).toEqual([
      { allowRule: "allowed.test", denyRule: "allowed.test" },
      { allowRule: "docs.example.com", denyRule: "example.com" },
    ]);
  });
});
