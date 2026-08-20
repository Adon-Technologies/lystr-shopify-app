export type ShopifyOneTimePurchaseWebhook = {
  id: string;
  status: string | null;
};

export function getShopifyOneTimePurchaseWebhook(
  payload: unknown,
): ShopifyOneTimePurchaseWebhook | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const purchase = (
    payload as {
      app_purchase_one_time?: unknown;
    }
  ).app_purchase_one_time;

  if (!purchase || typeof purchase !== "object") {
    return null;
  }

  const purchaseData = purchase as {
    admin_graphql_api_id?: unknown;
    status?: unknown;
  };
  const id =
    typeof purchaseData.admin_graphql_api_id === "string"
      ? purchaseData.admin_graphql_api_id.trim()
      : "";

  if (!id) {
    return null;
  }

  return {
    id,
    status:
      typeof purchaseData.status === "string"
        ? purchaseData.status.trim().toUpperCase() || null
        : null,
  };
}
