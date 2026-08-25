import type {
  LystrConnectorStatus,
  ShopifySubscriptionForLystr,
} from "./lystr.server";

export const BILLING_PLAN_KEYS = ["free", "basic", "pro", "premium"] as const;
export const FRESH_PAID_PLAN_REPLACEMENT_BEHAVIOR =
  "APPLY_IMMEDIATELY" as const;

export type BillingPlanKey = (typeof BILLING_PLAN_KEYS)[number];
export type PaidBillingPlanKey = Exclude<BillingPlanKey, "free">;

export function isBillingPlanKey(
  value: FormDataEntryValue | null,
): value is BillingPlanKey {
  return (
    typeof value === "string" &&
    BILLING_PLAN_KEYS.includes(value as BillingPlanKey)
  );
}

export function isPaidBillingPlanKey(
  value: string | null | undefined,
): value is PaidBillingPlanKey {
  return value === "basic" || value === "pro" || value === "premium";
}

export function getShopifySubscriptionEnd(
  subscription: ShopifySubscriptionForLystr | null,
  connector: LystrConnectorStatus | null,
) {
  return subscription?.currentPeriodEnd ?? connector?.nextBillingDate ?? null;
}

export function hasRemainingPaidShopifyAccess({
  connector,
  currentPlanKey,
  now = new Date(),
  subscription,
}: {
  connector: LystrConnectorStatus | null;
  currentPlanKey: string | null;
  now?: Date;
  subscription: ShopifySubscriptionForLystr | null;
}) {
  if (!isPaidBillingPlanKey(currentPlanKey)) {
    return false;
  }

  const status = (
    subscription?.status ??
    connector?.shopifySubscriptionStatus ??
    connector?.status
  )
    ?.trim()
    .toUpperCase();
  const periodEnd = getShopifySubscriptionEnd(subscription, connector);
  const periodEndDate = periodEnd ? new Date(periodEnd) : null;

  return Boolean(
    connector?.accessAllowed &&
    status !== "FROZEN" &&
    status !== "DECLINED" &&
    status !== "EXPIRED" &&
    periodEndDate &&
    !Number.isNaN(periodEndDate.getTime()) &&
    periodEndDate.getTime() > now.getTime(),
  );
}

export function shouldReuseCurrentPaidPlan({
  currentPlanKey,
  currentSubscriptionStatus,
  remainingPaidAccess,
  selectedPlanKey,
}: {
  currentPlanKey: string | null;
  currentSubscriptionStatus?: string | null;
  remainingPaidAccess: boolean;
  selectedPlanKey: BillingPlanKey;
}) {
  const status = currentSubscriptionStatus?.trim().toUpperCase() ?? "";
  const currentSubscriptionIsActive =
    status === "ACTIVE" || status === "ACCEPTED";

  return Boolean(
    isPaidBillingPlanKey(selectedPlanKey) &&
    selectedPlanKey === currentPlanKey &&
    (remainingPaidAccess || currentSubscriptionIsActive),
  );
}

export function isCanceledShopifySubscriptionStatus(
  status: string | null | undefined,
) {
  const normalizedStatus = status?.trim().toUpperCase();
  return normalizedStatus === "CANCELLED" || normalizedStatus === "CANCELED";
}

export function canReconnectWithStoredPaidEntitlement(
  connector: LystrConnectorStatus | null | undefined,
) {
  return Boolean(
    connector?.accessAllowed &&
      connector.status?.trim().toUpperCase() === "CANCELED" &&
      isPaidBillingPlanKey(connector.shopifyPlanKey),
  );
}
