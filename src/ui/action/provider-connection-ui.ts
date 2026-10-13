import { element, parseJsonObject, parseStringRecord } from "../shared/helpers";
import { displayProviderUrl, isOpenRouterOrigin, joinProviderUrl, providerRoute, splitProviderUrl } from "../../provider/request-policy";
import type { OpenRouterProviderPreferences } from "../../shared/organizer-types";

/**
 * The one form every provider connection uses (organizer, embeddings, decision
 * model), so all three read and behave the same: the same field names in the
 * same order, the same API-key handling, the same status vocabulary, and one
 * Save and verify. Each caller supplies only what is specific to its provider.
 */

export interface ProviderFormKit {
  input(value: string, type?: HTMLInputElement["type"]): HTMLInputElement;
  field(label: string, control: HTMLElement, help?: string): HTMLElement;
  check(label: string, copy: string, checked: boolean): { wrapper: HTMLLabelElement; control: HTMLInputElement };
  button(
    label: string,
    variant: "primary" | "secondary" | "quiet" | "danger",
    onClick: () => void,
    options?: { disabled?: boolean; actionName?: string; busyLabel?: string },
  ): HTMLButtonElement;
  settingsSummary(text: string): HTMLElement;
  settingsEditChip(): HTMLElement;
  perform(actionName: string, action: () => Promise<void>): Promise<void>;
}

export type ConnectionState = "ready" | "unverified" | "unset";

export interface ConnectionStatus {
  state: ConnectionState;
  /** One line under the form, e.g. "Verified · <model> · 420 ms". */
  text: string;
}

const STATE_LABELS: Record<ConnectionState | "dirty", string> = {
  ready: "Ready",
  unverified: "Not verified",
  unset: "Not set up",
  dirty: "Unsaved",
};

export function connectionStateLabel(state: ConnectionState): string {
  return STATE_LABELS[state];
}

export function connectionStateClass(state: ConnectionState): string {
  return state === "ready" ? "settings-state settings-state--ready" : "settings-state";
}

export interface ProviderConnectionValues {
  origin: string;
  endpointPath: string;
  model: string;
  /** What was typed into the key field; blank means keep the saved key (see resolveApiKey). */
  typedApiKey: string;
  persistKey: boolean;
  customHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  timeoutMs: number | undefined;
  /** Undefined unless this provider supports routing and Origin is OpenRouter. */
  openRouter: OpenRouterProviderPreferences | undefined;
}

export interface ProviderConnectionSpec {
  /** Stable id, used for the anchor and the action names. */
  id: "organizer" | "embedding" | "decision";
  title: string;
  /** What this connection is for, shown at the top of the open form. */
  purpose: string;
  /** Collapsed summary line. */
  summary: string;
  status: ConnectionStatus;
  open: boolean;
  /** The saved origin and path; blank origin shows an empty URL field. */
  origin: string;
  endpointPath: string;
  urlPlaceholder?: string;
  /** The route a base URL gets, read at save time (the decision model's depends on its protocol). */
  defaultPath(): string;
  model: string;
  modelPlaceholder?: string;
  modelHelp?: string;
  key: {
    /** A key is stored now; the field stays blank and the placeholder says so. */
    saved: boolean;
    persistent: boolean;
    /** Local servers often need none. */
    optional?: boolean;
  };
  /** Controls before Origin, such as a protocol choice or connection reuse. */
  leading?: HTMLElement[];
  /** Controls after Model that describe the model. */
  modelExtras?: HTMLElement[];
  advanced: {
    customHeaders: Record<string, string>;
    extraBody: Record<string, unknown>;
    timeoutMs?: { value: number; default: number; max: number };
    /** Provider-specific request controls, after the shared ones. */
    extras?: HTMLElement[];
    /** True when a provider-specific control holds a non-default value. */
    customized?: boolean;
  };
  /** Present when this provider's requests accept OpenRouter routing preferences. */
  openRouter?: { preferences: OpenRouterProviderPreferences | undefined };
  /** One line beside Save and verify: what saving will ask for and send. */
  saveCopy: string;
  save(values: ProviderConnectionValues): Promise<void>;
  /** Removes the stored key. Offered only while a key is saved. */
  forgetKey?(): Promise<void>;
}

export interface ProviderConnectionForm {
  node: HTMLDetailsElement;
  url: HTMLInputElement;
  /** The suffix appended to the URL; blank uses the URL as typed. */
  route: HTMLInputElement;
  /** Re-reads the URL and route fields, e.g. after a caller changes them. */
  refreshUrl(): void;
  /** URL, route, key, and remember-key rows, for callers that reuse another connection. */
  connectionFields: HTMLElement[];
  modelField: HTMLElement;
  advanced: HTMLDetailsElement;
  /** Marks the form unsaved; callers wire their own leading or extra controls to it. */
  markDirty(): void;
}

/**
 * A blank key field keeps the saved key, but never carries it to another
 * server: changing Origin without typing a key saves no key.
 */
export function resolveApiKey(
  typed: string,
  saved: { origin: string; apiKey: string } | null,
  nextOrigin: string,
): string {
  if (typed) return typed;
  if (!saved?.apiKey) return "";
  return sameOrigin(saved.origin, nextOrigin) ? saved.apiKey : "";
}

function sameOrigin(left: string, right: string): boolean {
  try {
    return new URL(left.trim()).origin === new URL(right.trim()).origin;
  } catch {
    return false;
  }
}

function jsonText(value: Record<string, unknown>): string {
  return Object.keys(value).length === 0 ? "" : JSON.stringify(value, null, 2);
}

function select<T extends string>(
  options: ReadonlyArray<readonly [T, string]>,
  selected: T,
): HTMLSelectElement {
  const node = element("select", "input");
  options.forEach(([value, label]) => {
    const option = element("option", undefined, label);
    option.value = value;
    option.selected = value === selected;
    node.append(option);
  });
  return node;
}

function openRouterRouting(
  kit: ProviderFormKit,
  preferences: OpenRouterProviderPreferences | undefined,
  origin: () => string,
): { node: HTMLElement; controls: HTMLElement[]; sync: () => void; read: () => OpenRouterProviderPreferences | undefined } {
  const order = kit.input(preferences?.order?.join(", ") ?? "");
  order.placeholder = "openai, anthropic, google-vertex";
  const sort = select([
    ["provider", "OpenRouter default"],
    ["price", "Price"],
    ["throughput", "Throughput"],
    ["latency", "Latency"],
  ] as const, preferences?.sort ?? "provider");
  const fallbacks = select([
    ["provider", "OpenRouter default (allow)"],
    ["allow", "Allow fallbacks"],
    ["deny", "Do not allow fallbacks"],
  ] as const, preferences?.allowFallbacks === undefined ? "provider" : preferences.allowFallbacks ? "allow" : "deny");
  const dataCollection = select([
    ["provider", "OpenRouter default (allow)"],
    ["deny", "Deny data collection"],
    ["allow", "Allow data collection"],
  ] as const, preferences?.dataCollection ?? "provider");
  const zdr = kit.check(
    "Require zero data retention",
    "Routes only to OpenRouter endpoints with a Zero Data Retention policy.",
    preferences?.zdr === true,
  );
  const requireParameters = kit.check(
    "Require parameter support",
    "Only uses providers that support every parameter in the request.",
    preferences?.requireParameters === true,
  );
  // Only an OpenRouter URL can use these, so they appear only for one.
  const node = element("div", "provider-openrouter");
  node.append(
    element("h4", undefined, "OpenRouter routing"),
    element("p", "settings-group__copy", "Sent in OpenRouter's provider object. Unset options keep OpenRouter's defaults."),
    zdr.wrapper,
    requireParameters.wrapper,
    kit.field("Provider order", order, "Optional comma-separated provider slugs, tried in this order before other eligible providers when fallbacks are allowed."),
    kit.field("Sort providers by", sort, "Overrides OpenRouter's default load balancing when selected."),
    kit.field("Fallback policy", fallbacks, "Disable to return an upstream error instead of trying another provider."),
    kit.field("Data collection", dataCollection, "Deny excludes providers that may store or train on request data."),
  );
  const sync = (): void => {
    node.hidden = !isOpenRouterOrigin(origin());
  };
  sync();
  return {
    node,
    controls: [order, sort, fallbacks, dataCollection, zdr.control, requireParameters.control],
    sync,
    read: () => isOpenRouterOrigin(origin()) ? {
      zdr: zdr.control.checked || undefined,
      order: order.value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
      sort: sort.value === "provider" ? undefined : sort.value as OpenRouterProviderPreferences["sort"],
      allowFallbacks: fallbacks.value === "provider" ? undefined : fallbacks.value === "allow",
      dataCollection: dataCollection.value === "provider"
        ? undefined
        : dataCollection.value as OpenRouterProviderPreferences["dataCollection"],
      requireParameters: requireParameters.control.checked || undefined,
    } : undefined,
  };
}

export function renderProviderConnection(kit: ProviderFormKit, spec: ProviderConnectionSpec): ProviderConnectionForm {
  const node = element("details", "settings-group settings-group--provider provider-settings");
  node.id = `provider-${spec.id}`;
  node.dataset.provider = spec.id;
  node.open = spec.open;

  const summary = element("summary", "settings-disclosure-summary");
  const summaryCopy = element("span");
  const titleId = `provider-${spec.id}-title`;
  const title = element("strong", undefined, spec.title);
  title.id = titleId;
  summaryCopy.append(title, element("small", undefined, spec.summary));
  const badge = element("span", connectionStateClass(spec.status.state), connectionStateLabel(spec.status.state));
  const summaryActions = element("span", "settings-summary-actions");
  summaryActions.append(badge, kit.settingsEditChip());
  summary.append(summaryCopy, summaryActions);

  // A saved connection shows as a base URL plus its route; a new one starts
  // with an empty URL and the connection's usual route.
  const shown = spec.origin
    ? displayProviderUrl(spec.origin, spec.endpointPath, spec.defaultPath())
    : { url: "", route: providerRoute(spec.defaultPath()) };
  const url = kit.input(shown.url, "url");
  url.placeholder = spec.urlPlaceholder ?? "https://api.openai.com/v1";
  const route = kit.input(shown.route);
  route.placeholder = "None · use the URL exactly as typed";
  const urlHint = element("small", "field__help provider-url__resolved");
  urlHint.setAttribute("aria-live", "polite");
  const originOf = (): string => {
    try {
      return new URL(url.value.trim()).origin;
    } catch {
      return "";
    }
  };
  const model = kit.input(spec.model);
  if (spec.modelPlaceholder) model.placeholder = spec.modelPlaceholder;
  // The stored key never goes back into the page; a blank field keeps it.
  const apiKey = kit.input("", "password");
  apiKey.placeholder = spec.key.saved
    ? "Saved · leave blank to keep"
    : spec.key.optional ? "Optional for local servers" : "Paste your API key";
  const persistKey = kit.check(
    "Remember key after the browser closes",
    "Off keeps the key until you quit the browser.",
    spec.key.persistent,
  );

  const keyRow = element("div", "provider-key");
  keyRow.append(apiKey);
  if (spec.key.saved && spec.forgetKey) {
    const forget = spec.forgetKey;
    keyRow.append(kit.button("Forget key", "quiet", () => {
      void kit.perform(`forget-${spec.id}-key`, forget);
    }, { actionName: `forget-${spec.id}-key`, busyLabel: "Forgetting…" }));
  }
  const keyField = kit.field(
    "API key",
    keyRow,
    spec.key.saved ? "Type a new key to replace the saved one. A different server never gets the saved key." : undefined,
  );
  // The label points at the wrapper; aim it at the input itself.
  const keyLabel = keyField.querySelector<HTMLLabelElement>(".field__label");
  apiKey.id = keyRow.id;
  keyRow.removeAttribute("id");
  if (keyLabel) keyLabel.htmlFor = apiKey.id;
  const keyHelp = keyRow.getAttribute("aria-describedby");
  if (keyHelp) {
    apiKey.setAttribute("aria-describedby", keyHelp);
    keyRow.removeAttribute("aria-describedby");
  }

  const urlField = kit.field("API URL", url, "Any OpenAI-compatible service, hosted or local. A base URL like …/v1 is enough.");
  const routeField = kit.field(
    "API route",
    route,
    `Added to the API URL unless it already ends with it. Usually ${providerRoute(spec.defaultPath())}; clear it to use the URL exactly as typed.`,
  );
  // The resolved URL reflects both fields, so it sits under the route.
  urlHint.id = `${url.id}-resolved`;
  [url, route].forEach((control) => {
    control.setAttribute("aria-describedby", `${control.getAttribute("aria-describedby") ?? ""} ${urlHint.id}`.trim());
  });
  routeField.append(urlHint);
  const modelField = kit.field("Model", model, spec.modelHelp);
  const connectionFields = [urlField, routeField, keyField, persistKey.wrapper];

  const customHeaders = element("textarea", "input textarea provider-json");
  customHeaders.value = jsonText(spec.advanced.customHeaders);
  customHeaders.placeholder = "{ }";
  const extraBody = element("textarea", "input textarea provider-json");
  extraBody.value = jsonText(spec.advanced.extraBody);
  extraBody.placeholder = "{ }";
  const timeoutSpec = spec.advanced.timeoutMs;
  const timeout = timeoutSpec ? kit.input(String(timeoutSpec.value), "number") : null;
  if (timeout && timeoutSpec) {
    timeout.min = "1000";
    timeout.max = String(timeoutSpec.max);
    timeout.step = "1000";
  }
  const routing = spec.openRouter ? openRouterRouting(kit, spec.openRouter.preferences, originOf) : null;
  const advanced = element("details", "advanced provider-advanced");
  advanced.open = Boolean(spec.advanced.customized) ||
    Object.keys(spec.advanced.customHeaders).length > 0 ||
    Object.keys(spec.advanced.extraBody).length > 0 ||
    (timeoutSpec !== undefined && timeoutSpec.value !== timeoutSpec.default);
  advanced.append(kit.settingsSummary("Advanced"));
  if (timeout && timeoutSpec) {
    advanced.append(kit.field("Timeout (ms)", timeout, `Default: ${timeoutSpec.default.toLocaleString()} ms.`));
  }
  advanced.append(
    kit.field("Custom headers (JSON)", customHeaders, "Kept until you quit the browser. The API key already sets Authorization."),
    kit.field("Extra request body (JSON)", extraBody, "Merged into every request and saved. Don't put secrets here."),
    ...(spec.advanced.extras ?? []),
    ...(routing ? [routing.node] : []),
  );

  const refreshUrl = (): void => {
    routing?.sync();
    if (!url.value.trim()) {
      urlHint.textContent = "";
      return;
    }
    try {
      const { origin, endpointPath } = splitProviderUrl(url.value, route.value, spec.defaultPath());
      urlHint.textContent = `Sheaf will call ${joinProviderUrl(origin, endpointPath)}`;
    } catch (error) {
      urlHint.textContent = error instanceof Error ? error.message : "";
    }
  };
  url.addEventListener("input", refreshUrl);
  route.addEventListener("input", refreshUrl);
  refreshUrl();

  const statusLine = element(
    "p",
    spec.status.state === "ready" ? "connection-status connection-status--ready" : "connection-status",
    spec.status.text,
  );
  statusLine.setAttribute("role", "status");
  const markDirty = (): void => {
    statusLine.className = "connection-status connection-status--pending";
    statusLine.textContent = "Unsaved changes · Save and verify to use them.";
    badge.className = "settings-state";
    badge.textContent = STATE_LABELS.dirty;
  };
  [url, route, model, apiKey, customHeaders, extraBody, ...(timeout ? [timeout] : []), ...(routing?.controls ?? [])]
    .forEach((control) => control.addEventListener("input", markDirty));
  [persistKey.control, ...(routing?.controls ?? [])].forEach((control) => control.addEventListener("change", markDirty));

  const actionName = `save-${spec.id}-provider`;
  const actions = element("div", "settings-connection-actions");
  actions.append(
    element("p", undefined, spec.saveCopy),
    kit.button("Save and verify", "secondary", () => {
      void kit.perform(actionName, () => {
        // Read inside perform so a malformed URL becomes the page's error notice.
        const { origin, endpointPath } = url.closest("[hidden]")
          ? { origin: spec.origin, endpointPath: spec.endpointPath }
          : splitProviderUrl(url.value, route.value, spec.defaultPath());
        return spec.save({
          origin,
          endpointPath,
          model: model.value.trim(),
          typedApiKey: apiKey.value.trim(),
          persistKey: persistKey.control.checked,
          customHeaders: parseStringRecord(customHeaders.value, `${spec.title}: custom headers`),
          extraBody: parseJsonObject(extraBody.value, `${spec.title}: extra request body`),
          timeoutMs: timeout ? Number(timeout.value) || timeoutSpec!.default : undefined,
          openRouter: routing?.read(),
        });
      });
    }, { actionName, busyLabel: "Verifying…" }),
  );

  const body = element("div", "settings-disclosure-body");
  body.setAttribute("role", "group");
  body.setAttribute("aria-labelledby", titleId);
  body.append(
    element("p", "settings-group__copy", spec.purpose),
    ...(spec.leading ?? []),
    urlField,
    routeField,
    modelField,
    ...(spec.modelExtras ?? []),
    keyField,
    persistKey.wrapper,
    advanced,
    statusLine,
    actions,
  );
  node.append(summary, body);
  return { node, url, route, refreshUrl, connectionFields, modelField, advanced, markDirty };
}

/**
 * A row in a feature's own section that names the connection it depends on
 * and links to it in Connections, so status is visible where the feature lives.
 */
export function providerLinkRow(
  lineIcon: (paths: string[]) => SVGSVGElement,
  options: { id: ProviderConnectionSpec["id"]; title: string; status: ConnectionState; detail: string },
): HTMLAnchorElement {
  const link = element("a", "settings-tool-link provider-link");
  link.href = `#connections`;
  link.dataset.providerTarget = options.id;
  const name = element("span", undefined, options.title);
  const detail = element("small");
  detail.append(
    element("span", connectionStateClass(options.status), connectionStateLabel(options.status)),
    element("span", "provider-link__detail", options.detail),
  );
  link.append(name, detail, lineIcon(["m9.5 6 6 6-6 6"]));
  return link;
}
