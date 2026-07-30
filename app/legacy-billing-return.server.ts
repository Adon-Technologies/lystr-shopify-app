const SHOPIFY_SHOP_DOMAIN_PATTERN =
  /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;
const BILLING_PLAN_KEYS = new Set(["free", "basic", "pro", "premium"]);

function normalizeShopDomain(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase() ?? "";
  return SHOPIFY_SHOP_DOMAIN_PATTERN.test(normalized) ? normalized : null;
}

function getReferrerShopDomain(request: Request) {
  const referrer = request.headers.get("referer");

  if (!referrer) {
    return null;
  }

  try {
    return normalizeShopDomain(new URL(referrer).hostname);
  } catch {
    return null;
  }
}

export function getLegacyBillingReturnLaunchUrl({
  appHandle,
  fallbackShopDomain,
  request,
}: {
  appHandle: string;
  fallbackShopDomain?: string | null;
  request: Request;
}) {
  const requestUrl = new URL(request.url);

  if (
    requestUrl.searchParams.get("billing_return") !== "1" ||
    requestUrl.searchParams.has("shop") ||
    requestUrl.searchParams.has("host") ||
    request.headers.has("authorization")
  ) {
    return null;
  }

  const requestedPlan =
    requestUrl.searchParams.get("requested_plan")?.trim().toLowerCase() ?? "";
  const shopDomain =
    getReferrerShopDomain(request) || normalizeShopDomain(fallbackShopDomain);
  const normalizedAppHandle = appHandle.trim();

  if (
    !shopDomain ||
    !normalizedAppHandle ||
    !BILLING_PLAN_KEYS.has(requestedPlan)
  ) {
    return null;
  }

  const launchUrl = new URL(
    `/admin/apps/${encodeURIComponent(normalizedAppHandle)}/app`,
    `https://${shopDomain}`,
  );
  launchUrl.searchParams.set("billing_return", "1");
  launchUrl.searchParams.set("requested_plan", requestedPlan);

  for (const flag of ["cancel_legacy", "deferred_plan_change"]) {
    if (requestUrl.searchParams.get(flag) === "1") {
      launchUrl.searchParams.set(flag, "1");
    }
  }

  const chargeId = requestUrl.searchParams.get("charge_id")?.trim() ?? "";

  if (/^\d+$/.test(chargeId)) {
    launchUrl.searchParams.set("charge_id", chargeId);
  }

  return launchUrl.toString();
}
