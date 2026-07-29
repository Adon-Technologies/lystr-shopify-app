import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import {
  syncLystrConnectorBilling,
  updateLystrConnectorPlanTransition,
  type ShopifySubscriptionForLystr,
} from "../lystr.server";
import { getShopifyBillingSubscriptionById } from "../shopify-app-pricing.server";
import { getAppPricingPlanKeyFromHandle } from "../shopify-app-pricing-plans.server";
import {
  SHOPIFY_BILLING_ATTEMPT_STATES,
  clearShopifyBillingAttempt,
  getShopifyBillingAttempt,
} from "../shopify-billing-attempt.server";

type AppSubscriptionWebhookPayload = {
  app_subscription?: {
    admin_graphql_api_id?: string | null;
    created_at?: string | null;
    currency?: string | null;
    name?: string | null;
    plan_handle?: string | null;
    price?: number | string | null;
    status?: string | null;
    test?: boolean | null;
  } | null;
};

function getWebhookPlanKey(name: string | null | undefined) {
  const normalizedName = name?.trim().toLowerCase() ?? "";

  return (
    (["premium", "basic", "pro", "free"] as const).find((planKey) =>
      normalizedName.includes(planKey),
    ) ?? null
  );
}

function isPaidPlanKey(
  value: string | null | undefined,
): value is "basic" | "pro" | "premium" {
  return value === "basic" || value === "pro" || value === "premium";
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const webhookSubscription = (payload as AppSubscriptionWebhookPayload | null)
    ?.app_subscription;
  const subscriptionId =
    webhookSubscription?.admin_graphql_api_id?.trim() ?? "";
  const subscriptionStatus = webhookSubscription?.status?.trim() ?? "";
  const webhookPlanKey =
    getAppPricingPlanKeyFromHandle(webhookSubscription?.plan_handle) ??
    getWebhookPlanKey(webhookSubscription?.name);
  const rawWebhookPrice = webhookSubscription?.price;
  const parsedWebhookPrice =
    typeof rawWebhookPrice === "number"
      ? rawWebhookPrice
      : rawWebhookPrice?.trim()
        ? Number(rawWebhookPrice)
        : Number.NaN;
  const webhookPrice =
    rawWebhookPrice !== null &&
    rawWebhookPrice !== undefined &&
    Number.isFinite(parsedWebhookPrice) &&
    parsedWebhookPrice >= 0
      ? parsedWebhookPrice
      : null;

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!subscriptionId || !subscriptionStatus) {
    console.error(
      "Shopify subscription update webhook did not include a subscription ID and status.",
    );
    return new Response("Invalid Shopify subscription update payload.", {
      status: 400,
    });
  }

  const fallbackSubscription: ShopifySubscriptionForLystr = {
    billingSource: "manual",
    id: subscriptionId,
    name: webhookSubscription?.name?.trim() || null,
    planKey: webhookPlanKey,
    status: subscriptionStatus,
    test:
      typeof webhookSubscription?.test === "boolean"
        ? webhookSubscription.test
        : null,
    createdAt: webhookSubscription?.created_at?.trim() || null,
    lineItems:
      webhookPrice !== null
        ? [
            {
              id: webhookSubscription?.plan_handle?.trim() || null,
              plan: {
                pricingDetails: {
                  price: {
                    amount: webhookPrice,
                    currencyCode: webhookSubscription?.currency?.trim() || null,
                  },
                },
              },
            },
          ]
        : [],
  };
  let shopifySubscription = fallbackSubscription;
  let subscriptionWasEnriched = false;
  let subscriptionLookupSucceeded = false;

  if (admin) {
    try {
      const subscription = await getShopifyBillingSubscriptionById({
        admin,
        planKey: webhookPlanKey,
        subscriptionId,
      });
      subscriptionLookupSucceeded = true;

      if (subscription) {
        shopifySubscription = {
          ...subscription,
          // The webhook identifies the exact subscription. Use Shopify's
          // current queried status so a delayed PENDING retry cannot regress an
          // already ACTIVE subscription.
          id: subscriptionId,
          status: subscription.status?.trim() || subscriptionStatus,
        };
        subscriptionWasEnriched = true;
      }
    } catch (error) {
      console.warn(
        `Failed to enrich Shopify subscription ${subscriptionId}; syncing the authenticated webhook payload instead.`,
        error,
      );
    }
  }

  const resolvedSubscriptionStatus =
    shopifySubscription.status?.trim().toUpperCase() ?? "";
  const webhookSubscriptionStatus = subscriptionStatus.toUpperCase();
  const canUseTerminalWebhookFallback = [
    "CANCELLED",
    "CANCELED",
    "DECLINED",
    "EXPIRED",
  ].includes(webhookSubscriptionStatus);
  const needsCompleteActiveSubscription =
    resolvedSubscriptionStatus === "ACTIVE" ||
    resolvedSubscriptionStatus === "ACCEPTED";

  if (
    !subscriptionLookupSucceeded ||
    (!subscriptionWasEnriched && !canUseTerminalWebhookFallback) ||
    (needsCompleteActiveSubscription && !shopifySubscription.currentPeriodEnd)
  ) {
    console.error(
      `Could not load complete billing-period data for active Shopify subscription ${subscriptionId}.`,
    );
    return new Response(
      "Could not verify the active Shopify subscription. Retry the webhook.",
      { status: 502 },
    );
  }

  try {
    const billingAttempt = await getShopifyBillingAttempt(shop);
    const attemptPlanKey = isPaidPlanKey(billingAttempt?.planKey)
      ? billingAttempt.planKey
      : null;
    const attemptMatchesSubscription =
      billingAttempt?.subscriptionId === subscriptionId;
    const canAttachUnassignedAttempt = Boolean(
      billingAttempt &&
      billingAttempt.state === SHOPIFY_BILLING_ATTEMPT_STATES.creating &&
      !billingAttempt.subscriptionId &&
      attemptPlanKey &&
      attemptPlanKey === shopifySubscription.planKey,
    );
    let attemptWasCorrelated = attemptMatchesSubscription;

    if (
      billingAttempt &&
      attemptPlanKey &&
      (attemptMatchesSubscription || canAttachUnassignedAttempt) &&
      ["PENDING", "ACTIVE", "ACCEPTED"].includes(resolvedSubscriptionStatus)
    ) {
      const scheduled = await updateLystrConnectorPlanTransition({
        action: "schedule",
        activatesAt: (
          billingAttempt.activatesAt ?? billingAttempt.createdAt
        ).toISOString(),
        pendingSubscriptionId: subscriptionId,
        planKey: attemptPlanKey,
        shopDomain: shop,
        status: "PENDING_APPROVAL",
      });
      const scheduledCurrentStatus =
        scheduled.connector.shopifySubscriptionStatus?.trim().toUpperCase() ??
        "";
      const scheduleConfirmedPending =
        scheduled.connector.pendingShopifySubscriptionId === subscriptionId &&
        scheduled.connector.pendingShopifyPlanKey === attemptPlanKey &&
        (scheduled.connector.pendingShopifyPlanStatus === "PENDING_APPROVAL" ||
          scheduled.connector.pendingShopifyPlanStatus === "APPROVED");
      const scheduleConfirmedCurrent =
        scheduled.connector.shopifySubscriptionId === subscriptionId &&
        (scheduledCurrentStatus === "ACTIVE" ||
          scheduledCurrentStatus === "ACCEPTED");

      if (!scheduleConfirmedPending && !scheduleConfirmedCurrent) {
        throw new Error(
          "Lystr did not correlate the Shopify billing transition.",
        );
      }

      attemptWasCorrelated =
        attemptMatchesSubscription || scheduleConfirmedPending;
    }

    const synced = await syncLystrConnectorBilling({
      shopDomain: shop,
      shopifySubscription,
      shopifyWebhookId: webhookId,
    });

    if (
      resolvedSubscriptionStatus === "ACTIVE" ||
      resolvedSubscriptionStatus === "ACCEPTED"
    ) {
      const syncedCurrentStatus =
        synced.connector.shopifySubscriptionStatus?.trim().toUpperCase() ?? "";
      const syncConfirmedSubscription =
        (synced.connector.shopifySubscriptionId === subscriptionId &&
          (syncedCurrentStatus === "ACTIVE" ||
            syncedCurrentStatus === "ACCEPTED")) ||
        (synced.connector.pendingShopifySubscriptionId === subscriptionId &&
          synced.connector.pendingShopifyPlanStatus === "APPROVED");

      if (!syncConfirmedSubscription) {
        throw new Error("Lystr did not adopt the active Shopify subscription.");
      }
    }

    if (
      resolvedSubscriptionStatus !== "PENDING" &&
      billingAttempt &&
      attemptWasCorrelated
    ) {
      const latestAttempt = await getShopifyBillingAttempt(shop);

      if (
        latestAttempt &&
        (latestAttempt.id !== billingAttempt.id ||
          latestAttempt.updatedAt.getTime() !==
            billingAttempt.updatedAt.getTime())
      ) {
        if (synced.connector.pendingShopifySubscriptionId === subscriptionId) {
          await updateLystrConnectorPlanTransition({
            action: "clear",
            expectedPendingSubscriptionId: subscriptionId,
            shopDomain: shop,
          });
        }

        throw new Error(
          "The local Shopify billing attempt changed during reconciliation.",
        );
      }

      if (latestAttempt) {
        await clearShopifyBillingAttempt({
          attemptId: billingAttempt.id,
          expectedUpdatedAt: billingAttempt.updatedAt,
          shopDomain: shop,
        });
      }
    }
  } catch (error) {
    console.error("Failed to sync Lystr Shopify subscription update.", error);
    return new Response("Failed to sync Shopify subscription update.", {
      status: 502,
    });
  }

  return new Response();
};
