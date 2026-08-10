import { describe, expect, it } from "vitest";
import type { Candidate } from "./game";
import {
  completedImportSessionFixture,
  importSessionFixture,
} from "./import-session-fixture";
import {
  deriveActivationDisplayReceiptId,
  deriveDequeueOperationId,
  parseImportedCandidateAnnotation,
  parseImportSession,
  type ImportItem,
  type ImportItemStatus,
  type ImportSession,
} from "./import-session";

const digest = (character: string) => character.repeat(64);

const candidate = (id: string): Candidate => ({
  id,
  imageUrl: `/api/assets/${digest(id[0])}.png`,
  prompt: `${id} prompt`,
  concept: `${id} concept`,
  style: ["cinematic"],
  createdAt: "2026-08-09T20:00:00.000Z",
  winCount: 0,
});

const originalReceipt = {
  kind: "selection" as const,
  selectedAt: "2026-08-09T20:02:00.000Z",
  roundNumber: 1,
  winnerSide: "left" as const,
  winnerId: "left",
  loserId: "right",
};

const dequeueReceipt = {
  kind: "dequeue" as const,
  dequeueOperationId: deriveDequeueOperationId(
    "import-session-1",
    "",
    originalReceipt,
    "single",
  ),
  importSessionId: "import-session-1",
  originalReceipt,
  replacementSlot: "single" as const,
  importItemId: "served-dequeue",
  candidateId: "candidate-served-dequeue",
  candidate: candidate("candidate-served-dequeue"),
  provenance: "imported" as const,
  roundNumber: 2,
  servedAt: "2026-08-09T20:03:00.000Z",
};

const session = importSessionFixture;

const annotation = () => ({
  concept: "copper observatory",
  prompt: "A copper observatory under a dark coastal sky.",
  style: ["cinematic"],
  reasoningSummary: "Visible composition and palette.",
  source: "automated" as const,
});

const liveAnnotationJob = (item: ImportItem) => ({
  id: "annotation-job-1",
  kind: "import-annotation" as const,
  createdAt: "2026-08-09T20:00:00.000Z",
  importSessionId: "import-session-1",
  importItemId: item.id,
  asset: item.asset,
});

const itemForStatus = (status: ImportItemStatus): ImportItem => {
  const base = completedImportSessionFixture().items[0];
  switch (status) {
    case "annotating":
      return {
        ...base,
        status,
        annotationJob: liveAnnotationJob(base),
        annotation: null,
        candidateId: null,
        failureMessage: null,
        servedAt: null,
      };
    case "ready":
      return {
        ...base,
        status,
        annotationJob: null,
        annotation: annotation(),
        candidateId: "candidate-ready-1",
        failureMessage: null,
        servedAt: null,
      };
    case "failed":
      return {
        ...base,
        status,
        annotationJob: liveAnnotationJob(base),
        annotation: null,
        candidateId: null,
        failureMessage: "Annotation worker failed safely.",
        servedAt: null,
      };
    case "removed":
      return {
        ...base,
        status,
        annotationJob: null,
        annotation: null,
        candidateId: null,
        failureMessage: null,
        servedAt: null,
      };
    case "served":
      return {
        ...base,
        status,
        annotationJob: null,
        annotation: annotation(),
        candidateId: "candidate-completed-1",
        failureMessage: null,
        servedAt: "2026-08-09T20:02:00.000Z",
      };
  }
};

const sessionForItemStatus = (status: ImportItemStatus): ImportSession => {
  if (status === "served") {
    const completed = completedImportSessionFixture();
    return {
      ...completed,
      status: "active",
      items: [completed.items[0]],
      initialFillJobs: [],
      initialFillRetry: null,
      servedReceipts: [completed.servedReceipts[0]],
    };
  }
  const item = itemForStatus(status);
  return {
    ...completedImportSessionFixture(),
    status:
      status === "removed" || status === "annotating" ? "editing" : "preparing",
    sealedAt:
      status === "ready" || status === "failed"
        ? "2026-08-09T20:01:00.000Z"
        : null,
    activatedAt: null,
    items: [item],
    initialFillJobs: [],
    initialFillRetry: null,
    servedReceipts: [],
  };
};

const activeSessionWithUnresolvedItem = (
  status: "annotating" | "failed",
): ImportSession => {
  const value = sessionForItemStatus(status);
  return {
    ...value,
    status: "active",
    sealedAt: "2026-08-09T20:01:00.000Z",
    activatedAt: "2026-08-09T20:04:00.000Z",
  };
};

const sessionWithRetryHistory = (
  status: "pending" | "ready" | "failed" | "superseded",
): ImportSession => {
  const value = sessionWithInitialFill("ready");
  if (status === "pending") {
    value.status = "preparing";
    value.activatedAt = null;
  }
  value.initialFillJobs.unshift({
    id: "initial-fill-history-1",
    attemptId: "fill-attempt-0",
    status,
    candidate:
      status === "ready" ? candidate("initial-fill-history-candidate") : null,
    source: "generated",
    importItemId: null,
    failureMessage:
      status === "failed" || status === "superseded"
        ? "Initial fill worker failed safely."
        : null,
    completedAt: status === "pending" ? null : "2026-08-09T20:04:00.000Z",
  });
  value.initialFillRetry = {
    failedAttemptId: "fill-attempt-0",
    requestId: "retry-request-1",
    replacementAttemptId: "fill-attempt-1",
    replacementJobIds: ["initial-fill-1"],
    createdAt: "2026-08-09T20:04:30.000Z",
  };
  return value;
};

const sessionWithInitialFill = (
  status: "pending" | "ready" | "failed" | "superseded",
): ImportSession => {
  const base = sessionForItemStatus("removed");
  return {
    ...base,
    status: status === "pending" ? "preparing" : "active",
    sealedAt: "2026-08-09T20:01:00.000Z",
    activatedAt: status === "pending" ? null : "2026-08-09T20:04:00.000Z",
    initialFillJobs: [
      {
        id: "initial-fill-1",
        attemptId: "fill-attempt-1",
        status,
        candidate:
          status === "ready" ? candidate("initial-fill-candidate") : null,
        source: "generated",
        importItemId: null,
        failureMessage:
          status === "failed" || status === "superseded"
            ? "Initial fill worker failed safely."
            : null,
        completedAt: status === "pending" ? null : "2026-08-09T20:05:00.000Z",
      },
    ],
  };
};

describe("import session schema", () => {
  it("parses imported annotations at the 120, 500, and 1000 character boundaries", () => {
    const annotation = {
      concept: "c".repeat(120),
      prompt: "p".repeat(500),
      style: ["cinematic landscape"],
      reasoningSummary: "r".repeat(1_000),
      source: "automated" as const,
    };

    expect(parseImportedCandidateAnnotation(annotation)).toEqual(annotation);
    expect(() =>
      parseImportedCandidateAnnotation({
        ...annotation,
        concept: "c".repeat(121),
      }),
    ).toThrow(/120/i);
    expect(() =>
      parseImportedCandidateAnnotation({
        ...annotation,
        prompt: "p".repeat(501),
      }),
    ).toThrow(/500/i);
    expect(() =>
      parseImportedCandidateAnnotation({
        ...annotation,
        reasoningSummary: "r".repeat(1_001),
      }),
    ).toThrow(/1000/i);
  });

  it("round-trips durable annotations, retry evidence, and both served receipt kinds", () => {
    expect(parseImportSession(session())).toEqual(session());
  });

  it.each([
    ["annotating", () => sessionForItemStatus("annotating")],
    ["ready", () => sessionForItemStatus("ready")],
    ["failed", () => sessionForItemStatus("failed")],
    ["removed", () => sessionForItemStatus("removed")],
    ["served", () => sessionForItemStatus("served")],
  ] as const)("accepts a coherent %s import item", (_status, build) => {
    expect(parseImportSession(build())).toEqual(build());
  });

  it.each([
    [
      "annotating annotation evidence",
      () => {
        const value = sessionForItemStatus("annotating");
        value.items[0].annotation = annotation();
        return value;
      },
    ],
    [
      "annotating candidate evidence",
      () => {
        const value = sessionForItemStatus("annotating");
        value.items[0].candidateId = "candidate-1";
        return value;
      },
    ],
    [
      "annotating served evidence",
      () => {
        const value = sessionForItemStatus("annotating");
        value.items[0].servedAt = "2026-08-09T20:02:00.000Z";
        return value;
      },
    ],
    [
      "ready live annotation work",
      () => {
        const value = sessionForItemStatus("ready");
        value.items[0].annotationJob = liveAnnotationJob(value.items[0]);
        return value;
      },
    ],
    [
      "ready missing candidate",
      () => {
        const value = sessionForItemStatus("ready");
        value.items[0].candidateId = null;
        return value;
      },
    ],
    [
      "ready failure evidence",
      () => {
        const value = sessionForItemStatus("ready");
        value.items[0].failureMessage = "not allowed";
        return value;
      },
    ],
    [
      "ready missing annotation evidence",
      () => {
        const value = sessionForItemStatus("ready");
        value.items[0].annotation = null;
        return value;
      },
    ],
    [
      "ready served evidence",
      () => {
        const value = sessionForItemStatus("ready");
        value.items[0].servedAt = "2026-08-09T20:02:00.000Z";
        return value;
      },
    ],
    [
      "failed annotation evidence",
      () => {
        const value = sessionForItemStatus("failed");
        value.items[0].annotation = annotation();
        return value;
      },
    ],
    [
      "failed missing annotation job",
      () => {
        const value = sessionForItemStatus("failed");
        value.items[0].annotationJob = null;
        return value;
      },
    ],
    [
      "failed candidate evidence",
      () => {
        const value = sessionForItemStatus("failed");
        value.items[0].candidateId = "candidate-1";
        return value;
      },
    ],
    [
      "failed served evidence",
      () => {
        const value = sessionForItemStatus("failed");
        value.items[0].servedAt = "2026-08-09T20:02:00.000Z";
        return value;
      },
    ],
    [
      "removed live annotation work",
      () => {
        const value = sessionForItemStatus("removed");
        value.items[0].annotationJob = liveAnnotationJob(value.items[0]);
        return value;
      },
    ],
    [
      "removed served evidence",
      () => {
        const value = sessionForItemStatus("removed");
        value.items[0].servedAt = "2026-08-09T20:02:00.000Z";
        return value;
      },
    ],
    [
      "served live annotation work",
      () => {
        const value = sessionForItemStatus("served");
        value.items[0].annotationJob = liveAnnotationJob(value.items[0]);
        return value;
      },
    ],
    [
      "served failure evidence",
      () => {
        const value = sessionForItemStatus("served");
        value.items[0].failureMessage = "not allowed";
        return value;
      },
    ],
  ] as const)("rejects %s", (_name, build) => {
    expect(() => parseImportSession(build())).toThrow();
  });

  it("accepts durable IDs at the mailbox boundary and rejects spaces or punctuation", () => {
    const annotationSession = sessionForItemStatus("annotating");
    annotationSession.id = "Session_A-9";
    annotationSession.items[0].id = "Item_A-9";
    annotationSession.items[0].annotationJob = {
      ...annotationSession.items[0].annotationJob!,
      id: "Annotation_A-9",
      importSessionId: "Session_A-9",
      importItemId: "Item_A-9",
    };
    expect(
      parseImportSession(annotationSession).items[0].annotationJob,
    ).toMatchObject({
      id: "Annotation_A-9",
      importSessionId: "Session_A-9",
      importItemId: "Item_A-9",
    });

    const retrySession = completedImportSessionFixture();
    retrySession.initialFillJobs[0] = {
      ...retrySession.initialFillJobs[0],
      id: "Failed_Job-9",
      attemptId: "Failed_A-9",
    };
    retrySession.initialFillJobs[1] = {
      ...retrySession.initialFillJobs[1],
      id: "Fill_A-9",
      attemptId: "Attempt_A-9",
    };
    retrySession.initialFillRetry = {
      failedAttemptId: "Failed_A-9",
      requestId: "Retry_A-9",
      replacementAttemptId: "Attempt_A-9",
      replacementJobIds: ["Fill_A-9"],
      createdAt: "2026-08-09T20:01:30.000Z",
    };
    expect(parseImportSession(retrySession).initialFillRetry).toMatchObject({
      requestId: "Retry_A-9",
      replacementJobIds: ["Fill_A-9"],
    });

    const invalidIds = [
      () => {
        const value = sessionForItemStatus("annotating");
        value.id = "session id";
        value.items[0].annotationJob = {
          ...value.items[0].annotationJob!,
          importSessionId: value.id,
        };
        return value;
      },
      () => {
        const value = sessionForItemStatus("annotating");
        value.items[0].id = "item!";
        value.items[0].annotationJob = {
          ...value.items[0].annotationJob!,
          importItemId: value.items[0].id,
        };
        return value;
      },
      () => {
        const value = sessionForItemStatus("annotating");
        value.items[0].annotationJob = {
          ...value.items[0].annotationJob!,
          id: "annotation job",
        };
        return value;
      },
      () => {
        const value = sessionWithInitialFill("ready");
        value.initialFillJobs[0].id = "fill!";
        return value;
      },
      () => {
        const value = sessionWithInitialFill("ready");
        value.initialFillJobs[0].attemptId = "attempt id";
        return value;
      },
      () => {
        const value = completedImportSessionFixture();
        value.initialFillRetry = {
          ...value.initialFillRetry!,
          requestId: "retry id",
        };
        return value;
      },
      () => {
        const value = completedImportSessionFixture();
        value.initialFillRetry = {
          ...value.initialFillRetry!,
          failedAttemptId: "failed!",
        };
        return value;
      },
      () => {
        const value = completedImportSessionFixture();
        value.initialFillRetry = {
          ...value.initialFillRetry!,
          replacementAttemptId: "replacement attempt",
        };
        return value;
      },
      () => {
        const value = completedImportSessionFixture();
        value.initialFillRetry = {
          ...value.initialFillRetry!,
          replacementJobIds: ["replacement!"],
        };
        return value;
      },
    ];
    for (const build of invalidIds) {
      expect(() => parseImportSession(build())).toThrow();
    }
  });

  it.each([
    ["pending", () => sessionWithInitialFill("pending")],
    ["ready", () => sessionWithInitialFill("ready")],
    ["failed", () => sessionWithInitialFill("failed")],
    ["superseded", () => sessionWithInitialFill("superseded")],
  ] as const)("accepts a coherent %s initial-fill job", (_status, build) => {
    expect(parseImportSession(build())).toEqual(build());
  });

  it.each([
    [
      "pending terminal evidence",
      () => {
        const value = sessionWithInitialFill("pending");
        value.initialFillJobs[0].completedAt = "2026-08-09T20:05:00.000Z";
        return value;
      },
    ],
    [
      "ready failure evidence",
      () => {
        const value = sessionWithInitialFill("ready");
        value.initialFillJobs[0].failureMessage = "not allowed";
        return value;
      },
    ],
    [
      "ready missing candidate evidence",
      () => {
        const value = sessionWithInitialFill("ready");
        value.initialFillJobs[0].candidate = null;
        return value;
      },
    ],
    [
      "failed candidate evidence",
      () => {
        const value = sessionWithInitialFill("failed");
        value.initialFillJobs[0].candidate = candidate(
          "initial-fill-candidate",
        );
        return value;
      },
    ],
    [
      "failed missing terminal failure evidence",
      () => {
        const value = sessionWithInitialFill("failed");
        value.initialFillJobs[0].failureMessage = null;
        return value;
      },
    ],
    [
      "superseded candidate evidence",
      () => {
        const value = sessionWithInitialFill("superseded");
        value.initialFillJobs[0].candidate = candidate(
          "initial-fill-candidate",
        );
        return value;
      },
    ],
    [
      "superseded missing terminal failure evidence",
      () => {
        const value = sessionWithInitialFill("superseded");
        value.initialFillJobs[0].failureMessage = null;
        return value;
      },
    ],
  ] as const)("rejects %s initial-fill job", (_name, build) => {
    expect(() => parseImportSession(build())).toThrow();
  });

  it.each([
    ["editing", () => sessionForItemStatus("annotating")],
    ["preparing", () => sessionForItemStatus("failed")],
    ["active", () => sessionWithInitialFill("ready")],
    ["completed", () => completedImportSessionFixture()],
  ] as const)("accepts a coherent %s import session", (_status, build) => {
    expect(parseImportSession(build()).status).toBe(_status);
  });

  it.each([
    ["annotating", () => activeSessionWithUnresolvedItem("annotating")],
    ["failed", () => activeSessionWithUnresolvedItem("failed")],
  ] as const)(
    "keeps an active %s import item in durable supply",
    (_status, build) => {
      expect(parseImportSession(build()).status).toBe("active");
    },
  );

  it.each([
    [
      "editing seal evidence",
      () => {
        const value = sessionForItemStatus("annotating");
        value.sealedAt = "2026-08-09T20:01:00.000Z";
        return value;
      },
    ],
    [
      "editing initial-fill work",
      () => {
        const value = sessionForItemStatus("annotating");
        value.initialFillJobs =
          sessionWithInitialFill("pending").initialFillJobs;
        return value;
      },
    ],
    [
      "preparing activation evidence",
      () => {
        const value = sessionForItemStatus("failed");
        value.activatedAt = "2026-08-09T20:04:00.000Z";
        return value;
      },
    ],
    [
      "preparing served evidence",
      () => {
        const value = sessionForItemStatus("served");
        value.status = "preparing";
        value.activatedAt = null;
        return value;
      },
    ],
    [
      "active without seal evidence",
      () => {
        const value = sessionWithInitialFill("ready");
        value.sealedAt = null;
        return value;
      },
    ],
    [
      "active without activation evidence",
      () => {
        const value = sessionWithInitialFill("ready");
        value.activatedAt = null;
        return value;
      },
    ],
    [
      "active pending initial-fill work",
      () => {
        const value = sessionWithInitialFill("pending");
        value.status = "active";
        value.activatedAt = "2026-08-09T20:04:00.000Z";
        return value;
      },
    ],
    [
      "completed without seal evidence",
      () => {
        const value = completedImportSessionFixture();
        value.sealedAt = null;
        return value;
      },
    ],
  ] as const)("rejects %s", (_name, build) => {
    expect(() => parseImportSession(build())).toThrow();
  });

  it("requires completed sessions to be fully served and terminal", () => {
    expect(parseImportSession(completedImportSessionFixture())).toMatchObject({
      status: "completed",
      items: expect.arrayContaining([
        expect.objectContaining({ status: "served" }),
      ]),
    });

    const unsealed = completedImportSessionFixture();
    unsealed.sealedAt = null;
    expect(() => parseImportSession(unsealed)).toThrow(/completed.*sealed/i);

    const unactivated = completedImportSessionFixture();
    unactivated.activatedAt = null;
    expect(() => parseImportSession(unactivated)).toThrow(
      /completed.*activated/i,
    );

    for (const status of ["annotating", "ready", "failed"] as const) {
      const incompleteItem = completedImportSessionFixture();
      incompleteItem.items[0] = {
        ...incompleteItem.items[0],
        status,
      };
      expect(() => parseImportSession(incompleteItem)).toThrow(
        /completed.*served/i,
      );
    }

    const missingReceipt = completedImportSessionFixture();
    missingReceipt.servedReceipts.pop();
    expect(() => parseImportSession(missingReceipt)).toThrow(
      /completed.*receipt/i,
    );

    const annotationPending = completedImportSessionFixture();
    annotationPending.items[0].annotationJob = liveAnnotationJob(
      annotationPending.items[0],
    );
    expect(() => parseImportSession(annotationPending)).toThrow(
      /completed.*annotation/i,
    );

    const removedWithAnnotation = completedImportSessionFixture();
    removedWithAnnotation.items[0] = {
      ...removedWithAnnotation.items[0],
      status: "removed",
      annotationJob: liveAnnotationJob(removedWithAnnotation.items[0]),
    };
    removedWithAnnotation.servedReceipts =
      removedWithAnnotation.servedReceipts.filter(
        (receipt) => receipt.importItemId !== removedWithAnnotation.items[0].id,
      );
    expect(() => parseImportSession(removedWithAnnotation)).toThrow(
      /completed.*annotation/i,
    );

    const initialFillPending = completedImportSessionFixture();
    const readyJobIndex = initialFillPending.initialFillJobs.findIndex(
      (job) => job.status === "ready",
    );
    initialFillPending.initialFillJobs[readyJobIndex] = {
      ...initialFillPending.initialFillJobs[readyJobIndex],
      status: "pending",
      candidate: null,
      failureMessage: null,
      completedAt: null,
    };
    expect(() => parseImportSession(initialFillPending)).toThrow(
      /completed.*initial/i,
    );
  });

  it.each(["annotating", "failed"] as const)(
    "rejects a completed session with an unresolved %s item",
    (status) => {
      const value = completedImportSessionFixture();
      value.items[0] = itemForStatus(status);
      value.servedReceipts = value.servedReceipts.filter(
        (receipt) => receipt.importItemId !== value.items[0].id,
      );

      expect(() => parseImportSession(value)).toThrow();
    },
  );

  it("parses complete annotation-job, initial-fill, and retry evidence", () => {
    const annotationSession = sessionForItemStatus("annotating");
    expect(
      parseImportSession(annotationSession).items[0].annotationJob,
    ).toMatchObject({
      kind: "import-annotation",
      importItemId: annotationSession.items[0].id,
    });

    const fillSession = sessionWithRetryHistory("failed");
    expect(parseImportSession(fillSession).initialFillRetry).toMatchObject({
      replacementAttemptId: "fill-attempt-1",
    });
  });

  it.each([
    ["failed", () => sessionWithRetryHistory("failed")],
    ["superseded", () => sessionWithRetryHistory("superseded")],
  ] as const)(
    "accepts retry history with a %s failed attempt",
    (_status, build) => {
      expect(
        parseImportSession(build()).initialFillRetry?.failedAttemptId,
      ).toBe("fill-attempt-0");
    },
  );

  it.each([
    [
      "a nonexistent failed attempt",
      () => {
        const value = sessionWithRetryHistory("failed");
        value.initialFillRetry = {
          ...value.initialFillRetry!,
          failedAttemptId: "missing-attempt",
        };
        return value;
      },
    ],
    ["a ready-only failed attempt", () => sessionWithRetryHistory("ready")],
    ["a pending-only failed attempt", () => sessionWithRetryHistory("pending")],
  ] as const)("rejects retry history with %s", (_name, build) => {
    expect(() => parseImportSession(build())).toThrow();
  });

  it("rejects annotation work for a different import session", () => {
    const value = session();
    value.items[0] = {
      ...value.items[0],
      status: "annotating",
      annotation: null,
      candidateId: null,
      annotationJob: {
        ...liveAnnotationJob(value.items[0]),
        importSessionId: "different-import-session",
      },
    };
    value.status = "editing";
    value.sealedAt = null;
    value.activatedAt = null;
    value.items = [value.items[0]];
    value.initialFillJobs = [];
    value.initialFillRetry = null;
    value.servedReceipts = [];

    expect(() => parseImportSession(value)).toThrow(/annotation.*session/i);
  });

  it("rejects ready initial-fill jobs without a candidate and completion time", () => {
    const withoutCandidate = session();
    const withoutCandidateIndex = withoutCandidate.initialFillJobs.findIndex(
      (job) => job.status === "ready",
    );
    withoutCandidate.initialFillJobs[withoutCandidateIndex] = {
      ...withoutCandidate.initialFillJobs[withoutCandidateIndex],
      status: "ready",
      candidate: null,
      completedAt: "2026-08-09T20:02:30.000Z",
    };
    expect(() => parseImportSession(withoutCandidate)).toThrow(
      /ready.*candidate/i,
    );

    const withoutCompletion = session();
    const withoutCompletionIndex = withoutCompletion.initialFillJobs.findIndex(
      (job) => job.status === "ready",
    );
    withoutCompletion.initialFillJobs[withoutCompletionIndex] = {
      ...withoutCompletion.initialFillJobs[withoutCompletionIndex],
      status: "ready",
      candidate: candidate("initial-fill-candidate"),
      completedAt: null,
    };
    expect(() => parseImportSession(withoutCompletion)).toThrow(
      /ready.*completion/i,
    );
  });

  it("requires retry replacement jobs to exist in the replacement attempt", () => {
    const missingJob = session();
    missingJob.initialFillRetry = {
      ...missingJob.initialFillRetry!,
      replacementJobIds: ["missing-job"],
    };
    expect(() => parseImportSession(missingJob)).toThrow(/replacement.*job/i);

    const wrongAttempt = session();
    const replacementJobIndex = wrongAttempt.initialFillJobs.findIndex(
      (job) => job.id === wrongAttempt.initialFillRetry!.replacementJobIds[0],
    );
    wrongAttempt.initialFillJobs[replacementJobIndex] = {
      ...wrongAttempt.initialFillJobs[replacementJobIndex],
      attemptId: "different-attempt",
    };
    expect(() => parseImportSession(wrongAttempt)).toThrow(
      /replacement.*attempt/i,
    );
  });

  it("rejects an activation journal embedded in the import aggregate", () => {
    expect(() =>
      parseImportSession({ ...session(), activation: { id: "not-allowed" } }),
    ).toThrow(/unrecognized|activation/i);
  });

  it("accepts activation-display receipts without comparison evidence", () => {
    const value = session();
    const receipt = value.servedReceipts[0];
    expect(receipt.kind).toBe("activation-display");
    expect(parseImportSession(value).servedReceipts[0]).toEqual(receipt);
  });

  it("rejects comparison evidence on activation-display receipts", () => {
    const value = session();
    value.servedReceipts[0] = {
      ...value.servedReceipts[0],
      originalReceipt: dequeueReceipt.originalReceipt,
    } as (typeof value.servedReceipts)[number];

    expect(() => parseImportSession(value)).toThrow(/unrecognized|original/i);
  });

  it("requires comparison evidence on dequeue receipts", () => {
    const value = session();
    const receipt = { ...dequeueReceipt } as Record<string, unknown>;
    delete receipt.originalReceipt;
    value.servedReceipts[1] =
      receipt as unknown as (typeof value.servedReceipts)[number];

    expect(() => parseImportSession(value)).toThrow(/original/i);
  });

  it("rejects duplicate item IDs and nonremoved asset digests", () => {
    const duplicateId = session();
    duplicateId.items[1] = {
      ...duplicateId.items[1],
      id: duplicateId.items[0].id,
    };
    expect(() => parseImportSession(duplicateId)).toThrow(
      /item.*unique|unique.*item/i,
    );

    const duplicateDigest = session();
    duplicateDigest.items[1] = {
      ...duplicateDigest.items[1],
      asset: duplicateDigest.items[0].asset,
    };
    expect(() => parseImportSession(duplicateDigest)).toThrow(/digest/i);
  });

  it("rejects reused served IDs and duplicate served import items across receipt kinds", () => {
    const duplicateReceiptId = session();
    const activationReceipt = duplicateReceiptId.servedReceipts[0];
    if (activationReceipt.kind !== "activation-display") {
      throw new Error("Expected activation-display fixture");
    }
    duplicateReceiptId.servedReceipts[1] = {
      ...dequeueReceipt,
      dequeueOperationId: activationReceipt.activationDisplayReceiptId,
    };
    expect(() => parseImportSession(duplicateReceiptId)).toThrow(
      /receipt.*unique|unique.*receipt/i,
    );

    const duplicateItem = session();
    duplicateItem.servedReceipts[1] = {
      ...dequeueReceipt,
      importItemId: "served-display",
      candidateId: "served-display",
      candidate: candidate("served-display"),
    };
    expect(() => parseImportSession(duplicateItem)).toThrow(
      /served.*item|item.*served/i,
    );
  });

  it("rejects annotations without a style tag", () => {
    const value = session();
    value.items[1] = {
      ...value.items[1],
      annotation: { ...value.items[1].annotation!, style: [] },
    };

    expect(() => parseImportSession(value)).toThrow(/style/i);
  });

  it("derives stable slot-sensitive receipt IDs", () => {
    const left = deriveActivationDisplayReceiptId(
      "activation-intent-1",
      "import-session-1",
      "initial-left",
    );
    const right = deriveActivationDisplayReceiptId(
      "activation-intent-1",
      "import-session-1",
      "initial-right",
    );
    const single = deriveDequeueOperationId(
      "import-session-1",
      "challenger-session-1",
      dequeueReceipt.originalReceipt,
      "single",
    );
    const pair = deriveDequeueOperationId(
      "import-session-1",
      "challenger-session-1",
      dequeueReceipt.originalReceipt,
      "pair-left",
    );

    expect(left).not.toBe(right);
    expect(left).toBe(
      deriveActivationDisplayReceiptId(
        "activation-intent-1",
        "import-session-1",
        "initial-left",
      ),
    );
    expect(single).not.toBe(pair);
    expect(single).toBe(
      deriveDequeueOperationId(
        "import-session-1",
        "challenger-session-1",
        dequeueReceipt.originalReceipt,
        "single",
      ),
    );
  });

  it("canonicalizes an omitted selection kind before deriving dequeue IDs", () => {
    const omittedKind = {
      selectedAt: "2026-08-09T20:02:00.000Z",
      roundNumber: 1,
      winnerSide: "left" as const,
      winnerId: "left",
      loserId: "right",
    };

    expect(
      deriveDequeueOperationId("import-session-1", "", omittedKind, "single"),
    ).toBe(
      deriveDequeueOperationId(
        "import-session-1",
        "",
        { ...omittedKind, kind: "selection" },
        "single",
      ),
    );
  });
});
