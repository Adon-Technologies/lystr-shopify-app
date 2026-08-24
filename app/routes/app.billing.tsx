import { useEffect } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useRevalidator,
} from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import styles from "../styles/app-billing.module.css";
import {
  cancelLystrConnectorBilling,
  connectLystrStore,
  getClaimedLystrStoreId,
  getLystrConnectorConfig,
  getLystrConnectorStatus,
  hasVerifiedLystrStoreClaim,
  recordLystrConnectorAuditEvent,
  syncLystrConnectorBilling,
  updateLystrConnectorPlanTransition,
  type LystrConnectorStatus,
  type ShopifySubscriptionForLystr,
} from "../lystr.server";
import {
  cancelManualBillingSubscription,
  createManualBillingSubscription,
  getAppPricingPlanSelectionUrl,
  getCurrentShopifyBillingSubscription,
  getFreeShopifySubscription,
  getLatestPendingManualBillingSubscription,
  getManualBillingReturnUrl,
  getShopifyBillingSubscriptionById,
  isShopifyManualBillingEnabled,
  recoverManualBillingApprovalUrl,
} from "../shopify-app-pricing.server";
import {
  SHOPIFY_BILLING_ATTEMPT_STATES,
  acquireShopifyBillingCreationLease,
  clearShopifyBillingAttempt,
  getShopifyBillingAttempt,
  hasResumableShopifyBillingAttempt,
  releaseShopifyBillingCreationLease,
  savePendingShopifyBillingAttempt,
  waitForPendingShopifyBillingAttempt,
} from "../shopify-billing-attempt.server";

const PLAN_KEYS = ["free", "basic", "pro", "premium"] as const;
type BillingPlanKey = (typeof PLAN_KEYS)[number];
type PaidBillingPlanKey = Exclude<BillingPlanKey, "free">;

const TERMINAL_PENDING_SUBSCRIPTION_STATUSES = new Set([
  "CANCELLED",
  "CANCELED",
  "DECLINED",
  "EXPIRED",
]);

const PLAN_LABELS: Record<BillingPlanKey, string> = {
  free: "Free",
  basic: "Basic",
  pro: "Pro",
  premium: "Premium",
};

function isPlanKey(value: FormDataEntryValue | null): value is BillingPlanKey {
  return (
    typeof value === "string" && PLAN_KEYS.includes(value as BillingPlanKey)
  );
}

function isPaidPlanKey(
  value: string | null | undefined,
): value is PaidBillingPlanKey {
  return value === "basic" || value === "pro" || value === "premium";
}

async function getClaimedLystrStore(
  connector: LystrConnectorStatus | null | undefined,
) {
  const storeId = getClaimedLystrStoreId(connector);

  return storeId ? prisma.store.findUnique({ where: { id: storeId } }) : null;
}

function formatPrice(value: number, currency: string) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(date);
}

function getSubscriptionPrice(
  subscription?: ShopifySubscriptionForLystr | null,
) {
  const amount = Number(
    subscription?.lineItems?.[0]?.plan?.pricingDetails?.price?.amount,
  );

  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

function getSubscriptionCurrency(
  subscription?: ShopifySubscriptionForLystr | null,
) {
  return (
    subscription?.lineItems?.[0]?.plan?.pricingDetails?.price?.currencyCode
      ?.trim()
      .toLowerCase() ?? ""
  );
}

function getSubscriptionEnd(
  subscription: ShopifySubscriptionForLystr | null,
  connector: LystrConnectorStatus | null,
) {
  return subscription?.currentPeriodEnd ?? connector?.nextBillingDate ?? null;
}

function hasRemainingPaidAccess({
  connector,
  currentPlanKey,
  subscription,
}: {
  connector: LystrConnectorStatus | null;
  currentPlanKey: string | null;
  subscription: ShopifySubscriptionForLystr | null;
}) {
  if (!currentPlanKey || currentPlanKey === "free") {
    return false;
  }

  const status = (
    subscription?.status ??
    connector?.shopifySubscriptionStatus ??
    connector?.status
  )
    ?.trim()
    .toUpperCase();
  const periodEnd = getSubscriptionEnd(subscription, connector);
  const periodEndDate = periodEnd ? new Date(periodEnd) : null;

  return Boolean(
    connector?.accessAllowed &&
    status !== "FROZEN" &&
    status !== "DECLINED" &&
    status !== "EXPIRED" &&
    periodEndDate &&
    !Number.isNaN(periodEndDate.getTime()) &&
    periodEndDate.getTime() > Date.now(),
  );
}

type PendingApprovalState = {
  confirmationUrl: string | null;
  message: string | null;
  planKey: PaidBillingPlanKey | null;
  status: "PENDING" | "PROCESSING" | "UNAVAILABLE";
  subscriptionId: string | null;
};

type BillingActionData = {
  approvalUrl?: string;
  error?: string;
  redirectUrl?: string;
};

function approvalNavigationResponse(approvalUrl: string) {
  const parsedUrl = new URL(approvalUrl);

  if (parsedUrl.protocol !== "https:") {
    throw new Error("Shopify returned an invalid billing approval URL.");
  }

  return Response.json({
    approvalUrl: parsedUrl.toString(),
  } satisfies BillingActionData);
}

function appNavigationResponse(redirectUrl: string) {
  if (!redirectUrl.startsWith("/app")) {
    throw new Error("Lystr returned an invalid in-app billing destination.");
  }

  return Response.json({ redirectUrl } satisfies BillingActionData);
}

function parseDate(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

async function persistRecoveredApproval({
  accessToken,
  activatesAt,
  attemptConfirmationUrl,
  attemptSubscriptionId,
  planKey,
  requestToken,
  shopDomain,
  subscription,
}: {
  accessToken: string;
  activatesAt?: Date | null;
  attemptConfirmationUrl?: string | null;
  attemptSubscriptionId?: string | null;
  planKey: PaidBillingPlanKey;
  requestToken?: string | null;
  shopDomain: string;
  subscription: ShopifySubscriptionForLystr;
}) {
  const subscriptionId = subscription.id?.trim() ?? "";

  if (!subscriptionId) {
    return null;
  }

  let confirmationUrl =
    attemptSubscriptionId === subscriptionId
      ? (attemptConfirmationUrl?.trim() ?? "")
      : "";
  let recoveredCreatedAt: string | null = null;

  if (!confirmationUrl) {
    const recovered = await recoverManualBillingApprovalUrl({
      accessToken,
      shopDomain,
      subscriptionId,
    });
    confirmationUrl = recovered?.confirmationUrl ?? "";
    recoveredCreatedAt = recovered?.createdAt ?? null;
  }

  if (!confirmationUrl) {
    return null;
  }

  const createdAt =
    parseDate(subscription.createdAt) ??
    parseDate(recoveredCreatedAt) ??
    new Date();

  const savedAttempt = await savePendingShopifyBillingAttempt({
    activatesAt,
    confirmationUrl,
    createdAt,
    planKey,
    requestToken,
    shopDomain,
    subscriptionId,
  }).catch((error) => {
    console.error("Failed to persist the Shopify approval URL.", error);
    return undefined;
  });

  if (
    savedAttempt &&
    (savedAttempt.state !== SHOPIFY_BILLING_ATTEMPT_STATES.pending ||
      savedAttempt.subscriptionId !== subscriptionId)
  ) {
    return null;
  }

  return {
    confirmationUrl,
    planKey,
    subscriptionId,
  };
}

async function discoverPendingShopifyApproval({
  accessToken,
  activatesAt,
  admin,
  attemptConfirmationUrl,
  attemptSubscriptionId,
  planKeyHint,
  requestToken,
  shopDomain,
}: {
  accessToken: string;
  activatesAt?: Date | null;
  admin: Parameters<
    typeof getLatestPendingManualBillingSubscription
  >[0]["admin"];
  attemptConfirmationUrl?: string | null;
  attemptSubscriptionId?: string | null;
  planKeyHint?: PaidBillingPlanKey | null;
  requestToken?: string | null;
  shopDomain: string;
}) {
  const pendingSubscription = await getLatestPendingManualBillingSubscription({
    admin,
  });
  const pendingPlanKey = isPaidPlanKey(pendingSubscription?.planKey)
    ? pendingSubscription.planKey
    : planKeyHint;

  if (!pendingSubscription || !pendingPlanKey) {
    return null;
  }

  const approval = await persistRecoveredApproval({
    accessToken,
    activatesAt,
    attemptConfirmationUrl,
    attemptSubscriptionId,
    planKey: pendingPlanKey,
    requestToken,
    shopDomain,
    subscription: pendingSubscription,
  });

  return {
    approval,
    planKey: pendingPlanKey,
    subscription: pendingSubscription,
    subscriptionId: pendingSubscription.id,
  };
}

async function startManualBillingApproval({
  accessToken,
  activatesAt,
  admin,
  config,
  planKey,
  requestToken,
  replacementBehavior,
  returnUrl,
  shopDomain,
}: {
  accessToken: string;
  activatesAt: string;
  admin: Parameters<typeof createManualBillingSubscription>[0]["admin"];
  config: Parameters<typeof createManualBillingSubscription>[0]["config"];
  planKey: PaidBillingPlanKey;
  requestToken: string;
  replacementBehavior:
    | "APPLY_IMMEDIATELY"
    | "APPLY_ON_NEXT_BILLING_CYCLE"
    | "STANDARD";
  returnUrl: string;
  shopDomain: string;
}) {
  try {
    const preexisting = await discoverPendingShopifyApproval({
      accessToken,
      activatesAt: parseDate(activatesAt),
      admin,
      planKeyHint: planKey,
      requestToken,
      shopDomain,
    });

    if (preexisting) {
      await updateLystrConnectorPlanTransition({
        action: "schedule",
        activatesAt,
        pendingSubscriptionId: preexisting.subscriptionId,
        planKey: preexisting.planKey,
        shopDomain,
        status: "PENDING_APPROVAL",
      }).catch((error) => {
        console.error(
          "Failed to mirror the recovered Shopify approval in Lystr.",
          error,
        );
      });

      if (preexisting.planKey !== planKey) {
        throw new Error(
          `${PLAN_LABELS[preexisting.planKey]} is already waiting for Shopify approval. Continue or decline that approval before choosing another plan.`,
        );
      }

      if (!preexisting.approval) {
        throw new Error(
          "Shopify is waiting for approval, but Lystr could not restore the approval link. Reload to retry.",
        );
      }

      return preexisting.approval;
    }

    let pending;

    try {
      pending = await createManualBillingSubscription({
        admin,
        config,
        planKey,
        replacementBehavior,
        returnUrl,
      });
    } catch (error) {
      const discovered = await discoverPendingShopifyApproval({
        accessToken,
        activatesAt: parseDate(activatesAt),
        admin,
        planKeyHint: planKey,
        requestToken,
        shopDomain,
      });

      if (discovered) {
        await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt,
          pendingSubscriptionId: discovered.subscriptionId,
          planKey: discovered.planKey,
          shopDomain,
          status: "PENDING_APPROVAL",
        }).catch((syncError) => {
          console.error(
            "Failed to mirror the existing Shopify approval in Lystr.",
            syncError,
          );
        });

        if (discovered.planKey !== planKey) {
          throw new Error(
            `${PLAN_LABELS[discovered.planKey]} is already waiting for Shopify approval. Continue or decline that approval before choosing another plan.`,
          );
        }

        if (!discovered.approval) {
          throw new Error(
            "Shopify is waiting for approval, but Lystr could not restore the approval link. Reload to retry.",
          );
        }

        return discovered.approval;
      }

      throw error;
    }

    const savedAttempt = await savePendingShopifyBillingAttempt({
      activatesAt: parseDate(activatesAt),
      confirmationUrl: pending.confirmationUrl,
      planKey,
      requestToken,
      shopDomain,
      subscriptionId: pending.subscriptionId,
    });

    if (
      savedAttempt?.state !== SHOPIFY_BILLING_ATTEMPT_STATES.pending ||
      savedAttempt.subscriptionId !== pending.subscriptionId ||
      savedAttempt.planKey !== planKey
    ) {
      if (
        hasResumableShopifyBillingAttempt(savedAttempt) &&
        isPaidPlanKey(savedAttempt?.planKey)
      ) {
        if (savedAttempt.planKey !== planKey) {
          throw new Error(
            `${PLAN_LABELS[savedAttempt.planKey]} is already waiting for Shopify approval. Continue or decline that approval before choosing another plan.`,
          );
        }

        return {
          confirmationUrl: savedAttempt.confirmationUrl!,
          planKey: savedAttempt.planKey,
          subscriptionId: savedAttempt.subscriptionId!,
        };
      }

      throw new Error(
        "Another Shopify billing request replaced this approval before Lystr could save it. Reload to continue the latest request.",
      );
    }

    await updateLystrConnectorPlanTransition({
      action: "schedule",
      activatesAt,
      pendingSubscriptionId: pending.subscriptionId,
      planKey,
      shopDomain,
      status: "PENDING_APPROVAL",
    }).catch((error) => {
      // The Shopify approval is still valid and recoverable. The approval
      // callback and subscription webhook both reconcile the central record.
      console.error(
        "Failed to mirror the new Shopify approval in Lystr.",
        error,
      );
    });

    return {
      confirmationUrl: pending.confirmationUrl,
      planKey,
      subscriptionId: pending.subscriptionId,
    };
  } catch (error) {
    await releaseShopifyBillingCreationLease({
      requestToken,
      shopDomain,
    }).catch(() => undefined);
    throw error;
  }
}

async function reconcilePendingBillingApproval({
  accessToken,
  admin,
  connector: initialConnector,
  currentSubscription,
  ownedRequestToken,
  shopDomain,
}: {
  accessToken?: string | null;
  admin: Parameters<typeof getShopifyBillingSubscriptionById>[0]["admin"];
  connector: LystrConnectorStatus | null;
  currentSubscription: ShopifySubscriptionForLystr | null;
  ownedRequestToken?: string | null;
  shopDomain: string;
}) {
  let connector = initialConnector;
  let attempt = await getShopifyBillingAttempt(shopDomain);
  const ownsCreationLease = Boolean(
    ownedRequestToken &&
    attempt?.state === SHOPIFY_BILLING_ATTEMPT_STATES.creating &&
    attempt.requestToken === ownedRequestToken,
  );
  const originalCentralPendingSubscriptionId =
    connector?.pendingShopifySubscriptionId?.trim() || "";
  let pendingDiscoveryFailed = false;
  let subscriptionId =
    connector?.pendingShopifySubscriptionId?.trim() ||
    attempt?.subscriptionId?.trim() ||
    "";

  if (!subscriptionId) {
    if (
      attempt?.state === SHOPIFY_BILLING_ATTEMPT_STATES.creating &&
      !ownsCreationLease &&
      (!attempt.leaseExpiresAt || attempt.leaseExpiresAt.getTime() > Date.now())
    ) {
      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message: "Shopify is preparing the billing approval.",
          planKey: isPaidPlanKey(attempt.planKey) ? attempt.planKey : null,
          status: "PROCESSING",
          subscriptionId: null,
        } satisfies PendingApprovalState,
      };
    }

    if (attempt && accessToken) {
      const discovered = await discoverPendingShopifyApproval({
        accessToken,
        activatesAt:
          parseDate(connector?.pendingShopifyPlanActivatesAt) ??
          attempt.activatesAt,
        admin,
        attemptConfirmationUrl: attempt.confirmationUrl,
        attemptSubscriptionId: attempt.subscriptionId,
        planKeyHint: isPaidPlanKey(attempt.planKey) ? attempt.planKey : null,
        requestToken: attempt.requestToken,
        shopDomain,
      }).catch((error) => {
        console.error("Failed to discover a pending Shopify approval.", error);
        pendingDiscoveryFailed = true;
        return null;
      });

      if (discovered) {
        subscriptionId = discovered.subscriptionId;
        attempt = (await getShopifyBillingAttempt(shopDomain)) ?? attempt;
      } else if (pendingDiscoveryFailed) {
        return {
          connector,
          pendingApproval: {
            confirmationUrl: hasResumableShopifyBillingAttempt(attempt)
              ? attempt.confirmationUrl
              : null,
            message:
              "Lystr could not check the existing Shopify approval. Reload to retry.",
            planKey: isPaidPlanKey(attempt.planKey) ? attempt.planKey : null,
            status: "UNAVAILABLE",
            subscriptionId: attempt.subscriptionId,
          } satisfies PendingApprovalState,
        };
      } else {
        const currentStatus =
          currentSubscription?.status?.trim().toUpperCase() ?? "";
        const currentSubscriptionCreatedAt = parseDate(
          currentSubscription?.createdAt,
        );
        const canRecoverApprovedCreation = Boolean(
          currentSubscription?.id &&
          currentSubscription.id !== connector?.shopifySubscriptionId &&
          (currentStatus === "ACTIVE" || currentStatus === "ACCEPTED") &&
          isPaidPlanKey(currentSubscription.planKey) &&
          currentSubscription.planKey === attempt.planKey &&
          currentSubscriptionCreatedAt &&
          currentSubscriptionCreatedAt.getTime() >= attempt.createdAt.getTime(),
        );

        if (canRecoverApprovedCreation && currentSubscription?.id) {
          subscriptionId = currentSubscription.id;
        } else {
          if (!ownsCreationLease) {
            await clearShopifyBillingAttempt({
              attemptId: attempt.id,
              expectedUpdatedAt: attempt.updatedAt,
              shopDomain,
            }).catch(() => undefined);
          }
          return { connector, pendingApproval: null };
        }
      }
    } else {
      return { connector, pendingApproval: null };
    }
  }

  let pendingSubscription: ShopifySubscriptionForLystr | null = null;

  try {
    pendingSubscription = await getShopifyBillingSubscriptionById({
      admin,
      planKey:
        (isPaidPlanKey(connector?.pendingShopifyPlanKey)
          ? connector.pendingShopifyPlanKey
          : isPaidPlanKey(attempt?.planKey)
            ? attempt.planKey
            : null) ?? null,
      subscriptionId,
    });
  } catch (error) {
    console.error("Failed to verify the pending Shopify approval.", error);

    return {
      connector,
      pendingApproval: {
        confirmationUrl:
          attempt?.subscriptionId === subscriptionId &&
          hasResumableShopifyBillingAttempt(attempt)
            ? attempt.confirmationUrl
            : null,
        message:
          "Lystr could not verify the pending approval with Shopify. Reload to retry.",
        planKey: isPaidPlanKey(connector?.pendingShopifyPlanKey)
          ? connector.pendingShopifyPlanKey
          : isPaidPlanKey(attempt?.planKey)
            ? attempt.planKey
            : null,
        status: "UNAVAILABLE",
        subscriptionId,
      } satisfies PendingApprovalState,
    };
  }

  if (!pendingSubscription && accessToken) {
    const discovered = await discoverPendingShopifyApproval({
      accessToken,
      activatesAt:
        parseDate(connector?.pendingShopifyPlanActivatesAt) ??
        attempt?.activatesAt,
      admin,
      attemptConfirmationUrl: attempt?.confirmationUrl,
      attemptSubscriptionId: attempt?.subscriptionId,
      planKeyHint: isPaidPlanKey(connector?.pendingShopifyPlanKey)
        ? connector.pendingShopifyPlanKey
        : isPaidPlanKey(attempt?.planKey)
          ? attempt.planKey
          : null,
      requestToken: attempt?.requestToken,
      shopDomain,
    }).catch((error) => {
      console.error("Failed to recover the pending Shopify approval.", error);
      pendingDiscoveryFailed = true;
      return null;
    });

    if (discovered) {
      pendingSubscription = discovered.subscription;
      subscriptionId = discovered.subscriptionId;
      attempt = (await getShopifyBillingAttempt(shopDomain)) ?? attempt;
    }
  }

  if (
    pendingSubscription &&
    originalCentralPendingSubscriptionId &&
    subscriptionId !== originalCentralPendingSubscriptionId
  ) {
    try {
      const cleared = await updateLystrConnectorPlanTransition({
        action: "clear",
        expectedPendingSubscriptionId: originalCentralPendingSubscriptionId,
        shopDomain,
      });
      connector = cleared.connector;

      if (
        connector.pendingShopifySubscriptionId &&
        connector.pendingShopifySubscriptionId !== subscriptionId
      ) {
        return {
          connector,
          pendingApproval: {
            confirmationUrl: null,
            message:
              "Lystr detected a newer Shopify billing decision. Reload to reconcile it before choosing a plan.",
            planKey: isPaidPlanKey(connector.pendingShopifyPlanKey)
              ? connector.pendingShopifyPlanKey
              : null,
            status: "PROCESSING",
            subscriptionId: connector.pendingShopifySubscriptionId,
          } satisfies PendingApprovalState,
        };
      }
    } catch (error) {
      console.error(
        "Failed to replace a stale central Shopify approval.",
        error,
      );
      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message:
            "Lystr is reconciling a newer Shopify approval. Reload to retry.",
          planKey: isPaidPlanKey(attempt?.planKey) ? attempt.planKey : null,
          status: "UNAVAILABLE",
          subscriptionId,
        } satisfies PendingApprovalState,
      };
    }
  }

  if (!pendingSubscription) {
    if (pendingDiscoveryFailed) {
      return {
        connector,
        pendingApproval: {
          confirmationUrl:
            attempt?.subscriptionId === subscriptionId &&
            hasResumableShopifyBillingAttempt(attempt)
              ? attempt.confirmationUrl
              : null,
          message:
            "Lystr could not reconcile the existing Shopify approval. Reload to retry.",
          planKey: isPaidPlanKey(connector?.pendingShopifyPlanKey)
            ? connector.pendingShopifyPlanKey
            : isPaidPlanKey(attempt?.planKey)
              ? attempt.planKey
              : null,
          status: "UNAVAILABLE",
          subscriptionId: subscriptionId || attempt?.subscriptionId || null,
        } satisfies PendingApprovalState,
      };
    }

    try {
      if (connector?.pendingShopifySubscriptionId) {
        const cleared = await updateLystrConnectorPlanTransition({
          action: "clear",
          expectedPendingSubscriptionId: subscriptionId,
          shopDomain,
        });
        connector = cleared.connector;
      }

      if (attempt) {
        await clearShopifyBillingAttempt({
          attemptId: attempt.id,
          expectedUpdatedAt: attempt.updatedAt,
          shopDomain,
        });
      }
      return { connector, pendingApproval: null };
    } catch (error) {
      console.error("Failed to clear a stale Shopify approval.", error);

      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message:
            "Lystr is reconciling an earlier Shopify approval. Reload to retry.",
          planKey: isPaidPlanKey(connector?.pendingShopifyPlanKey)
            ? connector.pendingShopifyPlanKey
            : null,
          status: "PROCESSING",
          subscriptionId,
        } satisfies PendingApprovalState,
      };
    }
  }

  const status = pendingSubscription.status?.trim().toUpperCase() ?? "";
  const planKey = isPaidPlanKey(pendingSubscription.planKey)
    ? pendingSubscription.planKey
    : isPaidPlanKey(connector?.pendingShopifyPlanKey)
      ? connector.pendingShopifyPlanKey
      : isPaidPlanKey(attempt?.planKey)
        ? attempt.planKey
        : null;

  if (status === "PENDING") {
    if (attempt?.subscriptionId && attempt.subscriptionId !== subscriptionId) {
      const staleAttempt = attempt;
      await clearShopifyBillingAttempt({
        attemptId: staleAttempt.id,
        expectedUpdatedAt: staleAttempt.updatedAt,
        shopDomain,
      }).catch(() => undefined);
      attempt = await getShopifyBillingAttempt(shopDomain);

      if (
        attempt?.subscriptionId &&
        attempt.subscriptionId !== subscriptionId
      ) {
        return {
          connector,
          pendingApproval: {
            confirmationUrl: null,
            message:
              "Lystr detected another billing request while restoring this Shopify approval. Reload to continue the latest request.",
            planKey: isPaidPlanKey(attempt.planKey) ? attempt.planKey : planKey,
            status: "PROCESSING",
            subscriptionId: attempt.subscriptionId,
          } satisfies PendingApprovalState,
        };
      }
    }

    if (!accessToken || !planKey) {
      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message:
            "The Shopify approval exists, but Lystr could not restore its approval link.",
          planKey,
          status: "UNAVAILABLE",
          subscriptionId,
        } satisfies PendingApprovalState,
      };
    }

    const currentPlanKey =
      connector?.shopifyPlanKey ?? currentSubscription?.planKey ?? null;
    const remainingPaidAccess = hasRemainingPaidAccess({
      connector,
      currentPlanKey,
      subscription: currentSubscription,
    });
    const activationDate =
      parseDate(connector?.pendingShopifyPlanActivatesAt) ??
      (remainingPaidAccess
        ? parseDate(getSubscriptionEnd(currentSubscription, connector))
        : null) ??
      attempt?.activatesAt ??
      new Date();
    const approval = await persistRecoveredApproval({
      accessToken,
      activatesAt: activationDate,
      attemptConfirmationUrl: attempt?.confirmationUrl,
      attemptSubscriptionId: attempt?.subscriptionId,
      planKey,
      requestToken: attempt?.requestToken,
      shopDomain,
      subscription: pendingSubscription,
    }).catch((error) => {
      console.error("Failed to restore the Shopify approval link.", error);
      return null;
    });

    if (
      connector?.pendingShopifySubscriptionId !== subscriptionId ||
      connector.pendingShopifyPlanKey !== planKey ||
      connector.pendingShopifyPlanStatus !== "PENDING_APPROVAL"
    ) {
      try {
        const scheduled = await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: activationDate.toISOString(),
          pendingSubscriptionId: subscriptionId,
          planKey,
          shopDomain,
          status: "PENDING_APPROVAL",
        });
        connector = scheduled.connector;
      } catch (error) {
        console.error(
          "Failed to mirror the pending Shopify approval in Lystr.",
          error,
        );
      }
    }

    return {
      connector,
      pendingApproval: {
        confirmationUrl: approval?.confirmationUrl ?? null,
        message: approval
          ? null
          : "Shopify is waiting for approval, but the approval link could not be restored. Reload to retry.",
        planKey,
        status: approval ? "PENDING" : "UNAVAILABLE",
        subscriptionId,
      } satisfies PendingApprovalState,
    };
  }

  if (TERMINAL_PENDING_SUBSCRIPTION_STATUSES.has(status)) {
    try {
      if (connector?.pendingShopifySubscriptionId) {
        const cleared = await updateLystrConnectorPlanTransition({
          action: "clear",
          expectedPendingSubscriptionId: subscriptionId,
          shopDomain,
        });
        connector = cleared.connector;
      }

      await clearShopifyBillingAttempt({ shopDomain, subscriptionId });
      return { connector, pendingApproval: null };
    } catch (error) {
      console.error("Failed to clear the completed Shopify approval.", error);

      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message:
            "Lystr is finishing the previous Shopify billing decision. Reload to retry.",
          planKey,
          status: "PROCESSING",
          subscriptionId,
        } satisfies PendingApprovalState,
      };
    }
  }

  if (status === "ACTIVE" || status === "ACCEPTED") {
    try {
      if (planKey) {
        const attemptMatchesSubscription =
          attempt?.subscriptionId === subscriptionId;
        const scheduled = await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: (
            (attemptMatchesSubscription ? attempt?.activatesAt : null) ??
            parseDate(connector?.pendingShopifyPlanActivatesAt) ??
            attempt?.createdAt ??
            new Date()
          ).toISOString(),
          pendingSubscriptionId: subscriptionId,
          planKey,
          shopDomain,
          status: "PENDING_APPROVAL",
        });
        connector = scheduled.connector;
      }

      const synced = await syncLystrConnectorBilling({
        shopDomain,
        shopifySubscription: pendingSubscription,
      });
      connector = synced.connector;
      const centralCurrentStatus =
        connector.shopifySubscriptionStatus?.trim().toUpperCase() ?? "";
      const centralConfirmedSubscription =
        (connector.shopifySubscriptionId === subscriptionId &&
          (centralCurrentStatus === "ACTIVE" ||
            centralCurrentStatus === "ACCEPTED")) ||
        (connector.pendingShopifySubscriptionId === subscriptionId &&
          connector.pendingShopifyPlanStatus === "APPROVED");

      if (!centralConfirmedSubscription) {
        throw new Error(
          "Lystr did not adopt the approved Shopify subscription. Retry reconciliation.",
        );
      }

      const activationDate = parseDate(connector.pendingShopifyPlanActivatesAt);
      const activationIsDue =
        !activationDate || activationDate.getTime() <= Date.now();

      if (activationIsDue && accessToken && connector.storeId) {
        const localStore = await getClaimedLystrStore(connector);
        const connected = await connectLystrStore({
          accessToken,
          apiKey: localStore?.apiKey ?? undefined,
          shopDomain,
          shopifySubscription: pendingSubscription,
        });
        connector = connected.connector;
      }

      if (attempt) {
        const latestAttempt = await getShopifyBillingAttempt(shopDomain);

        if (
          latestAttempt?.id === attempt.id &&
          latestAttempt.updatedAt.getTime() === attempt.updatedAt.getTime() &&
          (!latestAttempt.subscriptionId ||
            latestAttempt.subscriptionId === subscriptionId)
        ) {
          await clearShopifyBillingAttempt({
            attemptId: attempt.id,
            expectedUpdatedAt: attempt.updatedAt,
            shopDomain,
          });
        }
      }
      return { connector, pendingApproval: null };
    } catch (error) {
      console.error("Failed to finalize the approved Shopify plan.", error);

      return {
        connector,
        pendingApproval: {
          confirmationUrl: null,
          message:
            "Shopify approved this plan. Lystr is finishing the connection; reload to retry.",
          planKey,
          status: "PROCESSING",
          subscriptionId,
        } satisfies PendingApprovalState,
      };
    }
  }

  return {
    connector,
    pendingApproval: {
      confirmationUrl: null,
      message:
        "Lystr is waiting for Shopify to finish the previous billing decision.",
      planKey,
      status: "PROCESSING",
      subscriptionId,
    } satisfies PendingApprovalState,
  };
}

async function getVerifiedCurrentSubscription({
  admin,
  connector,
  currentSubscription,
}: {
  admin: Parameters<typeof getShopifyBillingSubscriptionById>[0]["admin"];
  connector: LystrConnectorStatus | null;
  currentSubscription: ShopifySubscriptionForLystr | null;
}) {
  const storedSubscriptionId = connector?.shopifySubscriptionId?.trim();
  const storedPlanKey = connector?.shopifyPlanKey as
    | BillingPlanKey
    | null
    | undefined;

  if (
    storedSubscriptionId &&
    (!currentSubscription ||
      currentSubscription.id !== storedSubscriptionId ||
      currentSubscription.planKey !== storedPlanKey)
  ) {
    const storedSubscription = await getShopifyBillingSubscriptionById({
      admin,
      planKey: storedPlanKey ?? null,
      subscriptionId: storedSubscriptionId,
    }).catch((error) => {
      console.warn("Failed to verify the stored Shopify subscription.", error);
      return null;
    });

    // A mismatched fallback subscription is never safe for cancellation or a
    // plan replacement. Fail closed when Shopify cannot verify the exact
    // centrally stored subscription.
    return storedSubscription;
  }

  return currentSubscription;
}

async function loadBillingState({
  accessToken,
  admin,
  ownedRequestToken,
  request,
  shopDomain,
}: {
  accessToken?: string | null;
  admin: Parameters<typeof getCurrentShopifyBillingSubscription>[0]["admin"];
  ownedRequestToken?: string | null;
  request: Request;
  shopDomain: string;
}) {
  const [{ config }, statusResponse] = await Promise.all([
    getLystrConnectorConfig(),
    getLystrConnectorStatus({ shopDomain }).catch(() => null),
  ]);
  let connector = statusResponse?.connector ?? null;
  let currentSubscription = await getCurrentShopifyBillingSubscription({
    admin,
    config,
    request,
    shopDomain,
  });
  const reconciledPendingApproval = await reconcilePendingBillingApproval({
    accessToken,
    admin,
    connector,
    currentSubscription,
    ownedRequestToken,
    shopDomain,
  });
  connector = reconciledPendingApproval.connector;
  const pendingApproval = reconciledPendingApproval.pendingApproval;

  if (
    connector?.pendingShopifyPlanStatus === "APPROVED" &&
    connector.pendingShopifyPlanActivatesAt &&
    new Date(connector.pendingShopifyPlanActivatesAt).getTime() <= Date.now() &&
    (!connector.reconnectRequired ||
      new URL(request.url).searchParams.get("billing_return") === "1") &&
    currentSubscription?.planKey === connector.pendingShopifyPlanKey
  ) {
    const localStore = await getClaimedLystrStore(connector);

    if (accessToken && connector?.storeId) {
      const result = await connectLystrStore({
        accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain,
        shopifySubscription: currentSubscription,
      }).catch(() => null);

      if (result?.connector) {
        connector = result.connector;
      }
    }
  }

  currentSubscription = await getVerifiedCurrentSubscription({
    admin,
    connector,
    currentSubscription,
  });

  const verifiedStatus =
    currentSubscription?.status?.trim().toUpperCase() ?? "";
  const activePaidSubscription = Boolean(
    currentSubscription?.id &&
    isPaidPlanKey(currentSubscription.planKey) &&
    (verifiedStatus === "ACTIVE" || verifiedStatus === "ACCEPTED"),
  );
  const approvedTransitionActivation = parseDate(
    connector?.pendingShopifyPlanActivatesAt,
  );
  const approvedTransitionIsFuture = Boolean(
    connector?.pendingShopifyPlanStatus === "APPROVED" &&
    approvedTransitionActivation &&
    approvedTransitionActivation.getTime() > Date.now(),
  );
  const activeSubscriptionNeedsAdoption = Boolean(
    activePaidSubscription &&
    !approvedTransitionIsFuture &&
    (!connector?.accessAllowed ||
      connector.shopifySubscriptionId !== currentSubscription?.id),
  );

  if (accessToken && activeSubscriptionNeedsAdoption && currentSubscription) {
    const localStore = await getClaimedLystrStore(connector);

    if (currentSubscription.id && isPaidPlanKey(currentSubscription.planKey)) {
      const scheduled = await updateLystrConnectorPlanTransition({
        action: "schedule",
        activatesAt:
          connector?.pendingShopifyPlanActivatesAt ??
          currentSubscription.createdAt ??
          new Date().toISOString(),
        pendingSubscriptionId: currentSubscription.id,
        planKey: currentSubscription.planKey,
        shopDomain,
        status: "PENDING_APPROVAL",
      }).catch((error) => {
        console.error(
          "Failed to correlate the active Shopify subscription in Lystr.",
          error,
        );
        return null;
      });

      if (!scheduled) {
        return { config, connector, currentSubscription, pendingApproval };
      }

      connector = scheduled.connector;
    }

    const adopted = await connectLystrStore({
      accessToken,
      apiKey: localStore?.apiKey ?? undefined,
      shopDomain,
      shopifySubscription: currentSubscription,
    }).catch((error) => {
      console.error(
        "Failed to adopt the active Shopify subscription in Lystr.",
        error,
      );
      return null;
    });

    if (adopted?.connector) {
      connector = adopted.connector;
    }
  }

  return { config, connector, currentSubscription, pendingApproval };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    throw redirect(getAppPricingPlanSelectionUrl(session.shop), {
      target: "_top",
    });
  }

  const { config, connector, currentSubscription, pendingApproval } =
    await loadBillingState({
      accessToken: session.accessToken,
      admin,
      request,
      shopDomain: session.shop,
    });

  // A shop that has not yet been bound to a Lystr store must never remain on
  // the billing screen. There is no verified user to attach a charge to, and
  // leaving the plans visible turns the safe ownership check into a misleading
  // "connection could not be verified" error when the merchant clicks one.
  if (connector && !hasVerifiedLystrStoreClaim(connector)) {
    throw redirect("/app?connection_required=1");
  }

  const currentPlanKey =
    (connector?.shopifyPlanKey as BillingPlanKey | null | undefined) ??
    (currentSubscription?.planKey as BillingPlanKey | null | undefined) ??
    null;
  const currentSubscriptionPrice =
    getSubscriptionPrice(currentSubscription) ||
    Number(connector?.monthlyPrice ?? 0);
  const remainingPaidAccess = hasRemainingPaidAccess({
    connector,
    currentPlanKey,
    subscription: currentSubscription,
  });
  const currentPeriodEnd = getSubscriptionEnd(currentSubscription, connector);
  const url = new URL(request.url);
  const reconnectRequested = url.searchParams.get("reconnect") === "1";

  if (
    connector?.reconnectRequired === true &&
    remainingPaidAccess &&
    !reconnectRequested
  ) {
    url.searchParams.set("reconnect", "1");
    throw redirect(`${url.pathname}${url.search}`);
  }

  return {
    currency: config.currency,
    currentPeriodEnd,
    currentPlanKey,
    currentPlanName: currentPlanKey ? PLAN_LABELS[currentPlanKey] : null,
    isReconnectMode:
      reconnectRequested ||
      (connector?.reconnectRequired === true && remainingPaidAccess),
    remainingPaidAccess,
    pendingApprovalMessage: pendingApproval?.message ?? null,
    pendingApprovalStatus: pendingApproval?.status ?? null,
    pendingApprovalUrl: pendingApproval?.confirmationUrl ?? null,
    pendingPlanKey:
      pendingApproval?.planKey ??
      (connector?.pendingShopifyPlanKey as BillingPlanKey | null | undefined) ??
      null,
    pendingPlanName: pendingApproval?.planKey
      ? PLAN_LABELS[pendingApproval.planKey]
      : (connector?.pendingShopifyPlanName ?? null),
    pendingPlanStatus:
      pendingApproval?.status === "PENDING"
        ? "PENDING_APPROVAL"
        : (connector?.pendingShopifyPlanStatus ?? null),
    pendingPlanActivatesAt: connector?.pendingShopifyPlanActivatesAt ?? null,
    plans: PLAN_KEYS.map((planKey) => {
      const isFree = planKey === "free";
      const configuredPrice = isFree
        ? 0
        : Number(config.planPrices?.[planKey] ?? 0);
      const displayPrice =
        planKey === currentPlanKey && configuredPrice <= 0
          ? currentSubscriptionPrice
          : configuredPrice;

      return {
        credits: isFree ? 0 : Number(config.planCredits?.[planKey] ?? 0),
        isConfigured: isFree || configuredPrice > 0,
        key: planKey,
        label: PLAN_LABELS[planKey],
        price: displayPrice,
      };
    }),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (!isShopifyManualBillingEnabled()) {
    return approvalNavigationResponse(
      getAppPricingPlanSelectionUrl(session.shop),
    );
  }

  const formData = await request.formData();
  const planKey = formData.get("planKey");

  if (!isPlanKey(planKey)) {
    return Response.json(
      { error: "Select a valid Lystr plan." },
      { status: 400 },
    );
  }

  let billingOperationToken: string | null = null;

  try {
    const lease = await acquireShopifyBillingCreationLease({
      activatesAt: new Date(),
      planKey,
      shopDomain: session.shop,
    });

    if (!lease.acquired) {
      const settledAttempt = await waitForPendingShopifyBillingAttempt({
        shopDomain: session.shop,
      });

      if (
        hasResumableShopifyBillingAttempt(settledAttempt) &&
        isPaidPlanKey(settledAttempt?.planKey)
      ) {
        if (settledAttempt.planKey !== planKey) {
          throw new Error(
            `${PLAN_LABELS[settledAttempt.planKey]} is already waiting for Shopify approval. Continue or decline that approval before choosing another plan.`,
          );
        }

        return approvalNavigationResponse(settledAttempt.confirmationUrl!);
      }

      throw new Error(
        "Another Shopify billing change is already being processed. Wait a moment and reload.",
      );
    }

    billingOperationToken = lease.requestToken;
    const { config, connector, currentSubscription, pendingApproval } =
      await loadBillingState({
        accessToken: session.accessToken,
        admin,
        ownedRequestToken: lease.requestToken,
        request,
        shopDomain: session.shop,
      });
    const localStore = await getClaimedLystrStore(connector);

    if (!session.accessToken) {
      throw new Error("The Shopify store connection could not be verified.");
    }

    const currentPlanKey =
      (connector?.shopifyPlanKey as BillingPlanKey | null | undefined) ??
      (currentSubscription?.planKey as BillingPlanKey | null | undefined) ??
      null;
    const remainingPaidAccess = hasRemainingPaidAccess({
      connector,
      currentPlanKey,
      subscription: currentSubscription,
    });
    const currentPeriodEnd = getSubscriptionEnd(currentSubscription, connector);

    if (pendingApproval) {
      if (pendingApproval.confirmationUrl) {
        if (pendingApproval.planKey && pendingApproval.planKey !== planKey) {
          throw new Error(
            `${PLAN_LABELS[pendingApproval.planKey]} is already waiting for Shopify approval. Continue or decline that approval before choosing another plan.`,
          );
        }

        return approvalNavigationResponse(pendingApproval.confirmationUrl);
      }

      if (pendingApproval.message) {
        throw new Error(pendingApproval.message);
      }

      if (pendingApproval.status === "PROCESSING") {
        throw new Error(
          "Lystr is still preparing the existing Shopify approval. Wait a moment and reload.",
        );
      }

      throw new Error(
        "A Shopify approval is already in progress. Reload before choosing another plan.",
      );
    }

    if (!hasVerifiedLystrStoreClaim(connector)) {
      // The claim can disappear after the loader runs (for example, after an
      // uninstall event). Return a top-level navigation response so the
      // merchant can securely choose their Lystr store instead of receiving a
      // generic billing failure.
      return appNavigationResponse("/app?connection_required=1");
    }

    if (
      connector.pendingShopifyPlanStatus === "CANCEL_PENDING" &&
      planKey !== "free"
    ) {
      throw new Error(
        "Lystr is still confirming cancellation of the paid Shopify plan. Retry or finish that cancellation before choosing another plan.",
      );
    }

    if (connector.pendingShopifyPlanStatus === "APPROVED") {
      const activationLabel =
        formatDate(connector.pendingShopifyPlanActivatesAt) ??
        "the next billing period";
      throw new Error(
        `The ${connector.pendingShopifyPlanName ?? connector.pendingShopifyPlanKey ?? "selected"} plan is already approved and will start at ${activationLabel}. No other plan change can be started before then.`,
      );
    }

    const currentShopifyStatus =
      currentSubscription?.status?.trim().toUpperCase() ?? "";
    const hasUnreconciledActiveSubscription = Boolean(
      currentSubscription?.id &&
      isPaidPlanKey(currentSubscription.planKey) &&
      (currentShopifyStatus === "ACTIVE" ||
        currentShopifyStatus === "ACCEPTED") &&
      (!connector.accessAllowed ||
        connector.shopifySubscriptionId !== currentSubscription.id),
    );

    if (hasUnreconciledActiveSubscription) {
      throw new Error(
        "Shopify already has an active Lystr subscription. Lystr could not finish syncing it yet, so no new charge was created. Reload to retry.",
      );
    }

    if (remainingPaidAccess && !currentSubscription) {
      throw new Error(
        "Lystr could not verify the existing Shopify subscription, so no new charge was created. Reload and try again.",
      );
    }

    if (
      remainingPaidAccess &&
      currentSubscription &&
      planKey === currentPlanKey
    ) {
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: currentSubscription,
      });

      return appNavigationResponse("/app");
    }

    if (remainingPaidAccess && currentSubscription && currentPeriodEnd) {
      if (planKey === "free") {
        await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: currentPeriodEnd,
          planKey,
          shopDomain: session.shop,
          status: "CANCEL_PENDING",
        });

        if (
          currentSubscription.billingSource === "manual" &&
          currentSubscription.status?.trim().toUpperCase() === "ACTIVE" &&
          currentSubscription.id
        ) {
          await cancelManualBillingSubscription({
            admin,
            subscriptionId: currentSubscription.id,
          });
        } else if (
          currentSubscription.billingSource === "app_pricing" &&
          currentSubscription.status?.trim().toUpperCase() === "ACTIVE"
        ) {
          await cancelLystrConnectorBilling({
            shopDomain: session.shop,
          });
        } else if (
          currentSubscription.status?.trim().toUpperCase() === "ACTIVE"
        ) {
          throw new Error(
            "Lystr could not identify the active Shopify billing source, so the paid plan was not cancelled.",
          );
        }

        await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: currentPeriodEnd,
          planKey,
          shopDomain: session.shop,
          status: "SCHEDULED",
        });

        await connectLystrStore({
          accessToken: session.accessToken,
          apiKey: localStore?.apiKey ?? undefined,
          shopDomain: session.shop,
          shopifySubscription: {
            ...currentSubscription,
            status:
              currentSubscription.status?.trim().toUpperCase() === "ACTIVE"
                ? "CANCELLED"
                : currentSubscription.status,
          },
        });

        return appNavigationResponse("/app/billing?reconnect=1&scheduled=1");
      }

      const price = Number(config.planPrices?.[planKey] ?? 0);

      const canCreateManualReplacement =
        currentSubscription.billingSource === "manual" &&
        currentSubscription.status?.trim().toUpperCase() === "ACTIVE" &&
        Number.isFinite(price) &&
        price > 0;

      if (canCreateManualReplacement) {
        const shouldDeferWithShopify =
          getSubscriptionCurrency(currentSubscription) ===
          config.currency.trim().toLowerCase();
        const replacementActivatesAt = shouldDeferWithShopify
          ? currentPeriodEnd
          : new Date().toISOString();
        const returnUrl = await getManualBillingReturnUrl({
          admin,
          cancelLegacySubscription: false,
          deferredPlanChange: shouldDeferWithShopify,
          planKey,
        });
        const pending = await startManualBillingApproval({
          accessToken: session.accessToken,
          activatesAt: replacementActivatesAt,
          admin,
          config,
          planKey,
          requestToken: lease.requestToken,
          replacementBehavior: shouldDeferWithShopify
            ? "APPLY_ON_NEXT_BILLING_CYCLE"
            : "APPLY_IMMEDIATELY",
          returnUrl,
          shopDomain: session.shop,
        });

        return approvalNavigationResponse(pending.confirmationUrl);
      }

      await updateLystrConnectorPlanTransition({
        action: "schedule",
        activatesAt: currentPeriodEnd,
        planKey,
        shopDomain: session.shop,
        status: "SCHEDULED",
      });
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: currentSubscription,
      });

      return appNavigationResponse("/app/billing?reconnect=1&scheduled=1");
    }

    if (planKey === "free") {
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: localStore?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: getFreeShopifySubscription(session.shop, config),
      });

      return appNavigationResponse("/app");
    }

    const price = Number(config.planPrices?.[planKey] ?? 0);

    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(
        `${PLAN_LABELS[planKey]} billing price is not configured in Lystr.`,
      );
    }

    const returnUrl = await getManualBillingReturnUrl({
      admin,
      cancelLegacySubscription:
        currentSubscription?.billingSource === "app_pricing",
      planKey,
    });
    const pending = await startManualBillingApproval({
      accessToken: session.accessToken,
      activatesAt: new Date().toISOString(),
      admin,
      config,
      planKey,
      requestToken: lease.requestToken,
      replacementBehavior: "APPLY_IMMEDIATELY",
      returnUrl,
      shopDomain: session.shop,
    });

    return approvalNavigationResponse(pending.confirmationUrl);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Failed to process Shopify billing selection.", error);
    const errorMessage =
      error instanceof Error
        ? error.message
        : "Shopify could not process this billing selection.";

    await recordLystrConnectorAuditEvent({
      errorMessage,
      event: "selection.failed",
      level: "error",
      message: `Failed to start the ${PLAN_LABELS[planKey]} Shopify subscription for ${session.shop}.`,
      metadata: {
        outcome: "failed",
        planKey,
      },
      shopDomain: session.shop,
    }).catch((auditError) => {
      console.warn(
        "Failed to record the Shopify subscription selection failure.",
        auditError,
      );
    });

    return Response.json(
      {
        error: errorMessage,
      },
      { status: 400 },
    );
  } finally {
    if (billingOperationToken) {
      await releaseShopifyBillingCreationLease({
        requestToken: billingOperationToken,
        shopDomain: session.shop,
      }).catch((error) => {
        console.warn("Failed to release the Shopify billing lock.", error);
      });
    }
  }
};

function PlanIcon({ planKey }: { planKey: BillingPlanKey }) {
  const paths: Record<BillingPlanKey, JSX.Element> = {
    free: (
      <>
        <path d="M20 12v9H4v-9" />
        <path d="M2 7h20v5H2z" />
        <path d="M12 7v14M12 7H7.5a2.5 2.5 0 1 1 2.1-3.85L12 7Zm0 0h4.5a2.5 2.5 0 1 0-2.1-3.85L12 7Z" />
      </>
    ),
    basic: (
      <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8-6.2-3.2L5.8 21 7 14.2l-5-4.9 6.9-1L12 2Z" />
    ),
    pro: (
      <>
        <path d="m3 7 4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7Z" />
        <path d="M5 19h14" />
      </>
    ),
    premium: (
      <>
        <path d="m12 2 4 5h5l-9 15L3 7h5l4-5Z" />
        <path d="M8 7h8l-4 15L8 7Z" />
      </>
    ),
  };

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[planKey]}
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 2v3M17 2v3M3 9h18M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2Z" />
      <path d="m9 15 2 2 4-4" />
    </svg>
  );
}

export default function BillingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<BillingActionData>();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submittingPlanKey = navigation.formData?.get("planKey");
  const isSubmitting = navigation.state === "submitting";
  const isProcessing =
    navigation.state !== "idle" && isPlanKey(submittingPlanKey ?? null);
  const isReconnecting = Boolean(
    data.isReconnectMode && submittingPlanKey === data.currentPlanKey,
  );
  const currentEndLabel = formatDate(data.currentPeriodEnd);
  const pendingStartLabel = formatDate(data.pendingPlanActivatesAt);
  const pendingPlan = data.plans.find(
    (plan) => plan.key === data.pendingPlanKey,
  );
  const pendingPlanLabel =
    data.pendingPlanName ?? pendingPlan?.label ?? "Selected plan";
  const hasPendingApproval = data.pendingApprovalStatus !== null;
  const hasApprovedPlanTransition = data.pendingPlanStatus === "APPROVED";
  const hasPendingCancellation = data.pendingPlanStatus === "CANCEL_PENDING";
  const hasBlockingBillingTransition =
    hasPendingApproval || hasApprovedPlanTransition || hasPendingCancellation;
  const canResumePendingApproval = Boolean(
    data.pendingApprovalUrl && data.pendingPlanKey,
  );
  const canRetryPendingCancellation = Boolean(
    hasPendingCancellation && data.pendingPlanKey === "free",
  );
  const pendingApprovalCopy = hasPendingCancellation
    ? "Lystr is confirming that Shopify stopped the paid renewal before scheduling Free. No other plan change can start until that check succeeds."
    : hasApprovedPlanTransition
      ? `${pendingPlanLabel} is approved and will start ${
          pendingStartLabel
            ? `after ${pendingStartLabel}`
            : "after the current billing period"
        }. Another plan change cannot be started before then.`
      : data.pendingApprovalStatus === "PENDING"
        ? `${pendingPlanLabel} is waiting for Shopify approval. Continue the existing approval below; Lystr will not create another charge.`
        : (data.pendingApprovalMessage ??
          "Lystr is checking the existing Shopify billing approval. No new charge can be started yet.");
  const pendingPlanNote = hasPendingCancellation
    ? "Confirming Shopify cancellation"
    : data.pendingApprovalStatus === "PENDING"
      ? "Waiting for Shopify approval"
      : data.pendingApprovalStatus === "PROCESSING"
        ? "Checking the Shopify approval"
        : data.pendingApprovalStatus === "UNAVAILABLE"
          ? "Approval link needs attention"
          : data.pendingPlanStatus === "APPROVED"
            ? "Approved for the next billing period"
            : data.pendingPlanStatus === "PENDING_APPROVAL"
              ? "Waiting for Shopify approval"
              : "Scheduled for the next billing period";

  useEffect(() => {
    if (actionData?.approvalUrl) {
      window.open(actionData.approvalUrl, "_top");
      return;
    }

    if (actionData?.redirectUrl) {
      void navigate(actionData.redirectUrl);
    }
  }, [actionData?.approvalUrl, actionData?.redirectUrl, navigate]);

  useEffect(() => {
    const refreshConfiguredPricing = () => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        void revalidator.revalidate();
      }
    };

    window.addEventListener("focus", refreshConfiguredPricing);
    document.addEventListener("visibilitychange", refreshConfiguredPricing);

    return () => {
      window.removeEventListener("focus", refreshConfiguredPricing);
      document.removeEventListener(
        "visibilitychange",
        refreshConfiguredPricing,
      );
    };
  }, [revalidator]);

  useEffect(() => {
    if (!hasBlockingBillingTransition) {
      return;
    }

    const intervalId = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        revalidator.state === "idle"
      ) {
        void revalidator.revalidate();
      }
    }, 10_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasBlockingBillingTransition, revalidator]);

  if (isProcessing) {
    return (
      <main className={`${styles.page} ${styles.loadingPage}`} aria-busy="true">
        <section
          className={styles.loadingState}
          role="status"
          aria-live="polite"
        >
          <span className={styles.loadingSpinner} aria-hidden="true" />
          <h1>
            {isReconnecting
              ? "Reconnecting your store..."
              : "Processing your plan..."}
          </h1>
          <p>Please wait while Lystr confirms your billing and connection.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <h1>Choose your Lystr plan</h1>
          <p>
            Paid plans are billed every <strong>30 days</strong> through
            Shopify.
          </p>
        </div>
        <details className={styles.infoDetails}>
          <summary className={styles.infoButton}>
            <span aria-hidden="true">i</span>
            How billing works
          </summary>
          <div className={styles.infoPanel}>
            Shopify confirms every paid plan. Reconnecting an existing
            paid-through plan creates no new charge or credit reward.
          </div>
        </details>
      </header>

      {data.remainingPaidAccess && data.currentPlanName ? (
        <section
          className={styles.transitionSummary}
          aria-label="Current billing state"
        >
          <div>
            <span>Current plan</span>
            <strong>{data.currentPlanName}</strong>
          </div>
          <div>
            <span>Active until</span>
            <strong>{currentEndLabel ?? "Current billing-period end"}</strong>
          </div>
          {data.pendingPlanName ? (
            <div>
              <span>Next plan</span>
              <strong>{data.pendingPlanName}</strong>
              <small>
                Starts{" "}
                {pendingStartLabel
                  ? `after ${pendingStartLabel}`
                  : "after the current period"}
              </small>
            </div>
          ) : null}
        </section>
      ) : null}

      {actionData?.error ? (
        <p className={styles.error} role="alert">
          {actionData.error}
        </p>
      ) : null}

      {hasBlockingBillingTransition ? (
        <section
          className={styles.pendingApprovalBanner}
          aria-label="Pending Shopify approval"
          role="status"
        >
          <div className={styles.pendingApprovalCopy}>
            <strong>
              {hasApprovedPlanTransition
                ? `${pendingPlanLabel} plan change approved`
                : hasPendingCancellation
                  ? "Shopify cancellation is pending"
                  : data.pendingApprovalStatus === "PENDING"
                    ? `${pendingPlanLabel} approval is pending`
                    : "Existing Shopify approval in progress"}
            </strong>
            <p>{pendingApprovalCopy}</p>
          </div>
          {canResumePendingApproval && data.pendingPlanKey ? (
            <div className={styles.pendingApprovalForm}>
              <a
                className={styles.resumeApprovalButton}
                href={data.pendingApprovalUrl!}
                target="_top"
              >
                Continue Shopify approval
              </a>
            </div>
          ) : canRetryPendingCancellation ? (
            <Form method="post" className={styles.pendingApprovalForm}>
              <input type="hidden" name="planKey" value="free" />
              <button className={styles.resumeApprovalButton} type="submit">
                Retry Shopify cancellation
              </button>
            </Form>
          ) : null}
        </section>
      ) : null}

      <section className={styles.planGrid} aria-label="Lystr billing plans">
        {data.plans.map((plan) => {
          const isCurrent = data.currentPlanKey === plan.key;
          const isPending = data.pendingPlanKey === plan.key;
          const reconnectSamePlan =
            data.isReconnectMode && data.remainingPaidAccess && isCurrent;
          const currentWithoutReconnect =
            isCurrent && !data.isReconnectMode && data.remainingPaidAccess;
          const switchAfterPeriod = data.remainingPaidAccess && !isCurrent;
          const requiresNewCharge =
            plan.key !== "free" && !reconnectSamePlan && !switchAfterPeriod;
          const isDisabled =
            isSubmitting ||
            hasBlockingBillingTransition ||
            currentWithoutReconnect ||
            (requiresNewCharge && !plan.isConfigured);
          const buttonLabel =
            isSubmitting && submittingPlanKey === plan.key
              ? "Processing..."
              : hasBlockingBillingTransition
                ? isPending
                  ? "Approval in progress"
                  : "Unavailable during approval"
                : reconnectSamePlan
                  ? "Reconnect"
                  : currentWithoutReconnect
                    ? "Current plan"
                    : switchAfterPeriod
                      ? "Switch after current period"
                      : plan.key === "free"
                        ? "Select plan"
                        : !plan.isConfigured
                          ? "Not configured"
                          : "Approve payment";

          return (
            <article
              className={`${styles.planCard} ${isCurrent ? styles.currentCard : ""}`}
              key={plan.key}
            >
              <div className={styles.cardTopline}>
                <span className={styles.planIcon}>
                  <PlanIcon planKey={plan.key} />
                </span>
                {plan.key === "basic" ? (
                  <span className={styles.recommended}>Recommended</span>
                ) : null}
              </div>
              <div>
                <h2>{plan.label}</h2>
                {plan.key === "free" ? (
                  <p className={styles.freePrice}>No recurring charge</p>
                ) : plan.isConfigured ? (
                  <p className={styles.price}>
                    <strong>{formatPrice(plan.price, data.currency)}</strong>
                    <span> every 30 days</span>
                  </p>
                ) : (
                  <p className={styles.unconfiguredPrice}>
                    Billing price not configured
                  </p>
                )}
              </div>
              <div className={styles.divider} />
              <p className={styles.credits}>
                {plan.credits > 0
                  ? `${plan.credits.toLocaleString()} credits after each confirmed billing cycle`
                  : "Free access with no billing approval"}
              </p>
              {plan.key !== "free" ? (
                <div className={styles.expiryNote}>
                  <CalendarIcon />
                  <span>Credits expire after 12 months</span>
                </div>
              ) : (
                <div className={styles.expirySpacer} />
              )}
              <p className={styles.pendingNote}>
                {isPending ? pendingPlanNote : "\u00a0"}
              </p>
              <Form method="post">
                <input type="hidden" name="planKey" value={plan.key} />
                <button
                  className={`${styles.planButton} ${reconnectSamePlan ? styles.reconnectButton : ""}`}
                  disabled={isDisabled}
                  type="submit"
                >
                  {buttonLabel}
                </button>
              </Form>
            </article>
          );
        })}
      </section>

      <aside className={styles.creditNotice}>
        <span className={styles.noticeIcon}>
          <CalendarIcon />
        </span>
        <div>
          <strong>
            Credits expire after 12 months from the date they are earned.
          </strong>
          <p>
            When you use credits, they are deducted from the oldest credits
            first.
          </p>
        </div>
      </aside>
    </main>
  );
}
