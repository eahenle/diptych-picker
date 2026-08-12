export interface ImportProgress {
  status: "editing" | "preparing" | "active" | "completed";
  annotating: number;
  ready: number;
  failed: number;
  unserved: number;
  activationDisplayServed: number;
  dequeueServed: number;
  initialFillPending: number;
  initialFillFailed: number;
  initialFillAttemptId: string | null;
  initialFillFailureMessage: string | null;
  activationTarget: 5;
}
