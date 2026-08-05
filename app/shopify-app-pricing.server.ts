import type {
  LystrConnectorConfig,
  ShopifySubscriptionForLystr,
} from "./lystr.server";
import {
  APP_PRICING_PLAN_KEYS,
  getAppPricingPlanDefinitionByHandle,
  getAppPricingPlanDefinition,
  isAcceptedAppPricingPlanHandle,
  isFreeAppPricingPlanHandle,
  type AppPricingPlanKey,
} from "./shopify-app-pricing-plans.server";

type AdminGraphqlClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

type PartnerApiConfig = {
  organizationId: string;
  token: string;
};

type PartnerActiveSubscription = {
  billingPeriod?: string | null;
  cancelAtEndOfCycle?: boolean | null;
  currentBillingCycle?: {
    startTime?: string | null;
    endTime?: string | null;
  } | null;
  legacySubscriptionId?: string | null;
  items?: PartnerSubscriptionItem[];
};

type PartnerSubscriptionItem = {
  handle?: string | null;
  price?: {
    __typename?: string;
    active?: boolean | null;
    amount?: number | string | null;
    currency?: string | null;
  } | null;
};

const DEFAULT_APP_HANDLE = "lystr-connect";
const PARTNER_API_VERSION = "2026-07";
const LEGACY_REST_BILLING_API_VERSION = "2025-10";

const MANUAL_SUBSCRIPTION_QUERY = `
  #graphql
  query LystrManualBillingSubscription {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        trialDays
        createdAt
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                price {
                  amount
                  currencyCode
                }
                interval
              }
            }
          }
        }
      }
    }
  }
`;

const MANUAL_SUBSCRIPTION_BY_ID_QUERY = `
  #graphql
  query LystrManualBillingSubscriptionById($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        name
        status
        test
        trialDays
        createdAt
        currentPeriodEnd
        lineItems {
          id
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                price {
                  amount
                  currencyCode
                }
                interval
              }
            }
          }
        }
      }
    }
  }
`;

const MANUAL_PENDING_SUBSCRIPTIONS_QUERY = `
  #graphql
  query LystrPendingManualBillingSubscriptions {
    currentAppInstallation {
      allSubscriptions(
        first: 20
        reverse: true
        sortKey: CREATED_AT
      ) {
        nodes {
          id
          name
          status
          test
          trialDays
          createdAt
          currentPeriodEnd
          lineItems {
            id
            plan {
              pricingDetails {
                __typename
                ... on AppRecurringPricing {
                  price {
                    amount
                    currencyCode
                  }
                  interval
                }
              }
            }
          }
        }
      }
    }
  }
`;

const MANUAL_BILLING_RETURN_URL_QUERY = `
  #graphql
  query LystrManualBillingReturnUrl {
    currentAppInstallation {
      launchUrl
    }
  }
`;

const CREATE_MANUAL_SUBSCRIPTION_MUTATION = `
  #graphql
  mutation LystrCreateManualSubscription(
    $name: String!
    $returnUrl: URL!
    $lineItems: [AppSubscriptionLineItemInput!]!
    $replacementBehavior: AppSubscriptionReplacementBehavior!
    $test: Boolean
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      lineItems: $lineItems
      replacementBehavior: $replacementBehavior
      test: $test
    ) {
      appSubscription {
        id
        name
        status
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const CANCEL_MANUAL_SUBSCRIPTION_MUTATION = `
  #graphql
  mutation LystrCancelManualSubscription($id: ID!) {
    appSubscriptionCancel(id: $id, prorate: false) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const PARTNER_CANCEL_SUBSCRIPTION_MUTATION = `
  mutation LystrCancelAppPricingSubscription(
    $appId: ID!
    $shopId: ID!
    $prorate: Boolean!
    $skipFinalUsageCharge: Boolean!
    $deferCancellation: Boolean!
  ) {
    appSubscriptionCancel(
      appId: $appId
      shopId: $shopId
      prorate: $prorate
      skipFinalUsageCharge: $skipFinalUsageCharge
      deferCancellation: $deferCancellation
    ) {
      userErrors {
        message
      }
    }
  }
`;

function normalizeHandle(value: string | null | undefined) {
  return value?.trim().toLowerCase() || "";
}

export function getShopifyAppHandle() {
  return process.env.SHOPIFY_APP_HANDLE?.trim() || DEFAULT_APP_HANDLE;
}

export function isShopifyManualBillingEnabled() {
  // Lystr owns plan selection in /app/billing. Shopify's hosted App Pricing
  // page is retired and must not be used as a fallback.
  return true;
}

export function getPlanHandleFromRequest(request: Request) {
  const url = new URL(request.url);
  const planHandle = normalizeHandle(url.searchParams.get("plan_handle"));

  return isAcceptedAppPricingPlanHandle(planHandle) ? planHandle : null;
}

function getStoreHandle(shopDomain: string) {
  return shopDomain.replace(/\.myshopify\.com$/i, "").split(".")[0];
}

export function getAppPricingPlanSelectionUrl(shopDomain: string) {
  const storeHandle = getStoreHandle(shopDomain);
  const appHandle = getShopifyAppHandle();

  return `https://admin.shopify.com/store/${storeHandle}/charges/${appHandle}/pricing_plans`;
}

function getPartnerApiConfig(): PartnerApiConfig | null {
  const organizationId = (
    process.env.SHOPIFY_PARTNER_ORG_ID ||
    process.env.SHOPIFY_PARTNER_ORGANIZATION_ID ||
    ""
  ).trim();
  const token = process.env.SHOPIFY_PARTNER_ACCESS_TOKEN?.trim() || "";

  if (!organizationId || !token) {
    return null;
  }

  return {
    organizationId,
    token,
  };
}

async function getInstalledAppAndShopGids(admin: AdminGraphqlClient) {
  const response = await admin.graphql(`
    #graphql
    query LystrInstalledAppAndShopIds {
      shop {
        id
      }
      currentAppInstallation {
        app {
          id
        }
      }
    }
  `);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        app?: {
          id?: string | null;
        } | null;
      } | null;
      shop?: { id?: string | null } | null;
    };
    errors?: unknown;
  };
  const appId = json.data?.currentAppInstallation?.app?.id;
  const shopId = json.data?.shop?.id;

  if (!appId) {
    throw new Error("Could not resolve Shopify app ID.");
  }

  if (!shopId) {
    throw new Error("Could not resolve Shopify shop ID.");
  }

  return { appId, shopId };
}

async function getPartnerActiveSubscription({
  admin,
}: {
  admin: AdminGraphqlClient;
}) {
  const partnerConfig = getPartnerApiConfig();

  if (!partnerConfig) {
    return null;
  }

  const { appId, shopId } = await getInstalledAppAndShopGids(admin);
  const response = await fetch(
    `https://partners.shopify.com/${partnerConfig.organizationId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": partnerConfig.token,
      },
      body: JSON.stringify({
        query: `
          query LystrActiveSubscription($appId: ID!, $shopId: ID!) {
            activeSubscription(appId: $appId, shopId: $shopId) {
              billingPeriod
              cancelAtEndOfCycle
              legacySubscriptionId
              currentBillingCycle {
                startTime
                endTime
              }
              items {
                handle
                price {
                  __typename
                  active
                  currency
                  ... on FlatRatePrice {
                    amount
                  }
                }
              }
            }
          }
        `,
        variables: {
          appId,
          shopId,
        },
      }),
    },
  );
  const json = (await response.json()) as {
    data?: { activeSubscription?: PartnerActiveSubscription | null };
    errors?: { message?: string }[];
  };

  if (!response.ok || json.errors?.length) {
    throw new Error(
      json.errors?.[0]?.message || "Shopify Partner API request failed.",
    );
  }

  return json.data?.activeSubscription ?? null;
}

function getAcceptedPartnerSubscriptionItem(
  subscription: PartnerActiveSubscription | null,
) {
  if (!subscription?.items?.length) {
    return null;
  }

  return (
    subscription.items.find((item) =>
      isAcceptedAppPricingPlanHandle(item.handle),
    ) ?? null
  );
}

function getLineItemPrice(
  item: PartnerSubscriptionItem | null,
  config: LystrConnectorConfig,
) {
  const amount = Number(item?.price?.amount);
  const currency = item?.price?.currency?.trim().toUpperCase();

  if (!Number.isFinite(amount) || amount < 0) {
    return isFreeAppPricingPlanHandle(item?.handle)
      ? {
          amount: 0,
          currencyCode: currency || config.currency.toUpperCase(),
        }
      : null;
  }

  return {
    amount,
    currencyCode: currency || config.currency.toUpperCase(),
  };
}

function subscriptionFromPlanHandle({
  billingSource = "app_pricing",
  config,
  currentPeriodEnd,
  id,
  planHandle,
  shopDomain,
  startedAt,
}: {
  billingSource?: "app_pricing" | "manual";
  config: LystrConnectorConfig;
  currentPeriodEnd?: string | null;
  id?: string | null;
  planHandle: string;
  shopDomain: string;
  startedAt?: string | null;
}): ShopifySubscriptionForLystr {
  const planDefinition = getAppPricingPlanDefinitionByHandle(planHandle);

  return {
    billingSource,
    id: id || `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planDefinition?.label ?? planHandle,
    planKey: planDefinition?.key ?? null,
    status: "ACTIVE",
    test: false,
    createdAt: startedAt ?? null,
    currentPeriodEnd: currentPeriodEnd ?? null,
    lineItems: [
      {
        id: planHandle,
        plan: {
          pricingDetails: {
            price: {
              amount: 0,
              currencyCode: config.currency.toUpperCase(),
            },
          },
        },
      },
    ],
  };
}

function subscriptionFromPartnerActiveSubscription({
  config,
  shopDomain,
  subscription,
}: {
  config: LystrConnectorConfig;
  shopDomain: string;
  subscription: PartnerActiveSubscription | null;
}) {
  const item = getAcceptedPartnerSubscriptionItem(subscription);
  const planHandle = normalizeHandle(item?.handle);
  const planDefinition = getAppPricingPlanDefinitionByHandle(planHandle);

  if (!subscription || !item || !planHandle || !planDefinition) {
    return null;
  }

  const price = getLineItemPrice(item, config);

  if (!price) {
    return null;
  }

  return {
    billingSource: "app_pricing" as const,
    id:
      subscription.legacySubscriptionId ||
      `shopify-app-pricing:${shopDomain}:${planHandle}`,
    name: planDefinition.label,
    planKey: planDefinition.key,
    status: subscription.cancelAtEndOfCycle ? "CANCELLED" : "ACTIVE",
    test: false,
    createdAt: subscription.currentBillingCycle?.startTime ?? null,
    currentPeriodStart: subscription.currentBillingCycle?.startTime ?? null,
    currentPeriodEnd: subscription.currentBillingCycle?.endTime ?? null,
    lineItems: [
      {
        id: planHandle,
        plan: {
          pricingDetails: {
            price,
          },
        },
      },
    ],
  } satisfies ShopifySubscriptionForLystr;
}

export async function getCurrentAppPricingSubscription({
  admin,
  config,
  request,
  shopDomain,
  throwOnPartnerApiError = false,
}: {
  admin: AdminGraphqlClient;
  config: LystrConnectorConfig;
  request: Request;
  shopDomain: string;
  throwOnPartnerApiError?: boolean;
}) {
  const redirectPlanHandle = getPlanHandleFromRequest(request);

  try {
    const partnerSubscription = await getPartnerActiveSubscription({ admin });
    const activeSubscription = subscriptionFromPartnerActiveSubscription({
      config,
      shopDomain,
      subscription: partnerSubscription,
    });

    if (activeSubscription) {
      return activeSubscription;
    }
  } catch (error) {
    console.warn("Failed to query Shopify App Pricing subscription.", error);

    if (throwOnPartnerApiError) {
      throw error;
    }
  }

  if (redirectPlanHandle && isFreeAppPricingPlanHandle(redirectPlanHandle)) {
    return subscriptionFromPlanHandle({
      config,
      planHandle: redirectPlanHandle,
      shopDomain,
    });
  }

  return null;
}

function getManualPlanKey(name: string | null | undefined) {
  const normalizedName = normalizeHandle(name);

  return (
    (
      [
        APP_PRICING_PLAN_KEYS.premium,
        APP_PRICING_PLAN_KEYS.pro,
        APP_PRICING_PLAN_KEYS.basic,
      ] as AppPricingPlanKey[]
    ).find((planKey) => normalizedName.includes(planKey)) ?? null
  );
}

async function getCurrentManualBillingSubscription({
  admin,
}: {
  admin: AdminGraphqlClient;
}) {
  const response = await admin.graphql(MANUAL_SUBSCRIPTION_QUERY);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: Array<{
          id?: string | null;
          name?: string | null;
          status?: string | null;
          test?: boolean | null;
          trialDays?: number | null;
          createdAt?: string | null;
          currentPeriodEnd?: string | null;
          lineItems?: Array<{
            id?: string | null;
            plan?: {
              pricingDetails?: {
                price?: {
                  amount?: number | string | null;
                  currencyCode?: string | null;
                } | null;
              } | null;
            } | null;
          }> | null;
        }> | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };

  if (json.errors?.length) {
    throw new Error(json.errors[0]?.message || "Manual billing query failed.");
  }

  const activeSubscription =
    json.data?.currentAppInstallation?.activeSubscriptions?.find(
      (subscription) => subscription.status?.trim().toUpperCase() === "ACTIVE",
    ) ?? null;
  const planKey = getManualPlanKey(activeSubscription?.name);

  if (!activeSubscription?.id || !planKey) {
    return null;
  }

  return {
    billingSource: "manual" as const,
    id: activeSubscription.id,
    name:
      activeSubscription.name ?? getAppPricingPlanDefinition(planKey)?.label,
    planKey,
    status: activeSubscription.status ?? "ACTIVE",
    test: activeSubscription.test ?? false,
    createdAt: activeSubscription.createdAt ?? null,
    currentPeriodEnd: activeSubscription.currentPeriodEnd ?? null,
    lineItems:
      activeSubscription.lineItems?.map((lineItem) => ({
        id: lineItem.id ?? null,
        plan: {
          pricingDetails: {
            price: {
              amount: lineItem.plan?.pricingDetails?.price?.amount ?? null,
              currencyCode:
                lineItem.plan?.pricingDetails?.price?.currencyCode ?? null,
            },
          },
        },
      })) ?? [],
  } satisfies ShopifySubscriptionForLystr;
}

export async function getCurrentShopifyBillingSubscription(args: {
  admin: AdminGraphqlClient;
  config: LystrConnectorConfig;
  request: Request;
  shopDomain: string;
  throwOnPartnerApiError?: boolean;
}) {
  if (isShopifyManualBillingEnabled()) {
    try {
      const manualSubscription = await getCurrentManualBillingSubscription({
        admin: args.admin,
      });

      if (manualSubscription) {
        return manualSubscription;
      }
    } catch (error) {
      console.warn(
        "Failed to query Shopify Manual Pricing subscription.",
        error,
      );
    }
  }

  return getCurrentAppPricingSubscription(args);
}

export function getFreeShopifySubscription(
  shopDomain: string,
  config: LystrConnectorConfig,
) {
  const definition = getAppPricingPlanDefinition(APP_PRICING_PLAN_KEYS.free);
  const handle = definition?.handles[0] ?? "free-plan";

  return subscriptionFromPlanHandle({
    billingSource: "manual",
    config,
    planHandle: handle,
    shopDomain,
  });
}

export function buildManualBillingReturnUrl({
  cancelLegacySubscription,
  deferredPlanChange = false,
  launchUrl,
  planKey,
}: {
  cancelLegacySubscription: boolean;
  deferredPlanChange?: boolean;
  launchUrl: string;
  planKey: AppPricingPlanKey;
}) {
  const url = new URL(launchUrl);

  if (url.protocol !== "https:") {
    throw new Error("Shopify returned an invalid app launch URL.");
  }

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/app`;
  url.search = "";
  url.hash = "";
  url.searchParams.set("billing_return", "1");
  url.searchParams.set("requested_plan", planKey);

  if (cancelLegacySubscription) {
    url.searchParams.set("cancel_legacy", "1");
  }

  if (deferredPlanChange) {
    url.searchParams.set("deferred_plan_change", "1");
  }

  return url.toString();
}

export async function getManualBillingReturnUrl({
  admin,
  cancelLegacySubscription,
  deferredPlanChange = false,
  planKey,
}: {
  admin: AdminGraphqlClient;
  cancelLegacySubscription: boolean;
  deferredPlanChange?: boolean;
  planKey: AppPricingPlanKey;
}) {
  const response = await admin.graphql(MANUAL_BILLING_RETURN_URL_QUERY);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        launchUrl?: string | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };
  const launchUrl = json.data?.currentAppInstallation?.launchUrl?.trim() ?? "";

  if (json.errors?.length || !launchUrl) {
    throw new Error(
      json.errors?.[0]?.message ||
        "Shopify did not return an authenticated app launch URL.",
    );
  }

  return buildManualBillingReturnUrl({
    cancelLegacySubscription,
    deferredPlanChange,
    launchUrl,
    planKey,
  });
}

export async function createManualBillingSubscription({
  admin,
  config,
  planKey,
  replacementBehavior = "APPLY_IMMEDIATELY",
  returnUrl,
}: {
  admin: AdminGraphqlClient;
  config: LystrConnectorConfig;
  planKey: AppPricingPlanKey;
  replacementBehavior?:
    | "APPLY_IMMEDIATELY"
    | "APPLY_ON_NEXT_BILLING_CYCLE"
    | "STANDARD";
  returnUrl: string;
}) {
  if (planKey === APP_PRICING_PLAN_KEYS.free) {
    throw new Error("The free plan does not create a Shopify charge.");
  }

  const definition = getAppPricingPlanDefinition(planKey);
  const price = Number(config.planPrices?.[planKey]);

  if (!definition || !Number.isFinite(price) || price <= 0) {
    throw new Error(
      `${definition?.label ?? planKey} Manual Pricing is not configured.`,
    );
  }

  const response = await admin.graphql(CREATE_MANUAL_SUBSCRIPTION_MUTATION, {
    variables: {
      name: `Lystr ${definition.label}`,
      returnUrl,
      lineItems: [
        {
          plan: {
            appRecurringPricingDetails: {
              price: {
                amount: Number(price.toFixed(2)),
                currencyCode: config.currency.toUpperCase(),
              },
              interval: "EVERY_30_DAYS",
            },
          },
        },
      ],
      replacementBehavior,
      test:
        process.env.SHOPIFY_BILLING_TEST_MODE?.trim().toLowerCase() === "true",
    },
  });
  const json = (await response.json()) as {
    data?: {
      appSubscriptionCreate?: {
        appSubscription?: {
          id?: string | null;
          status?: string | null;
        } | null;
        confirmationUrl?: string | null;
        userErrors?: Array<{ message?: string | null }> | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };
  const errorMessage =
    json.errors?.[0]?.message ||
    json.data?.appSubscriptionCreate?.userErrors
      ?.map((error) => error.message?.trim())
      .find(Boolean);
  const confirmationUrl =
    json.data?.appSubscriptionCreate?.confirmationUrl?.trim() ?? "";
  const subscriptionId =
    json.data?.appSubscriptionCreate?.appSubscription?.id?.trim() ?? "";

  if (errorMessage || !confirmationUrl || !subscriptionId) {
    throw new Error(
      errorMessage ||
        "Shopify did not return a complete subscription approval response.",
    );
  }

  return {
    confirmationUrl,
    subscriptionId,
  };
}

export async function getShopifyBillingSubscriptionById({
  admin,
  planKey,
  subscriptionId,
}: {
  admin: AdminGraphqlClient;
  planKey?: AppPricingPlanKey | null;
  subscriptionId: string;
}) {
  const response = await admin.graphql(MANUAL_SUBSCRIPTION_BY_ID_QUERY, {
    variables: { id: subscriptionId },
  });
  const json = (await response.json()) as {
    data?: {
      node?: {
        id?: string | null;
        name?: string | null;
        status?: string | null;
        test?: boolean | null;
        trialDays?: number | null;
        createdAt?: string | null;
        currentPeriodEnd?: string | null;
        lineItems?: Array<{
          id?: string | null;
          plan?: {
            pricingDetails?: {
              price?: {
                amount?: number | string | null;
                currencyCode?: string | null;
              } | null;
            } | null;
          } | null;
        }> | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };

  if (json.errors?.length) {
    throw new Error(
      json.errors[0]?.message || "Shopify subscription query failed.",
    );
  }

  const subscription = json.data?.node;
  const resolvedPlanKey = getManualPlanKey(subscription?.name) ?? planKey;

  if (!subscription?.id || !resolvedPlanKey) {
    return null;
  }

  return {
    billingSource: "manual" as const,
    id: subscription.id,
    name:
      subscription.name ?? getAppPricingPlanDefinition(resolvedPlanKey)?.label,
    planKey: resolvedPlanKey,
    status: subscription.status ?? null,
    test: subscription.test ?? false,
    createdAt: subscription.createdAt ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd ?? null,
    lineItems:
      subscription.lineItems?.map((lineItem) => ({
        id: lineItem.id ?? null,
        plan: {
          pricingDetails: {
            price: {
              amount: lineItem.plan?.pricingDetails?.price?.amount ?? null,
              currencyCode:
                lineItem.plan?.pricingDetails?.price?.currencyCode ?? null,
            },
          },
        },
      })) ?? [],
  } satisfies ShopifySubscriptionForLystr;
}

export async function getLatestPendingManualBillingSubscription({
  admin,
}: {
  admin: AdminGraphqlClient;
}) {
  const response = await admin.graphql(MANUAL_PENDING_SUBSCRIPTIONS_QUERY);
  const json = (await response.json()) as {
    data?: {
      currentAppInstallation?: {
        allSubscriptions?: {
          nodes?: Array<{
            id?: string | null;
            name?: string | null;
            status?: string | null;
            test?: boolean | null;
            trialDays?: number | null;
            createdAt?: string | null;
            currentPeriodEnd?: string | null;
            lineItems?: ShopifySubscriptionForLystr["lineItems"] | null;
          }> | null;
        } | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };

  if (json.errors?.length) {
    throw new Error(
      json.errors[0]?.message || "Shopify pending subscription query failed.",
    );
  }

  const pendingSubscription =
    json.data?.currentAppInstallation?.allSubscriptions?.nodes?.find(
      (subscription) =>
        subscription.status?.trim().toUpperCase() === "PENDING" &&
        Boolean(getManualPlanKey(subscription.name)),
    ) ?? null;
  const planKey = getManualPlanKey(pendingSubscription?.name);

  if (!pendingSubscription?.id || !planKey) {
    return null;
  }

  return {
    billingSource: "manual" as const,
    id: pendingSubscription.id,
    name:
      pendingSubscription.name ??
      getAppPricingPlanDefinition(planKey)?.label ??
      planKey,
    planKey,
    status: pendingSubscription.status ?? "PENDING",
    test: pendingSubscription.test ?? false,
    createdAt: pendingSubscription.createdAt ?? null,
    currentPeriodEnd: pendingSubscription.currentPeriodEnd ?? null,
    lineItems: pendingSubscription.lineItems ?? [],
  } satisfies ShopifySubscriptionForLystr;
}

function getLegacyRecurringChargeId(subscriptionId: string) {
  const match = subscriptionId
    .trim()
    .match(/^gid:\/\/shopify\/AppSubscription\/(\d+)$/);

  return match?.[1] ?? null;
}

export async function recoverManualBillingApprovalUrl({
  accessToken,
  shopDomain,
  subscriptionId,
}: {
  accessToken: string;
  shopDomain: string;
  subscriptionId: string;
}) {
  // GraphQL returns confirmationUrl only from appSubscriptionCreate; the
  // AppSubscription object cannot return it later. This legacy read is only a
  // recovery bridge for approvals created before Lystr persisted that URL.
  const chargeId = getLegacyRecurringChargeId(subscriptionId);

  if (!chargeId) {
    return null;
  }

  const response = await fetch(
    `https://${shopDomain}/admin/api/${LEGACY_REST_BILLING_API_VERSION}/recurring_application_charges/${chargeId}.json`,
    {
      headers: {
        accept: "application/json",
        "x-shopify-access-token": accessToken,
      },
    },
  );
  const json = (await response.json().catch(() => null)) as {
    recurring_application_charge?: {
      confirmation_url?: string | null;
      created_at?: string | null;
      id?: number | string | null;
      status?: string | null;
    } | null;
    errors?: unknown;
  } | null;

  if (!response.ok) {
    throw new Error(
      `Shopify could not recover the pending approval (${response.status}).`,
    );
  }

  const charge = json?.recurring_application_charge;
  const confirmationUrl = charge?.confirmation_url?.trim() ?? "";
  const status = charge?.status?.trim().toUpperCase() ?? "";

  if (status !== "PENDING" || !confirmationUrl) {
    return null;
  }

  const parsedConfirmationUrl = new URL(confirmationUrl);

  if (parsedConfirmationUrl.protocol !== "https:") {
    throw new Error("Shopify returned an invalid billing approval URL.");
  }

  return {
    confirmationUrl: parsedConfirmationUrl.toString(),
    createdAt: charge?.created_at ?? null,
  };
}

export async function cancelManualBillingSubscription({
  admin,
  subscriptionId,
}: {
  admin: AdminGraphqlClient;
  subscriptionId: string;
}) {
  const response = await admin.graphql(CANCEL_MANUAL_SUBSCRIPTION_MUTATION, {
    variables: { id: subscriptionId },
  });
  const json = (await response.json()) as {
    data?: {
      appSubscriptionCancel?: {
        appSubscription?: {
          id?: string | null;
          status?: string | null;
        } | null;
        userErrors?: Array<{ message?: string | null }> | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };
  const errorMessage =
    json.errors?.[0]?.message ||
    json.data?.appSubscriptionCancel?.userErrors
      ?.map((error) => error.message?.trim())
      .find(Boolean);

  if (errorMessage) {
    throw new Error(errorMessage);
  }

  const cancelledSubscription =
    json.data?.appSubscriptionCancel?.appSubscription;
  const cancelledStatus =
    cancelledSubscription?.status?.trim().toUpperCase() ?? "";

  if (
    cancelledSubscription?.id !== subscriptionId ||
    (cancelledStatus !== "CANCELLED" && cancelledStatus !== "CANCELED")
  ) {
    throw new Error(
      "Shopify did not confirm cancellation of the active subscription.",
    );
  }
}

export async function cancelCurrentAppPricingSubscription({
  admin,
}: {
  admin: AdminGraphqlClient;
}) {
  const partnerConfig = getPartnerApiConfig();

  if (!partnerConfig) {
    throw new Error("Shopify Partner API credentials are not configured.");
  }

  const { appId, shopId } = await getInstalledAppAndShopGids(admin);
  const response = await fetch(
    `https://partners.shopify.com/${partnerConfig.organizationId}/api/${PARTNER_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-shopify-access-token": partnerConfig.token,
      },
      body: JSON.stringify({
        query: PARTNER_CANCEL_SUBSCRIPTION_MUTATION,
        variables: {
          appId,
          shopId,
          prorate: false,
          skipFinalUsageCharge: false,
          deferCancellation: false,
        },
      }),
    },
  );
  const json = (await response.json()) as {
    data?: {
      appSubscriptionCancel?: {
        userErrors?: Array<{ message?: string | null }> | null;
      } | null;
    };
    errors?: Array<{ message?: string | null }>;
  };
  const errorMessage =
    json.errors?.[0]?.message ||
    json.data?.appSubscriptionCancel?.userErrors
      ?.map((error) => error.message?.trim())
      .find(Boolean);

  if (
    errorMessage?.toLowerCase().includes("no active billing contract") ||
    errorMessage?.toLowerCase().includes("no active subscription")
  ) {
    return;
  }

  if (!response.ok || errorMessage) {
    throw new Error(
      errorMessage || "Shopify could not cancel the App Pricing subscription.",
    );
  }
}
