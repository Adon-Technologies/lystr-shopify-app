type BillingAttempt = {
  activatesAt: Date | null;
  approvalExpiresAt: Date | null;
  confirmationUrl: string | null;
  createdAt: Date;
  id: string;
  leaseExpiresAt: Date | null;
  planKey: string;
  requestToken: string | null;
  shopDomain: string;
  state: string;
  subscriptionId: string | null;
  updatedAt: Date;
};

type Where = Record<string, unknown>;

const attempts = new Map<string, BillingAttempt>();
let nextId = 1;

function matches(attempt: BillingAttempt, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "OR") {
      return (expected as Where[]).some((condition) =>
        matches(attempt, condition),
      );
    }

    if (
      expected &&
      typeof expected === "object" &&
      "lte" in (expected as Record<string, unknown>)
    ) {
      const actual = attempt[key as keyof BillingAttempt];
      return (
        actual instanceof Date &&
        actual.getTime() <=
          ((expected as { lte: Date }).lte instanceof Date
            ? (expected as { lte: Date }).lte.getTime()
            : Number.NaN)
      );
    }

    return attempt[key as keyof BillingAttempt] === expected;
  });
}

function makeAttempt(
  data: Partial<BillingAttempt> & {
    planKey: string;
    shopDomain: string;
    state: string;
  },
): BillingAttempt {
  const now = new Date();

  return {
    activatesAt: null,
    approvalExpiresAt: null,
    confirmationUrl: null,
    createdAt: now,
    id: String(nextId++),
    leaseExpiresAt: null,
    requestToken: null,
    subscriptionId: null,
    updatedAt: now,
    ...data,
  };
}

function applyData(attempt: BillingAttempt, data: Partial<BillingAttempt>) {
  Object.assign(attempt, data, { updatedAt: new Date() });
}

export function resetFakePrisma() {
  attempts.clear();
  nextId = 1;
}

const shopifyBillingAttempt = {
  async create({ data }: { data: BillingAttempt }) {
    if (attempts.has(data.shopDomain)) {
      throw Object.assign(new Error("Unique constraint failed"), {
        code: "P2002",
      });
    }

    const attempt = makeAttempt(data);
    attempts.set(data.shopDomain, attempt);
    return attempt;
  },

  async deleteMany({ where }: { where: Where }) {
    let count = 0;

    for (const [shopDomain, attempt] of attempts) {
      if (matches(attempt, where)) {
        attempts.delete(shopDomain);
        count += 1;
      }
    }

    return { count };
  },

  async findUnique({ where }: { where: { shopDomain: string } }) {
    return attempts.get(where.shopDomain) ?? null;
  },

  async updateMany({
    data,
    where,
  }: {
    data: Partial<BillingAttempt>;
    where: Where;
  }) {
    let count = 0;

    for (const attempt of attempts.values()) {
      if (matches(attempt, where)) {
        applyData(attempt, data);
        count += 1;
      }
    }

    return { count };
  },

  async upsert({
    create,
    update,
    where,
  }: {
    create: BillingAttempt;
    update: Partial<BillingAttempt>;
    where: { shopDomain: string };
  }) {
    const existing = attempts.get(where.shopDomain);

    if (existing) {
      applyData(existing, update);
      return existing;
    }

    const attempt = makeAttempt(create);
    attempts.set(where.shopDomain, attempt);
    return attempt;
  },
};

export default { shopifyBillingAttempt };
