import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHOPIFY_BILLING_ATTEMPT_STATES,
  acquireShopifyBillingCreationLease,
  clearShopifyBillingAttempt,
  getShopifyBillingAttempt,
  hasResumableShopifyBillingAttempt,
  releaseShopifyBillingCreationLease,
  savePendingShopifyBillingAttempt,
  waitForPendingShopifyBillingAttempt,
} from "../app/shopify-billing-attempt.server";
import { resetFakePrisma } from "./fake-db.server";

const SHOP = "example.myshopify.com";
const CONFIRMATION_URL = "https://admin.shopify.com/charges/approval";
const SUBSCRIPTION_ID = "gid://shopify/AppSubscription/123";
const ACTIVATES_AT = new Date("2026-07-29T12:00:00.000Z");

test.beforeEach(() => {
  resetFakePrisma();
});

test("concurrent requests acquire exactly one creation lease", async () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const results = await Promise.all([
    acquireShopifyBillingCreationLease({
      activatesAt: ACTIVATES_AT,
      now,
      planKey: "basic",
      shopDomain: SHOP,
    }),
    acquireShopifyBillingCreationLease({
      activatesAt: ACTIVATES_AT,
      now,
      planKey: "basic",
      shopDomain: SHOP,
    }),
  ]);

  assert.equal(results.filter((result) => result.acquired).length, 1);
  assert.equal(results.filter((result) => !result.acquired).length, 1);
  assert.equal((await getShopifyBillingAttempt(SHOP))?.planKey, "basic");
});

test("a Free-plan mutation and paid-plan creation share the same shop lock", async () => {
  const now = new Date("2026-07-29T12:00:00.000Z");
  const freeMutation = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now,
    planKey: "free",
    shopDomain: SHOP,
  });
  const paidMutation = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now,
    planKey: "basic",
    shopDomain: SHOP,
  });

  assert.equal(freeMutation.acquired, true);
  assert.equal(paidMutation.acquired, false);
  assert.equal((await getShopifyBillingAttempt(SHOP))?.planKey, "free");
});

test("a fresh creation lease blocks another plan, while an expired lease is reclaimable", async () => {
  const startedAt = new Date("2026-07-29T12:00:00.000Z");
  const first = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: startedAt,
    planKey: "basic",
    shopDomain: SHOP,
  });
  const blocked = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: new Date(startedAt.getTime() + 299_999),
    planKey: "pro",
    shopDomain: SHOP,
  });
  const reclaimed = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: new Date(startedAt.getTime() + 300_001),
    planKey: "pro",
    shopDomain: SHOP,
  });

  assert.equal(first.acquired, true);
  assert.equal(blocked.acquired, false);
  assert.equal(reclaimed.acquired, true);
  assert.notEqual(
    first.acquired ? first.requestToken : null,
    reclaimed.acquired ? reclaimed.requestToken : null,
  );
  assert.equal((await getShopifyBillingAttempt(SHOP))?.planKey, "pro");
});

test("an expired lease owner cannot overwrite the newer billing attempt", async () => {
  const startedAt = new Date("2026-07-29T12:00:00.000Z");
  const first = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: startedAt,
    planKey: "basic",
    shopDomain: SHOP,
  });
  const replacement = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: new Date(startedAt.getTime() + 300_001),
    planKey: "pro",
    shopDomain: SHOP,
  });

  assert.equal(first.acquired, true);
  assert.equal(replacement.acquired, true);

  await savePendingShopifyBillingAttempt({
    confirmationUrl: "https://admin.shopify.com/charges/stale",
    planKey: "basic",
    requestToken: first.acquired ? first.requestToken : null,
    shopDomain: SHOP,
    subscriptionId: "gid://shopify/AppSubscription/stale",
  });

  const afterStaleResponse = await getShopifyBillingAttempt(SHOP);
  assert.equal(
    afterStaleResponse?.state,
    SHOPIFY_BILLING_ATTEMPT_STATES.creating,
  );
  assert.equal(afterStaleResponse?.planKey, "pro");
  assert.equal(afterStaleResponse?.subscriptionId, null);

  await savePendingShopifyBillingAttempt({
    confirmationUrl: CONFIRMATION_URL,
    planKey: "pro",
    requestToken: replacement.acquired ? replacement.requestToken : null,
    shopDomain: SHOP,
    subscriptionId: SUBSCRIPTION_ID,
  });

  const saved = await getShopifyBillingAttempt(SHOP);
  assert.equal(saved?.state, SHOPIFY_BILLING_ATTEMPT_STATES.pending);
  assert.equal(saved?.confirmationUrl, CONFIRMATION_URL);
  assert.equal(saved?.subscriptionId, SUBSCRIPTION_ID);
});

test("saving a pending approval makes the exact Shopify approval resumable for 48 hours", async () => {
  const createdAt = new Date("2026-07-29T12:00:00.000Z");
  const lease = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: createdAt,
    planKey: "premium",
    shopDomain: SHOP,
  });

  assert.equal(lease.acquired, true);

  const saved = await savePendingShopifyBillingAttempt({
    confirmationUrl: CONFIRMATION_URL,
    createdAt,
    planKey: "premium",
    requestToken: lease.acquired ? lease.requestToken : null,
    shopDomain: SHOP,
    subscriptionId: SUBSCRIPTION_ID,
  });

  assert.equal(saved?.activatesAt?.toISOString(), ACTIVATES_AT.toISOString());
  assert.equal(saved?.leaseExpiresAt, null);
  assert.equal(saved?.requestToken, null);
  assert.equal(
    saved?.approvalExpiresAt?.toISOString(),
    "2026-07-31T12:00:00.000Z",
  );
  assert.equal(
    hasResumableShopifyBillingAttempt(
      saved,
      new Date("2026-07-31T11:59:59.999Z"),
    ),
    true,
  );
  assert.equal(
    hasResumableShopifyBillingAttempt(
      saved,
      new Date("2026-07-31T12:00:00.000Z"),
    ),
    false,
  );

  const reclaimed = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    now: new Date("2026-07-31T12:00:00.000Z"),
    planKey: "basic",
    shopDomain: SHOP,
  });
  assert.equal(reclaimed.acquired, true);
});

test("partial or non-pending records are never treated as resumable approvals", () => {
  const baseAttempt = {
    approvalExpiresAt: null,
    activatesAt: ACTIVATES_AT,
    confirmationUrl: CONFIRMATION_URL,
    createdAt: new Date(),
    id: "1",
    leaseExpiresAt: null,
    planKey: "basic",
    requestToken: null,
    shopDomain: SHOP,
    state: SHOPIFY_BILLING_ATTEMPT_STATES.pending,
    subscriptionId: SUBSCRIPTION_ID,
    updatedAt: new Date(),
  };

  assert.equal(hasResumableShopifyBillingAttempt(baseAttempt), true);
  assert.equal(
    hasResumableShopifyBillingAttempt({
      ...baseAttempt,
      confirmationUrl: null,
    }),
    false,
  );
  assert.equal(
    hasResumableShopifyBillingAttempt({
      ...baseAttempt,
      subscriptionId: null,
    }),
    false,
  );
  assert.equal(
    hasResumableShopifyBillingAttempt({
      ...baseAttempt,
      state: SHOPIFY_BILLING_ATTEMPT_STATES.creating,
    }),
    false,
  );
});

test("a concurrent waiter converges on the approval created by the lease owner", async () => {
  const lease = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    planKey: "basic",
    shopDomain: SHOP,
  });
  assert.equal(lease.acquired, true);

  const waiting = waitForPendingShopifyBillingAttempt({
    attempts: 3,
    delayMs: 0,
    shopDomain: SHOP,
  });

  await Promise.resolve();
  await savePendingShopifyBillingAttempt({
    confirmationUrl: CONFIRMATION_URL,
    planKey: "basic",
    requestToken: lease.acquired ? lease.requestToken : null,
    shopDomain: SHOP,
    subscriptionId: SUBSCRIPTION_ID,
  });

  const result = await waiting;
  assert.equal(result?.confirmationUrl, CONFIRMATION_URL);
  assert.equal(result?.subscriptionId, SUBSCRIPTION_ID);
});

test("cleanup is correlated so an old request cannot remove a newer attempt", async () => {
  const first = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    planKey: "basic",
    shopDomain: SHOP,
  });
  assert.equal(first.acquired, true);

  await savePendingShopifyBillingAttempt({
    confirmationUrl: CONFIRMATION_URL,
    planKey: "basic",
    requestToken: first.acquired ? first.requestToken : null,
    shopDomain: SHOP,
    subscriptionId: SUBSCRIPTION_ID,
  });

  await releaseShopifyBillingCreationLease({
    requestToken: first.acquired ? first.requestToken : "",
    shopDomain: SHOP,
  });
  await clearShopifyBillingAttempt({
    shopDomain: SHOP,
    subscriptionId: "gid://shopify/AppSubscription/older",
  });
  assert.ok(await getShopifyBillingAttempt(SHOP));

  await clearShopifyBillingAttempt({
    shopDomain: SHOP,
    subscriptionId: SUBSCRIPTION_ID,
  });
  assert.equal(await getShopifyBillingAttempt(SHOP), null);
});

test("uncorrelated recovery cannot overwrite a newer creation lease", async () => {
  const lease = await acquireShopifyBillingCreationLease({
    activatesAt: ACTIVATES_AT,
    planKey: "pro",
    shopDomain: SHOP,
  });
  assert.equal(lease.acquired, true);

  await savePendingShopifyBillingAttempt({
    confirmationUrl: "https://admin.shopify.com/charges/older",
    planKey: "basic",
    shopDomain: SHOP,
    subscriptionId: "gid://shopify/AppSubscription/older",
  });

  const current = await getShopifyBillingAttempt(SHOP);
  assert.equal(current?.state, SHOPIFY_BILLING_ATTEMPT_STATES.creating);
  assert.equal(current?.planKey, "pro");
  assert.equal(current?.subscriptionId, null);
});
