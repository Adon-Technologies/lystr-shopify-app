import { randomUUID } from "node:crypto";
import type { ShopifyBillingAttempt } from "@prisma/client";
import prisma from "./db.server";

export const SHOPIFY_BILLING_ATTEMPT_STATES = {
  creating: "CREATING",
  pending: "PENDING",
} as const;

const CREATION_LEASE_MS = 5 * 60 * 1_000;
const SHOPIFY_APPROVAL_LIFETIME_MS = 48 * 60 * 60 * 1_000;

type BillingPlanKey = "free" | "basic" | "pro" | "premium";

function isUniqueConstraintError(error: unknown) {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "P2002",
  );
}

export async function getShopifyBillingAttempt(shopDomain: string) {
  return prisma.shopifyBillingAttempt.findUnique({
    where: { shopDomain },
  });
}

export async function acquireShopifyBillingCreationLease({
  activatesAt,
  now = new Date(),
  planKey,
  shopDomain,
}: {
  activatesAt: Date;
  now?: Date;
  planKey: BillingPlanKey;
  shopDomain: string;
}) {
  const requestToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + CREATION_LEASE_MS);

  try {
    const attempt = await prisma.shopifyBillingAttempt.create({
      data: {
        activatesAt,
        leaseExpiresAt,
        planKey,
        requestToken,
        shopDomain,
        state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
      },
    });

    return { acquired: true as const, attempt, requestToken };
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  const claimed = await prisma.shopifyBillingAttempt.updateMany({
    where: {
      shopDomain,
      OR: [
        {
          state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
          OR: [
            { leaseExpiresAt: null },
            {
              leaseExpiresAt: {
                lte: now,
              },
            },
          ],
        },
        {
          state: SHOPIFY_BILLING_ATTEMPT_STATES.pending,
          approvalExpiresAt: {
            lte: now,
          },
        },
      ],
    },
    data: {
      activatesAt,
      approvalExpiresAt: null,
      confirmationUrl: null,
      leaseExpiresAt,
      planKey,
      requestToken,
      state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
      subscriptionId: null,
    },
  });

  if (claimed.count > 0) {
    const attempt = await getShopifyBillingAttempt(shopDomain);

    if (attempt) {
      return { acquired: true as const, attempt, requestToken };
    }
  }

  return {
    acquired: false as const,
    attempt: await getShopifyBillingAttempt(shopDomain),
    requestToken: null,
  };
}

export async function savePendingShopifyBillingAttempt({
  activatesAt,
  confirmationUrl,
  createdAt = new Date(),
  planKey,
  requestToken,
  shopDomain,
  subscriptionId,
}: {
  activatesAt?: Date | null;
  confirmationUrl: string;
  createdAt?: Date;
  planKey: BillingPlanKey;
  requestToken?: string | null;
  shopDomain: string;
  subscriptionId: string;
}) {
  const data = {
    ...(activatesAt ? { activatesAt } : {}),
    approvalExpiresAt: new Date(
      createdAt.getTime() + SHOPIFY_APPROVAL_LIFETIME_MS,
    ),
    confirmationUrl,
    leaseExpiresAt: null,
    planKey,
    requestToken: null,
    state: SHOPIFY_BILLING_ATTEMPT_STATES.pending,
    subscriptionId,
  };

  if (requestToken) {
    const saved = await prisma.shopifyBillingAttempt.updateMany({
      where: {
        requestToken,
        shopDomain,
        state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
      },
      data,
    });

    if (saved.count > 0) {
      return getShopifyBillingAttempt(shopDomain);
    }

    // A newer request may have reclaimed an expired creation lease. Never let
    // the older request overwrite the newer attempt after its Shopify call
    // eventually returns.
    return getShopifyBillingAttempt(shopDomain);
  }

  try {
    return await prisma.shopifyBillingAttempt.create({
      data: {
        ...data,
        shopDomain,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  await prisma.shopifyBillingAttempt.updateMany({
    where: {
      shopDomain,
      state: SHOPIFY_BILLING_ATTEMPT_STATES.pending,
      subscriptionId,
    },
    data,
  });

  return getShopifyBillingAttempt(shopDomain);
}

export async function releaseShopifyBillingCreationLease({
  requestToken,
  shopDomain,
}: {
  requestToken: string;
  shopDomain: string;
}) {
  await prisma.shopifyBillingAttempt.deleteMany({
    where: {
      requestToken,
      shopDomain,
      state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
    },
  });
}

export async function clearShopifyBillingAttempt({
  attemptId,
  expectedUpdatedAt,
  shopDomain,
  subscriptionId,
}: {
  attemptId?: string | null;
  expectedUpdatedAt?: Date | null;
  shopDomain: string;
  subscriptionId?: string | null;
}) {
  await prisma.shopifyBillingAttempt.deleteMany({
    where: {
      shopDomain,
      ...(attemptId ? { id: attemptId } : {}),
      ...(expectedUpdatedAt ? { updatedAt: expectedUpdatedAt } : {}),
      ...(subscriptionId ? { subscriptionId } : {}),
    },
  });
}

export async function waitForPendingShopifyBillingAttempt({
  attempts = 15,
  delayMs = 200,
  shopDomain,
}: {
  attempts?: number;
  delayMs?: number;
  shopDomain: string;
}) {
  for (let attemptNumber = 0; attemptNumber < attempts; attemptNumber += 1) {
    const attempt = await getShopifyBillingAttempt(shopDomain);

    if (
      attempt?.state === SHOPIFY_BILLING_ATTEMPT_STATES.pending &&
      attempt.subscriptionId &&
      attempt.confirmationUrl
    ) {
      return attempt;
    }

    if (attempt?.state !== SHOPIFY_BILLING_ATTEMPT_STATES.creating) {
      return attempt;
    }

    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  return getShopifyBillingAttempt(shopDomain);
}

export function hasResumableShopifyBillingAttempt(
  attempt: ShopifyBillingAttempt | null | undefined,
  now = new Date(),
) {
  return Boolean(
    attempt?.state === SHOPIFY_BILLING_ATTEMPT_STATES.pending &&
    attempt.subscriptionId &&
    attempt.confirmationUrl &&
    (!attempt.approvalExpiresAt ||
      attempt.approvalExpiresAt.getTime() > now.getTime()),
  );
}
