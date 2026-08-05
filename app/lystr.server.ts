const LYSTR_CONNECTOR_SECRET_HEADER = "x-lystr-connector-secret";

export type LystrConnectorConfig = {
  creditsPerSuccessfulPayment: number;
  currency: string;
  migrationBillingStartsAt: string;
  planCredits: Record<string, number>;
  planPrices: Record<string, number>;
  planName: string;
};

export type LystrConnectorStatus = {
  accessAllowed: boolean;
  billingApprovalRequired: boolean;
  billingStatus?: string | null;
  connectionPending?: boolean;
  creditsPerSuccessfulPayment: number;
  currency: string;
  grandfatheredBillingStartsAt?: string | null;
  isGrandfathered?: boolean;
  lastSuccessfulPaymentAt?: string | null;
  latestCreditsGranted?: number;
  monthlyPrice: number;
  monthlyPriceCents: number;
  nextBillingDate?: string | null;
  planCredits?: Record<string, number>;
  shopifyPlanHandle?: string | null;
  shopifyPlanKey?: string | null;
  shopifyPlanName?: string | null;
  shopifyBillingSource?: string | null;
  shopifySubscriptionId?: string | null;
  shopifySubscriptionStatus?: string | null;
  pendingShopifyPlanKey?: string | null;
  pendingShopifyPlanName?: string | null;
  pendingShopifyPlanStatus?: string | null;
  pendingShopifySubscriptionId?: string | null;
  pendingShopifyPlanRequestedAt?: string | null;
  pendingShopifyPlanActivatesAt?: string | null;
  pendingStoreId?: string | null;
  pendingStoreName?: string | null;
  reconnectRequired?: boolean;
  remainingBillingDays?: number;
  status: string;
  storeId?: string | null;
  storeName?: string | null;
};

export type LystrStoreSummary = {
  id: string;
  name: string;
  shopDomain: string | null;
};

export type ShopifySubscriptionForLystr = {
  billingSource?: "app_pricing" | "manual" | null;
  id?: string | null;
  name?: string | null;
  planKey?: string | null;
  status?: string | null;
  test?: boolean | null;
  createdAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  eventOccurredAt?: string | null;
  lineItems?: {
    id?: string | null;
    plan?: {
      pricingDetails?: {
        price?: {
          amount?: number | string | null;
          currencyCode?: string | null;
        } | null;
      } | null;
    } | null;
  }[];
};

export function shouldFinalizeLystrStoreConnection({
  connector,
  hasLocalApiKey,
  isBillingReturn,
}: {
  connector: LystrConnectorStatus | null | undefined;
  hasLocalApiKey: boolean;
  isBillingReturn: boolean;
}) {
  const hasPreparedStore = Boolean(
    hasLocalApiKey || hasVerifiedLystrStoreClaim(connector),
  );

  return Boolean(
    hasPreparedStore &&
    (isBillingReturn ||
      (connector?.connectionPending && !connector.reconnectRequired)),
  );
}

export function hasVerifiedLystrStoreClaim(
  connector: LystrConnectorStatus | null | undefined,
): connector is LystrConnectorStatus &
  ({ storeId: string } | { pendingStoreId: string }) {
  return Boolean(
    connector?.storeId?.trim() || connector?.pendingStoreId?.trim(),
  );
}

type LystrApiResponse<T> = T & {
  error?: string;
};

function getLystrApiBaseUrl() {
  return (
    process.env.LYSTR_API_BASE_URL?.trim().replace(/\/+$/, "") ||
    "https://lystr.ai"
  );
}

function getConnectorSecret() {
  const secret = process.env.LYSTR_CONNECTOR_SHARED_SECRET?.trim();

  if (!secret) {
    throw new Error("LYSTR_CONNECTOR_SHARED_SECRET is not configured.");
  }

  return secret;
}

async function requestLystr<T>(path: string, init?: RequestInit) {
  const url = `${getLystrApiBaseUrl()}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      [LYSTR_CONNECTOR_SECRET_HEADER]: getConnectorSecret(),
      ...(init?.headers ?? {}),
    },
  });
  const data = (await response.json().catch(() => ({}))) as LystrApiResponse<T>;

  if (!response.ok) {
    throw new Error(
      data.error ||
        `Lystr API request failed for ${path} (${response.status} ${response.statusText}).`,
    );
  }

  return data as T;
}

export async function getLystrConnectorConfig() {
  return requestLystr<{ config: LystrConnectorConfig }>(
    "/api/shopify-connector/config",
    { cache: "no-store" },
  );
}

export async function prepareLystrStoreConnection(input: {
  apiKey: string;
  shopDomain: string;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    store: LystrStoreSummary;
  }>("/api/shopify-connector/stores/prepare", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getLystrConnectorStatus(input: { shopDomain: string }) {
  return requestLystr<{
    connector: LystrConnectorStatus;
  }>(
    `/api/shopify-connector/status?shopDomain=${encodeURIComponent(
      input.shopDomain,
    )}`,
  );
}

export async function connectLystrStore(input: {
  accessToken: string;
  apiKey?: string;
  shopDomain: string;
  shopifySubscription?: ShopifySubscriptionForLystr | null;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    store: LystrStoreSummary;
  }>("/api/shopify-connector/stores/connect", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function syncLystrConnectorBilling(input: {
  shopDomain: string;
  shopifySubscription: ShopifySubscriptionForLystr | null;
  shopifyWebhookId?: string | null;
}) {
  return requestLystr<{
    config: LystrConnectorConfig;
    connector: LystrConnectorStatus;
    creditGrant?: unknown;
  }>("/api/shopify-connector/billing/sync", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateLystrConnectorPlanTransition(input: {
  action: "clear" | "schedule";
  activatesAt?: string;
  expectedPendingSubscriptionId?: string | null;
  pendingSubscriptionId?: string | null;
  planKey?: "free" | "basic" | "pro" | "premium";
  shopDomain: string;
  status?: "CANCEL_PENDING" | "SCHEDULED" | "PENDING_APPROVAL" | "APPROVED";
}) {
  return requestLystr<{ connector: LystrConnectorStatus }>(
    "/api/shopify-connector/billing/plan-transition",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function recordLystrConnectorAuditEvent(input: {
  errorMessage?: string | null;
  event: string;
  level: "error" | "info" | "success" | "warning";
  message: string;
  metadata?: Record<string, unknown>;
  requestId?: string | null;
  shopDomain: string;
}) {
  return requestLystr<{ recorded: boolean }>("/api/shopify-connector/audit", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function cancelLystrConnectorBilling(input: {
  shopDomain: string;
}) {
  return requestLystr<{ result: unknown }>(
    "/api/shopify-connector/billing/cancel",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function syncLystrCreditTopUp(input: {
  shopDomain: string;
  shopifyPurchaseId: string;
  shopifyWebhookId?: string | null;
}) {
  return requestLystr<{ result?: unknown }>(
    "/api/shopify-connector/billing/top-up-sync",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function markLystrConnectorUninstalled(input: {
  shopDomain: string;
  shopifyWebhookId?: string | null;
}) {
  return requestLystr<{ connector: LystrConnectorStatus | null }>(
    "/api/shopify-connector/uninstalled",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}
