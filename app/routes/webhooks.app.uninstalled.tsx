import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { markLystrConnectorUninstalled } from "../lystr.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic, webhookId } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await markLystrConnectorUninstalled({
      shopDomain: shop,
      shopifyWebhookId: webhookId,
    });
  } catch (error) {
    console.error("Failed to notify Lystr about Shopify uninstall", error);
    return new Response("Failed to synchronize Lystr uninstall.", {
      status: 502,
    });
  }

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
