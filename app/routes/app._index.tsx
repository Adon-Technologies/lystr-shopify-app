import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import type { CSSProperties } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import styles from "../styles/app-index.module.css";
import {
  connectLystrStore,
  getClaimedLystrStoreId,
  getLystrConnectorConfig,
  getLystrConnectorStatus,
  prepareLystrStoreConnection,
  shouldFinalizeLystrStoreConnection,
  syncLystrConnectorBilling,
  updateLystrConnectorPlanTransition,
  type LystrConnectorStatus,
  type ShopifySubscriptionForLystr,
} from "../lystr.server";
import {
  getAppPricingPlanSelectionUrl,
  getCurrentShopifyBillingSubscription,
  isShopifyManualBillingEnabled,
} from "../shopify-app-pricing.server";
import {
  SHOPIFY_BILLING_ATTEMPT_STATES,
  clearShopifyBillingAttempt,
  getShopifyBillingAttempt,
} from "../shopify-billing-attempt.server";
import {
  canReconnectWithStoredPaidEntitlement,
  canUseCurrentShopifySubscription,
} from "../shopify-billing-policy";

const LYSTR_STORES_URL = "https://lystr.ai/stores";
const APP_FONT =
  'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const criticalPageStyle = {
  position: "relative",
  flex: "1 1 auto",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflowX: "hidden",
  overflowY: "auto",
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
  padding: "1rem 1.5rem",
  boxSizing: "border-box",
  background: "transparent",
  color: "#17191c",
  fontFamily: APP_FONT,
} satisfies CSSProperties;

const criticalSceneStyle = {
  position: "relative",
  zIndex: 1,
  width: "min(100%, 660px)",
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "1rem",
  textAlign: "center",
  transform: "translateY(-3.25vh)",
  fontFamily: APP_FONT,
} satisfies CSSProperties;

const criticalHeroWrapStyle = {
  position: "relative",
  width: "clamp(96px, 9vw, 126px)",
  aspectRatio: "1",
  display: "grid",
  placeItems: "center",
  flex: "0 0 auto",
} satisfies CSSProperties;

const criticalHeroImageStyle = {
  display: "block",
  width: "100%",
  height: "auto",
} satisfies CSSProperties;

const criticalStatusStackStyle = {
  width: "min(100%, 520px)",
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "0.8rem",
  marginTop: "0.35rem",
} satisfies CSSProperties;

const criticalStatusTitleStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.5rem",
  maxWidth: "100%",
  flexWrap: "nowrap",
} satisfies CSSProperties;

const criticalStatusHeadingStyle = {
  margin: 0,
  color: "#1d2024",
  fontFamily: APP_FONT,
  fontSize: "1.05rem",
  lineHeight: 1.2,
  fontWeight: 600,
  letterSpacing: 0,
  maxWidth: "min(100%, 440px)",
} satisfies CSSProperties;

const criticalIncompleteHeadingStyle = {
  ...criticalStatusHeadingStyle,
  fontSize: "1rem",
  fontWeight: 500,
} satisfies CSSProperties;

const criticalStatusIconSuccessStyle = {
  width: 9,
  height: 9,
  display: "inline-block",
  flex: "0 0 auto",
  borderRadius: 999,
  background: "#20c463",
} satisfies CSSProperties;

const criticalStatusDividerStyle = {
  width: 48,
  height: 3,
  display: "block",
  borderRadius: 999,
  background: "#f26a14",
} satisfies CSSProperties;

const criticalStatusPillStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.55rem",
  minHeight: 34,
  padding: "0.28rem 0.9rem",
  borderRadius: 10,
  color: "#121820",
  fontFamily: APP_FONT,
  background:
    "linear-gradient(90deg, rgba(32, 196, 99, 0.13), rgba(32, 196, 99, 0.2))",
  fontSize: "0.84rem",
  fontWeight: 500,
} satisfies CSSProperties;

const criticalStatusPillIconStyle = {
  display: "inline-flex",
  color: "#20c463",
} satisfies CSSProperties;

const criticalWarningPulseStyle = {
  width: 9,
  height: 9,
  display: "inline-block",
  borderRadius: 999,
  background: "#f26a14",
  flex: "0 0 auto",
} satisfies CSSProperties;

const criticalRedirectButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "0.45rem",
  padding: "0.45rem 0.8rem",
  border: "1px solid rgba(242, 106, 20, 0.32)",
  borderRadius: 10,
  color: "#fff",
  fontFamily: APP_FONT,
  background: "linear-gradient(135deg, #262a2d, #111517)",
  boxShadow:
    "0 12px 22px rgba(17, 24, 39, 0.18), 0 0 0 1px rgba(255, 255, 255, 0.08) inset",
  textDecoration: "none",
  fontSize: "0.84rem",
  fontWeight: 500,
} satisfies CSSProperties;

const criticalStatusCopyStyle = {
  margin: 0,
  color: "#6b7280",
  fontFamily: APP_FONT,
  fontSize: "0.9rem",
  lineHeight: 1.5,
} satisfies CSSProperties;

const criticalPricingLinkStyle = {
  display: "inline-grid",
  gridTemplateColumns: "26px minmax(0, auto) 18px",
  alignItems: "center",
  gap: "0.55rem",
  maxWidth: "100%",
  padding: "0.45rem 0.75rem",
  border: "1px solid rgba(31, 41, 55, 0.13)",
  borderRadius: 8,
  color: "#17191c",
  fontFamily: APP_FONT,
  background: "rgba(255, 255, 255, 0.84)",
  boxShadow:
    "0 14px 32px rgba(17, 24, 39, 0.1), 0 2px 7px rgba(17, 24, 39, 0.07)",
  textDecoration: "none",
  fontSize: "0.86rem",
  fontWeight: 500,
} satisfies CSSProperties;

const criticalShopifyIconStyle = {
  width: 22,
  height: 25,
  objectFit: "contain",
  justifySelf: "center",
} satisfies CSSProperties;

const criticalHeroCopyStyle = {
  maxWidth: 500,
  marginTop: "-0.15rem",
  fontFamily: APP_FONT,
} satisfies CSSProperties;

const criticalHeroTitleStyle = {
  margin: 0,
  color: "#202124",
  fontFamily: APP_FONT,
  fontSize: "clamp(1.5rem, 2.2vw, 2rem)",
  lineHeight: 1.08,
  fontWeight: 600,
  letterSpacing: 0,
} satisfies CSSProperties;

const criticalHeroAccentStyle = {
  color: "#f26a14",
} satisfies CSSProperties;

const criticalHeroTextStyle = {
  margin: "0.55rem auto 0",
  maxWidth: 440,
  color: "#454b55",
  fontFamily: APP_FONT,
  fontSize: "0.92rem",
  lineHeight: 1.45,
} satisfies CSSProperties;

const criticalConnectCardStyle = {
  width: "min(100%, 620px)",
  display: "grid",
  gap: "1.1rem",
  padding: "clamp(1rem, 2vw, 1.45rem)",
  boxSizing: "border-box",
  textAlign: "left",
  background: "rgba(255, 255, 255, 0.86)",
  border: "1px solid rgba(31, 41, 55, 0.12)",
  borderRadius: 14,
  boxShadow:
    "0 16px 44px rgba(17, 24, 39, 0.09), 0 3px 10px rgba(17, 24, 39, 0.06)",
  backdropFilter: "blur(16px)",
  fontFamily: APP_FONT,
} satisfies CSSProperties;

const criticalFeatureGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
  gap: "clamp(0.6rem, 2.2vw, 1.8rem)",
} satisfies CSSProperties;

const criticalFeatureItemStyle = {
  display: "grid",
  justifyItems: "center",
  gap: "0.25rem",
  color: "#6b7280",
  textAlign: "center",
  fontFamily: APP_FONT,
  fontSize: "0.78rem",
  lineHeight: 1.35,
} satisfies CSSProperties;

const criticalFeatureIconStyle = {
  width: 42,
  height: 42,
  display: "grid",
  placeItems: "center",
  marginBottom: "0.25rem",
  borderRadius: 999,
  color: "#f26a14",
  background: "rgba(242, 106, 20, 0.1)",
} satisfies CSSProperties;

const criticalFeatureTitleStyle = {
  color: "#22262b",
  fontFamily: APP_FONT,
  fontSize: "0.82rem",
  fontWeight: 600,
} satisfies CSSProperties;

const criticalFieldGroupStyle = {
  display: "grid",
  gap: "0.5rem",
} satisfies CSSProperties;

const criticalFieldLabelStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "0.45rem",
  color: "#17191c",
  fontFamily: APP_FONT,
  fontSize: "0.84rem",
  fontWeight: 600,
} satisfies CSSProperties;

const criticalInfoIconStyle = {
  width: 16,
  height: 16,
  display: "inline-grid",
  placeItems: "center",
  border: "1px solid #aeb4bd",
  borderRadius: 999,
  color: "#87909d",
  fontFamily: APP_FONT,
  fontSize: "0.68rem",
  lineHeight: 1,
} satisfies CSSProperties;

const criticalInputShellStyle = {
  height: 42,
  display: "flex",
  alignItems: "center",
  gap: "0.65rem",
  padding: "0 0.85rem",
  boxSizing: "border-box",
  border: "1px solid rgba(127, 135, 145, 0.46)",
  borderRadius: 10,
  background: "rgba(255, 255, 255, 0.74)",
  boxShadow: "inset 0 1px 0 rgba(255, 255, 255, 0.76)",
} satisfies CSSProperties;

const criticalInputIconStyle = {
  display: "inline-flex",
  color: "#1d2024",
  flex: "0 0 auto",
} satisfies CSSProperties;

const criticalMutedInputIconStyle = {
  ...criticalInputIconStyle,
  color: "#9aa1ab",
} satisfies CSSProperties;

const criticalApiInputStyle = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
  padding: 0,
  border: 0,
  outline: 0,
  background: "transparent",
  color: "#17191c",
  fontFamily: APP_FONT,
  fontSize: "0.9rem",
  lineHeight: 1.2,
} satisfies CSSProperties;

const criticalErrorTextStyle = {
  margin: "-0.25rem 0 0",
  color: "#b42318",
  fontFamily: APP_FONT,
  fontSize: "0.85rem",
  fontWeight: 600,
} satisfies CSSProperties;

const criticalConnectButtonStyle = {
  appearance: "none",
  width: "auto",
  minHeight: "auto",
  justifySelf: "center",
  display: "inline-grid",
  gridTemplateColumns: "24px auto 18px",
  alignItems: "center",
  gap: "0.55rem",
  padding: "0.45rem 0.85rem",
  border: "1px solid rgba(242, 106, 20, 0.48)",
  borderRadius: 8,
  color: "#fff",
  background: "linear-gradient(135deg, #25292c, #111517 64%, #15191b)",
  boxShadow:
    "0 12px 24px rgba(242, 106, 20, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.12)",
  cursor: "pointer",
  fontFamily: APP_FONT,
  fontSize: "0.84rem",
  fontWeight: 500,
  lineHeight: 1.2,
} satisfies CSSProperties;

const criticalConnectButtonLoadingStyle = {
  gridTemplateColumns: "auto",
  cursor: "wait",
  opacity: 0.9,
} satisfies CSSProperties;

const criticalButtonIconStyle = {
  width: 24,
  height: 24,
  display: "grid",
  placeItems: "center",
  borderRadius: 999,
  background: "rgba(255, 255, 255, 0.18)",
  color: "#fff",
} satisfies CSSProperties;

const criticalLoadingContentStyle = {
  display: "grid",
  placeItems: "center",
  minWidth: 72,
} satisfies CSSProperties;

const criticalSpinnerStyle = {
  width: 18,
  height: 18,
  display: "block",
  border: "2px solid rgba(255, 255, 255, 0.45)",
  borderTopColor: "#fff",
  borderRadius: 999,
  animation: "lystr-spin 0.75s linear infinite",
} satisfies CSSProperties;

function StableRouteStyles() {
  return (
    <style
      dangerouslySetInnerHTML={{
        __html: `
        @keyframes lystr-spin {
          to { transform: rotate(360deg); }
        }

        @keyframes lystr-icon-pulse {
          0% { opacity: 0.8; transform: scale(0.88); }
          70%, 100% { opacity: 0; transform: scale(1.16); }
        }

        @keyframes lystr-success-pulse {
          0% { box-shadow: 0 0 0 0 rgba(32, 196, 99, 0.34); }
          70% { box-shadow: 0 0 0 12px rgba(32, 196, 99, 0); }
          100% { box-shadow: 0 0 0 0 rgba(32, 196, 99, 0); }
        }

        @keyframes lystr-warning-pulse {
          0% { box-shadow: 0 0 0 0 rgba(242, 106, 20, 0.36); transform: scale(1); }
          70% { box-shadow: 0 0 0 10px rgba(242, 106, 20, 0); transform: scale(1.06); }
          100% { box-shadow: 0 0 0 0 rgba(242, 106, 20, 0); transform: scale(1); }
        }

        @keyframes lystr-sparkle {
          0%, 100% { opacity: 0.45; transform: rotate(45deg) scale(0.72); }
          50% { opacity: 1; transform: rotate(45deg) scale(1); }
        }

        @keyframes lystr-float-line {
          0%, 100% { margin-top: 0; }
          50% { margin-top: 10px; }
        }

        .lystr-hero-icon-wrap::before,
        .lystr-hero-icon-wrap::after {
          content: "";
          position: absolute;
          inset: -18%;
          border-radius: 999px;
          background: rgba(242, 106, 20, 0.08);
          animation: lystr-icon-pulse 3.6s ease-out infinite;
          pointer-events: none;
        }

        .lystr-hero-icon-wrap::after {
          inset: -33%;
          opacity: 0.55;
          animation-delay: -1.8s;
        }

        .lystr-hero-icon {
          position: relative;
          z-index: 1;
          filter: drop-shadow(0 14px 22px rgba(210, 92, 18, 0.16));
        }

        .lystr-status-success-dot {
          animation: lystr-success-pulse 1.8s ease-out infinite;
        }

        .lystr-status-warning-dot {
          animation: lystr-warning-pulse 1.65s ease-out infinite;
        }

        .lystr-status-title {
          text-wrap: balance;
        }

        .lystr-flow-line {
          position: absolute;
          width: 360px;
          height: 116px;
          border-top: 1.5px dashed rgba(242, 106, 20, 0.2);
          border-radius: 50%;
          animation: lystr-float-line 6s ease-in-out infinite;
        }

        .lystr-flow-line-left {
          top: 22%;
          left: 29%;
          transform: rotate(18deg);
        }

        .lystr-flow-line-right {
          top: 24%;
          right: 27%;
          transform: rotate(-16deg);
          animation-delay: -2s;
        }

        .lystr-sparkle {
          position: absolute;
          width: 12px;
          height: 12px;
          transform: rotate(45deg);
          background: #f26a14;
          opacity: 0.82;
          animation: lystr-sparkle 2.8s ease-in-out infinite;
        }

        .lystr-sparkle::before,
        .lystr-sparkle::after {
          content: "";
          position: absolute;
          inset: -6px 4px;
          border-radius: 999px;
          background: rgba(242, 106, 20, 0.2);
        }

        .lystr-sparkle::after {
          inset: 4px -6px;
        }

        .lystr-sparkle-one { top: 22%; left: 36%; }
        .lystr-sparkle-two { top: 17%; right: 36%; width: 8px; height: 8px; animation-delay: -0.9s; }
        .lystr-sparkle-three { top: 31%; left: 40%; width: 15px; height: 15px; animation-delay: -1.4s; }
        .lystr-sparkle-four { top: 38%; right: 40%; width: 9px; height: 9px; animation-delay: -2s; }

        .lystr-dot-grid {
          position: absolute;
          width: 135px;
          height: 135px;
          opacity: 0.2;
          background-image: radial-gradient(rgba(242, 106, 20, 0.45) 1.2px, transparent 1.2px);
          background-size: 18px 18px;
          mask-image: linear-gradient(135deg, transparent, #000 28%, #000 70%, transparent);
        }

        .lystr-dot-grid-left { left: 10%; top: 38%; }
        .lystr-dot-grid-right { right: 8%; bottom: 14%; }

        .lystr-connect-card,
        .lystr-connect-card * {
          box-sizing: border-box;
        }

        .lystr-connect-button:hover,
        .lystr-redirect-button:hover,
        .lystr-pricing-link:hover {
          transform: translateY(-1px);
        }

        .lystr-connect-button[disabled] {
          transform: none !important;
          pointer-events: none;
        }

        .lystr-loading-spinner {
          animation: lystr-spin 0.75s linear infinite;
        }

        .lystr-api-input::placeholder {
          color: #a2a8b1;
        }

        .lystr-input-shell:focus-within {
          border-color: rgba(242, 106, 20, 0.72) !important;
          background: #fff !important;
          box-shadow: 0 0 0 4px rgba(242, 106, 20, 0.12) !important;
        }

        .lystr-connect-button:focus-visible,
        .lystr-redirect-button:focus-visible,
        .lystr-pricing-link:focus-visible {
          outline: 3px solid rgba(242, 106, 20, 0.3);
          outline-offset: 3px;
        }

        @media (max-width: 760px) {
          .lystr-status-title {
            flex-wrap: wrap;
          }

          .lystr-feature-grid {
            grid-template-columns: 1fr !important;
            gap: 0.85rem !important;
          }

          .lystr-feature-item {
            grid-template-columns: 42px minmax(0, 1fr) !important;
            justify-items: start !important;
            align-items: center !important;
            text-align: left !important;
          }

          .lystr-feature-title,
          .lystr-feature-description {
            grid-column: 2 !important;
          }

          .lystr-feature-icon {
            grid-row: 1 / span 2 !important;
            margin-bottom: 0 !important;
          }

          .lystr-flow-line-left { left: -24%; }
          .lystr-flow-line-right { right: -28%; }
          .lystr-dot-grid-left { left: -4%; }
        }

        @media (max-width: 480px) {
          .lystr-connect-card {
            padding: 0.9rem !important;
          }

          .lystr-connect-button {
            min-height: 36px !important;
            padding: 0.45rem 0.8rem !important;
            font-size: 0.82rem !important;
          }

          .lystr-status-pill {
            width: 100% !important;
          }

          .lystr-pricing-link {
            grid-template-columns: 24px minmax(0, 1fr) 16px !important;
            white-space: normal !important;
          }
        }
      `,
      }}
    />
  );
}

type ActionData =
  | { error: string; success?: never }
  | { success: true; error?: never };

function getErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "Lystr could not connect this store right now.";
}

function isBillingApprovalRequiredMessage(message: string) {
  return message.toLowerCase().includes("billing approval is required");
}

function formatConnectorDate(value?: string | null) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat("en", {
    timeZone: "UTC",
    dateStyle: "medium",
  }).format(date);
}

function isConnectorCancellationPending(
  connector?: LystrConnectorStatus | null,
) {
  return (
    connector?.status?.toUpperCase() === "CANCELED" &&
    connector.accessAllowed === true
  );
}

function getConnectorMessage(connector: LystrConnectorStatus) {
  const status = connector.status?.toUpperCase();

  if (isConnectorCancellationPending(connector)) {
    const accessEndsAt = formatConnectorDate(connector.nextBillingDate);

    return accessEndsAt
      ? `Subscription canceled. Access remains until ${accessEndsAt}.`
      : "Subscription canceled. Access remains until the billing period ends.";
  }

  if (
    connector.pendingShopifyPlanStatus?.trim().toUpperCase() ===
    "PENDING_APPROVAL"
  ) {
    return "Finish the existing Shopify billing approval to connect this store on the selected plan.";
  }

  switch (status) {
    case "ACTIVE":
      return "Active Shopify connector subscription.";
    case "GRANDFATHERED":
      return "Existing installation is free during the migration period.";
    case "PAST_DUE":
      return "Payment failed. Shopify billing must be resolved before connector access resumes.";
    case "PAYMENT_REQUIRED":
      return "Payment approval is required before connector access resumes.";
    case "UNINSTALLED":
      return "Connector was uninstalled from this shop.";
    case "CANCELED":
      return connector.billingApprovalRequired
        ? "Approve Shopify billing to reconnect this store."
        : "Connector subscription was canceled.";
    default:
      return "Shopify connector billing is not complete yet.";
  }
}

function CalendarIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M7 3v3M17 3v3M4 9h16M6 5h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
    </svg>
  );
}

function TagIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 13.2 13.2 20a2.4 2.4 0 0 1-3.4 0L4 14.2V4h10.2L20 9.8a2.4 2.4 0 0 1 0 3.4Z" />
      <path d="M8.5 8.5h.01" />
    </svg>
  );
}

function GiftIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 12v8H4v-8M2 8h20v4H2zM12 8v12M12 8H8.5a2 2 0 1 1 2-2c0 1.1 1.5 2 1.5 2ZM12 8h3.5a2 2 0 1 0-2-2c0 1.1-1.5 2-1.5 2Z" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M14.6 9.4a4.5 4.5 0 1 1-2.8-2.8M14 10l6-6M18 6l2 2M16 8l2 2" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 4.2A9.9 9.9 0 0 1 12 4c5 0 8.5 4.2 9.5 6a12 12 0 0 1-2.3 3.1M6.4 6.4A12.1 12.1 0 0 0 2.5 10c1 1.8 4.5 6 9.5 6 1.2 0 2.3-.2 3.3-.6" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" />
      <path d="M14 11a5 5 0 0 0-7.1 0l-2 2A5 5 0 0 0 12 20.1l1.1-1.1" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function ExternalIcon() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </svg>
  );
}

function FeatureItem({
  description,
  icon,
  title,
}: {
  description: string;
  icon: JSX.Element;
  title: string;
}) {
  return (
    <div
      className={`${styles.featureItem} lystr-feature-item`}
      style={criticalFeatureItemStyle}
    >
      <span
        className={`${styles.featureIcon} lystr-feature-icon`}
        style={criticalFeatureIconStyle}
      >
        {icon}
      </span>
      <strong className="lystr-feature-title" style={criticalFeatureTitleStyle}>
        {title}
      </strong>
      <span className="lystr-feature-description">{description}</span>
    </div>
  );
}

function SceneDecor() {
  return (
    <div className={styles.sceneDecor} aria-hidden="true">
      <span
        className={`${styles.flowLine} ${styles.flowLineLeft} lystr-flow-line lystr-flow-line-left`}
      />
      <span
        className={`${styles.flowLine} ${styles.flowLineRight} lystr-flow-line lystr-flow-line-right`}
      />
      <span
        className={`${styles.sparkle} ${styles.sparkleOne} lystr-sparkle lystr-sparkle-one`}
      />
      <span
        className={`${styles.sparkle} ${styles.sparkleTwo} lystr-sparkle lystr-sparkle-two`}
      />
      <span
        className={`${styles.sparkle} ${styles.sparkleThree} lystr-sparkle lystr-sparkle-three`}
      />
      <span
        className={`${styles.sparkle} ${styles.sparkleFour} lystr-sparkle lystr-sparkle-four`}
      />
      <span
        className={`${styles.dotGrid} ${styles.dotGridLeft} lystr-dot-grid lystr-dot-grid-left`}
      />
      <span
        className={`${styles.dotGrid} ${styles.dotGridRight} lystr-dot-grid lystr-dot-grid-right`}
      />
    </div>
  );
}

function HeroIcon() {
  return (
    <div
      className={`${styles.heroIconWrap} lystr-hero-icon-wrap`}
      style={criticalHeroWrapStyle}
    >
      <img
        src="/lystrIcon.png"
        width="126"
        height="126"
        alt="Lystr Connect"
        className={`${styles.heroIcon} lystr-hero-icon`}
        style={criticalHeroImageStyle}
      />
    </div>
  );
}

function RedirectButton() {
  return (
    <a
      href={LYSTR_STORES_URL}
      target="_blank"
      rel="noreferrer"
      className={`${styles.redirectButton} lystr-redirect-button`}
      style={criticalRedirectButtonStyle}
    >
      <ExternalIcon />
      <span>Redirect</span>
    </a>
  );
}

function ShopifyPricingLink({ appPricingUrl }: { appPricingUrl: string }) {
  const content = (
    <>
      <img
        src="/shopifyImage.png"
        width="22"
        height="25"
        alt=""
        className={styles.shopifyIcon}
        style={criticalShopifyIconStyle}
      />
      <span>Open Shopify pricing</span>
      <ArrowRightIcon />
    </>
  );

  if (appPricingUrl.startsWith("/")) {
    return (
      <Link
        to={appPricingUrl}
        className={`${styles.pricingLink} lystr-pricing-link`}
        style={criticalPricingLinkStyle}
      >
        {content}
      </Link>
    );
  }

  return (
    <a
      href={appPricingUrl}
      target="_top"
      className={`${styles.pricingLink} lystr-pricing-link`}
      style={criticalPricingLinkStyle}
    >
      {content}
    </a>
  );
}

function LoadingSpinner() {
  return (
    <span
      className="lystr-loading-spinner"
      style={criticalSpinnerStyle}
      aria-hidden="true"
    />
  );
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);
  const requestUrl = new URL(request.url);
  const isBillingReturn = requestUrl.searchParams.get("billing_return") === "1";
  const connectionRequired =
    requestUrl.searchParams.get("connection_required") === "1";

  const configResponse = await getLystrConnectorConfig();
  const statusResponse = await getLystrConnectorStatus({
    shopDomain: session.shop,
  }).catch((error) => {
    console.warn("Failed to fetch Lystr connector status.", error);
    return null;
  });
  const activeSubscription = await getCurrentShopifyBillingSubscription({
    admin,
    config: configResponse.config,
    request,
    shopDomain: session.shop,
  });
  const reconciledConnector = statusResponse?.connector
    ? await syncLystrConnectorBilling({
        shopDomain: session.shop,
        shopifySubscription: activeSubscription,
      })
        .then((result) => result.connector)
        .catch((error) => {
          console.warn(
            "Failed to reconcile Lystr billing while opening the app.",
            error,
          );
          return null;
        })
    : null;

  let connector: LystrConnectorStatus | null =
    reconciledConnector ?? statusResponse?.connector ?? null;
  const claimedStoreId = getClaimedLystrStoreId(connector);
  const store = claimedStoreId
    ? await prisma.store.findUnique({ where: { id: claimedStoreId } })
    : await prisma.store.findFirst({
        where: {
          accessToken: { not: null },
          connected: true,
          shopDomain: session.shop,
        },
      });
  let connected = Boolean(
    store?.connected && store.accessToken && store.shopDomain,
  );
  const canFinalizeWithCurrentSubscription =
    activeSubscription && canUseCurrentShopifySubscription(activeSubscription);
  const shouldFinalizeConnection = shouldFinalizeLystrStoreConnection({
    connector,
    hasLocalApiKey: Boolean(store?.apiKey),
    isBillingReturn,
  });

  if (
    session.accessToken &&
    activeSubscription &&
    canFinalizeWithCurrentSubscription &&
    shouldFinalizeConnection
  ) {
    try {
      const billingAttempt = await getShopifyBillingAttempt(session.shop);
      const billingAttemptPlanKey =
        billingAttempt?.planKey === "basic" ||
        billingAttempt?.planKey === "pro" ||
        billingAttempt?.planKey === "premium"
          ? billingAttempt.planKey
          : null;
      const attemptMatchesSubscription =
        billingAttempt?.subscriptionId === activeSubscription.id;
      const activeSubscriptionCreatedAt = activeSubscription.createdAt
        ? new Date(activeSubscription.createdAt)
        : null;
      const canAttachUnassignedAttempt = Boolean(
        billingAttempt &&
        billingAttempt.state === SHOPIFY_BILLING_ATTEMPT_STATES.creating &&
        !billingAttempt.subscriptionId &&
        billingAttemptPlanKey &&
        billingAttemptPlanKey === activeSubscription.planKey &&
        activeSubscription.id !== connector?.shopifySubscriptionId &&
        activeSubscriptionCreatedAt &&
        !Number.isNaN(activeSubscriptionCreatedAt.getTime()) &&
        activeSubscriptionCreatedAt.getTime() >=
          billingAttempt.createdAt.getTime(),
      );
      let attemptWasCorrelated = attemptMatchesSubscription;

      if (
        billingAttempt &&
        billingAttemptPlanKey &&
        (attemptMatchesSubscription || canAttachUnassignedAttempt)
      ) {
        const scheduled = await updateLystrConnectorPlanTransition({
          action: "schedule",
          activatesAt: (
            billingAttempt.activatesAt ?? billingAttempt.createdAt
          ).toISOString(),
          pendingSubscriptionId: activeSubscription.id,
          planKey: billingAttemptPlanKey,
          shopDomain: session.shop,
          status: "PENDING_APPROVAL",
        });
        connector = scheduled.connector;
        const scheduleConfirmedPending =
          connector.pendingShopifySubscriptionId === activeSubscription.id &&
          connector.pendingShopifyPlanKey === billingAttemptPlanKey &&
          (connector.pendingShopifyPlanStatus === "PENDING_APPROVAL" ||
            connector.pendingShopifyPlanStatus === "APPROVED");
        const scheduleConfirmedCurrent =
          connector.shopifySubscriptionId === activeSubscription.id;

        if (!scheduleConfirmedPending && !scheduleConfirmedCurrent) {
          throw new Error(
            "Lystr did not correlate the approved Shopify subscription.",
          );
        }

        attemptWasCorrelated =
          attemptMatchesSubscription || scheduleConfirmedPending;
      }

      const connectResult = await connectLystrStore({
        accessToken: session.accessToken,
        apiKey: store?.apiKey ?? undefined,
        shopDomain: session.shop,
        shopifySubscription: activeSubscription,
      });
      connector = connectResult.connector;
      const connectedSubscriptionStatus =
        connector.shopifySubscriptionStatus?.trim().toUpperCase() ?? "";

      if (
        connector.shopifySubscriptionId !== activeSubscription.id ||
        (connectedSubscriptionStatus !== "ACTIVE" &&
          connectedSubscriptionStatus !== "ACCEPTED")
      ) {
        throw new Error(
          "Lystr did not adopt the approved Shopify subscription.",
        );
      }

      connected = Boolean(
        connectResult.connector.accessAllowed &&
        connectResult.connector.storeId,
      );
      if (billingAttempt && attemptWasCorrelated) {
        const latestAttempt = await getShopifyBillingAttempt(session.shop);

        if (
          latestAttempt?.id === billingAttempt.id &&
          latestAttempt.updatedAt.getTime() ===
            billingAttempt.updatedAt.getTime()
        ) {
          await clearShopifyBillingAttempt({
            attemptId: billingAttempt.id,
            expectedUpdatedAt: billingAttempt.updatedAt,
            shopDomain: session.shop,
          }).catch((error) => {
            console.warn(
              "Failed to clear the completed billing attempt.",
              error,
            );
          });
        }
      }
    } catch (error) {
      console.error(
        "Failed to finalize Lystr connector store connection.",
        error,
      );
    }
  }

  const connectorHasAttachedStore = Boolean(connector?.storeId);
  return {
    appPricingUrl: isShopifyManualBillingEnabled()
      ? "/app/billing"
      : getAppPricingPlanSelectionUrl(session.shop),
    config: configResponse.config,
    connected: connector
      ? Boolean(
          connector.accessAllowed &&
          connectorHasAttachedStore &&
          connector.connectionPending !== true,
        )
      : connected,
    connector,
    connectionRequired,
    hasPendingStore: Boolean(store?.apiKey || connector?.connectionPending),
    shopDomain: session.shop,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, redirect, session } = await authenticate.admin(request);

  const formData = await request.formData();
  const apiKeyValue = formData.get("apiKey");

  if (typeof apiKeyValue !== "string") {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  const apiKey = apiKeyValue.trim();

  if (!apiKey) {
    return Response.json(
      { error: "API key is required." } satisfies ActionData,
      {
        status: 400,
      },
    );
  }

  if (!session.shop) {
    return Response.json(
      { error: "No shop domain found for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  if (!session.accessToken) {
    return Response.json(
      { error: "No access token for this session." } satisfies ActionData,
      { status: 400 },
    );
  }

  try {
    const prepared = await prepareLystrStoreConnection({
      apiKey,
      shopDomain: session.shop,
    });
    const activeSubscription = await getCurrentShopifyBillingSubscription({
      admin,
      config: prepared.config,
      request,
      shopDomain: session.shop,
    });
    const canConnectWithCurrentSubscription =
      activeSubscription &&
      canUseCurrentShopifySubscription(activeSubscription);

    if (canConnectWithCurrentSubscription) {
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey,
        shopDomain: session.shop,
        shopifySubscription: activeSubscription,
      });

      return Response.json({ success: true } satisfies ActionData);
    }

    if (
      prepared.connector.status === "GRANDFATHERED" ||
      canReconnectWithStoredPaidEntitlement(prepared.connector)
    ) {
      await connectLystrStore({
        accessToken: session.accessToken,
        apiKey,
        shopDomain: session.shop,
      });

      return Response.json({ success: true } satisfies ActionData);
    }
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    if (isBillingApprovalRequiredMessage(errorMessage)) {
      if (isShopifyManualBillingEnabled()) {
        return redirect("/app/billing");
      }

      return redirect(getAppPricingPlanSelectionUrl(session.shop), {
        target: "_top",
      });
    }

    console.error("Failed to connect Lystr store from Shopify app.", error);

    return Response.json({ error: errorMessage } satisfies ActionData, {
      status: 400,
    });
  }

  if (isShopifyManualBillingEnabled()) {
    return redirect("/app/billing");
  }

  return redirect(getAppPricingPlanSelectionUrl(session.shop), {
    target: "_top",
  });
};

export default function Index() {
  const {
    appPricingUrl,
    config,
    connected,
    connectionRequired,
    connector,
    hasPendingStore,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const isConnectingStore =
    navigation.state === "submitting" &&
    navigation.formData?.has("apiKey") === true;

  const status = connector?.status ?? (hasPendingStore ? "INCOMPLETE" : "");
  const statusMessage = connector
    ? getConnectorMessage(connector)
    : hasPendingStore
      ? "Approve Shopify billing to finish connecting this store."
      : "";
  const connectionRequiredMessage = connectionRequired
    ? "Connect your Lystr store before choosing a billing plan."
    : null;
  const shouldShowPricingButton =
    status === "INCOMPLETE" ||
    status === "PAYMENT_REQUIRED" ||
    Boolean(connector?.billingApprovalRequired);
  const hasPendingBillingApproval =
    connector?.pendingShopifyPlanStatus?.trim().toUpperCase() ===
    "PENDING_APPROVAL";
  const isBillingIncomplete =
    hasPendingStore &&
    shouldShowPricingButton &&
    actionData?.success !== true &&
    (hasPendingBillingApproval || connector?.accessAllowed !== true);
  const isConnected =
    !isBillingIncomplete && (connected || actionData?.success === true);
  const isPaidAccessEnding = Boolean(
    isConnected &&
    connector?.reconnectRequired === true &&
    connector.accessAllowed,
  );
  const connectedBadgeContent = isPaidAccessEnding
    ? connector
      ? getConnectorMessage(connector)
      : "Store connected until the paid period ends."
    : "Active Shopify connector subscription.";
  const billingFeatureTitle = "Shopify approval";
  const paidPlanCreditValues = Object.values(config.planCredits ?? {}).filter(
    (value): value is number => Number.isFinite(value) && value > 0,
  );
  const minPaidPlanCredits =
    paidPlanCreditValues.length > 0 ? Math.min(...paidPlanCreditValues) : 0;
  const maxPaidPlanCredits =
    paidPlanCreditValues.length > 0 ? Math.max(...paidPlanCreditValues) : 0;
  const creditFeatureTitle =
    minPaidPlanCredits > 0 && maxPaidPlanCredits > minPaidPlanCredits
      ? `${minPaidPlanCredits}-${maxPaidPlanCredits} Lystr credits`
      : minPaidPlanCredits === 1
        ? "1 Lystr credit"
        : `${minPaidPlanCredits || config.creditsPerSuccessfulPayment} Lystr credits`;
  const pricingFeatureTitle = "Shopify billing";

  return (
    <div className={styles.page} style={criticalPageStyle}>
      <StableRouteStyles />
      <div className={styles.pageSweep} aria-hidden="true" />
      <SceneDecor />
      <section className={styles.scene} style={criticalSceneStyle}>
        <HeroIcon />

        {isConnected ? (
          <div className={styles.statusStack} style={criticalStatusStackStyle}>
            <div
              className={`${styles.statusTitle} lystr-status-title`}
              style={criticalStatusTitleStyle}
            >
              <span
                className={
                  isPaidAccessEnding
                    ? `${styles.statusPulseWarning} lystr-status-warning-dot`
                    : `${styles.statusIcon} ${styles.statusIconSuccess} lystr-status-success-dot`
                }
                style={
                  isPaidAccessEnding
                    ? criticalWarningPulseStyle
                    : criticalStatusIconSuccessStyle
                }
                aria-hidden="true"
              />
              <h1 style={criticalStatusHeadingStyle}>
                {isPaidAccessEnding
                  ? "Store connected until the plan ends."
                  : "Store connected successfully to Lystr Connect."}
              </h1>
            </div>
            <span
              className={styles.statusDivider}
              style={criticalStatusDividerStyle}
              aria-hidden="true"
            />
            <div
              className={`${styles.statusPill} lystr-status-pill`}
              style={criticalStatusPillStyle}
            >
              <span
                className={styles.statusPillIcon}
                style={criticalStatusPillIconStyle}
              >
                <CalendarIcon />
              </span>
              <span>{connectedBadgeContent}</span>
            </div>
            <RedirectButton />
          </div>
        ) : isBillingIncomplete ? (
          <div className={styles.statusStack} style={criticalStatusStackStyle}>
            <div
              className={`${styles.statusTitle} ${styles.statusTitleIncomplete} lystr-status-title`}
              style={criticalStatusTitleStyle}
            >
              <span
                className={`${styles.statusPulseWarning} lystr-status-warning-dot`}
                style={criticalWarningPulseStyle}
                aria-hidden="true"
              />
              <h1 style={criticalIncompleteHeadingStyle}>
                Store connection not yet complete.
              </h1>
            </div>
            <span
              className={styles.statusDivider}
              style={criticalStatusDividerStyle}
              aria-hidden="true"
            />
            <p className={styles.statusCopy} style={criticalStatusCopyStyle}>
              {statusMessage}
            </p>
            <ShopifyPricingLink appPricingUrl={appPricingUrl} />
            <RedirectButton />
            <p className={styles.redirectNote} style={criticalStatusCopyStyle}>
              You will be redirected automatically.
            </p>
          </div>
        ) : (
          <>
            <div className={styles.heroCopy} style={criticalHeroCopyStyle}>
              <h1 style={criticalHeroTitleStyle}>
                Connect your{" "}
                <span style={criticalHeroAccentStyle}>Shopify</span> store
              </h1>
              {connectionRequiredMessage ? (
                <p style={criticalHeroTextStyle}>{connectionRequiredMessage}</p>
              ) : null}
            </div>

            <Form
              method="post"
              className={`${styles.connectCard} lystr-connect-card`}
              style={criticalConnectCardStyle}
            >
              <div
                className={`${styles.featureGrid} lystr-feature-grid`}
                style={criticalFeatureGridStyle}
              >
                <FeatureItem
                  icon={<CalendarIcon />}
                  title={billingFeatureTitle}
                  description="Paid plans start immediately"
                />
                <FeatureItem
                  icon={<TagIcon />}
                  title={pricingFeatureTitle}
                  description="Billed per connected store"
                />
                <FeatureItem
                  icon={<GiftIcon />}
                  title={creditFeatureTitle}
                  description="Added with each payment"
                />
              </div>

              <div
                className={`${styles.fieldGroup} lystr-field-group`}
                style={criticalFieldGroupStyle}
              >
                <label
                  htmlFor="lystr-api-key"
                  className={styles.fieldLabel}
                  style={criticalFieldLabelStyle}
                >
                  Enter your API key
                </label>
                <div
                  className={`${styles.inputShell} lystr-input-shell`}
                  style={criticalInputShellStyle}
                >
                  <span
                    className={`${styles.inputIcon} lystr-input-icon`}
                    style={criticalInputIconStyle}
                  >
                    <KeyIcon />
                  </span>
                  <input
                    id="lystr-api-key"
                    name="apiKey"
                    placeholder="Paste your API key here"
                    required
                    className={`${styles.apiInput} lystr-api-input`}
                    style={criticalApiInputStyle}
                  />
                </div>
                {actionData && "error" in actionData ? (
                  <p
                    className={styles.errorText}
                    style={criticalErrorTextStyle}
                  >
                    {actionData.error}
                  </p>
                ) : null}
              </div>

              <button
                type="submit"
                className={`${styles.connectButton} lystr-connect-button`}
                style={
                  isConnectingStore
                    ? {
                        ...criticalConnectButtonStyle,
                        ...criticalConnectButtonLoadingStyle,
                      }
                    : criticalConnectButtonStyle
                }
                disabled={isConnectingStore}
                aria-busy={isConnectingStore}
                aria-label={isConnectingStore ? "Connecting store" : undefined}
              >
                {isConnectingStore ? (
                  <span style={criticalLoadingContentStyle}>
                    <LoadingSpinner />
                  </span>
                ) : (
                  <>
                    <span
                      className={`${styles.buttonIcon} lystr-button-icon`}
                      style={criticalButtonIconStyle}
                    >
                      <LinkIcon />
                    </span>
                    <span>Connect Store</span>
                    <ArrowRightIcon />
                  </>
                )}
              </button>
            </Form>
          </>
        )}
      </section>
    </div>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
