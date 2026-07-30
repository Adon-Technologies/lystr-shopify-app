import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Outlet, redirect, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import prisma from "../db.server";
import { getLegacyBillingReturnLaunchUrl } from "../legacy-billing-return.server";
import { getShopifyAppHandle } from "../shopify-app-pricing.server";
import { authenticate } from "../shopify.server";
import "../styles/app-index.module.css";

const LYSTR_PAGE_BACKGROUND = "#fffefe";
const APP_FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const requestUrl = new URL(request.url);
  const chargeId = requestUrl.searchParams.get("charge_id")?.trim() ?? "";
  const subscriptionId = /^\d+$/.test(chargeId)
    ? `gid://shopify/AppSubscription/${chargeId}`
    : null;
  const billingAttempt = subscriptionId
    ? await prisma.shopifyBillingAttempt.findFirst({
        where: { subscriptionId },
        select: { shopDomain: true },
      })
    : null;
  const legacyBillingReturnUrl = getLegacyBillingReturnLaunchUrl({
    appHandle: getShopifyAppHandle(),
    fallbackShopDomain: billingAttempt?.shopDomain,
    request,
  });

  if (legacyBillingReturnUrl) {
    throw redirect(legacyBillingReturnUrl);
  }

  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <style
        dangerouslySetInnerHTML={{
          __html: `
          .lystr-footer s-link {
            color: #6d7175;
            font-size: 0.75rem;
            line-height: 1rem;
            --pc-link-color: #6d7175;
            --p-color-text-link: #6d7175;
            --p-color-text-link-hover: #4a4a4a;
            --p-color-text-link-active: #4a4a4a;
          }

          .lystr-footer s-link:hover {
            color: #4a4a4a;
            --pc-link-color: #4a4a4a;
            --p-color-text-link: #4a4a4a;
          }

          .lystr-app-shell {
            position: relative;
            width: 100%;
            min-width: 100%;
            height: 100dvh;
            isolation: isolate;
            background: ${LYSTR_PAGE_BACKGROUND};
            font-family: ${APP_FONT};
            overflow: visible;
          }

          .lystr-app-shell::before,
          .lystr-app-shell::after {
            content: "";
            position: absolute;
            pointer-events: none;
            z-index: 0;
          }

          .lystr-app-shell::before {
            inset: 0 -64px 0 0;
            background:
              radial-gradient(ellipse 44% 26% at 2% 100%, rgba(255, 117, 31, 0.1), transparent 68%),
              radial-gradient(ellipse 30% 26% at 100% 94%, rgba(255, 138, 58, 0.08), transparent 72%),
              ${LYSTR_PAGE_BACKGROUND};
          }

          .lystr-app-shell::after {
            right: -7%;
            bottom: 6%;
            width: 40%;
            height: 48%;
            opacity: 0.52;
            background: repeating-radial-gradient(
              ellipse at 58% 50%,
              transparent 0 9px,
              rgba(242, 106, 20, 0.075) 10px 11px,
              transparent 12px 19px
            );
            mask-image: linear-gradient(90deg, transparent, #000 20%, #000 76%, transparent);
            transform: rotate(-12deg);
          }

          .lystr-app-shell > s-app-nav,
          .lystr-app-main,
          .lystr-footer {
            position: relative;
            z-index: 1;
            background: transparent !important;
          }
        `,
        }}
      />
      <div
        className="lystr-app-shell"
        style={{
          height: "100dvh",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          overflow: "visible",
          backgroundColor: LYSTR_PAGE_BACKGROUND,
        }}
      >
        <s-app-nav>
          <s-link href="/app">Connect Store</s-link>
          <s-link href="/app/billing">Billing</s-link>
        </s-app-nav>
        <main
          className="lystr-app-main"
          style={{
            flex: "1 1 auto",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            overflow: "hidden",
            backgroundColor: LYSTR_PAGE_BACKGROUND,
          }}
        >
          <Outlet />
        </main>
        <footer
          className="lystr-footer"
          style={{
            display: "flex",
            justifyContent: "center",
            padding: "0.5rem 1rem 0.75rem",
            color: "#6d7175",
            fontSize: "0.75rem",
            fontFamily: APP_FONT,
            lineHeight: "1rem",
            flexShrink: 0,
            backgroundColor: LYSTR_PAGE_BACKGROUND,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            <s-link
              href="https://lystr.ai/privacy-policy"
              target="_blank"
              tone="neutral"
            >
              <span
                style={{
                  color: "#6d7175",
                  fontSize: "0.75rem",
                  fontFamily: APP_FONT,
                }}
              >
                Privacy Policy
              </span>
            </s-link>
            <s-text color="subdued" tone="neutral">
              |
            </s-text>
            <s-link href="https://lystr.ai/terms-of-service" tone="neutral">
              <span
                style={{
                  color: "#6d7175",
                  fontSize: "0.75rem",
                  fontFamily: APP_FONT,
                }}
              >
                Terms of Service
              </span>
            </s-link>
          </div>
        </footer>
      </div>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
