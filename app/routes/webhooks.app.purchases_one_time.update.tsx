import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { syncLystrCreditTopUp } from "../lystr.server";
import { getShopifyOneTimePurchaseWebhook } from "../shopify-one-time-purchase-webhook";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, webhookId } =
    await authenticate.webhook(request);
  const purchase = getShopifyOneTimePurchaseWebhook(payload);

  console.log(`Received ${topic} webhook for ${shop}`);

  if (!purchase) {
    return new Response();
  }

  // Let failures return a non-2xx response so Shopify retries the webhook.
  // Acknowledging a failed sync can permanently strand an approved purchase.
  await syncLystrCreditTopUp({
    shopDomain: shop,
    shopifyPurchaseId: purchase.id,
    shopifyPurchaseStatus: purchase.status,
    shopifyWebhookId: webhookId,
  });

  return new Response();
};
