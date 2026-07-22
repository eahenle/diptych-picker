import type { GameState } from "@/domain/game";

export function preloadImage(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new window.Image();
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      image.src = "";
      cleanup();
      reject(new DOMException("Image preload was cancelled", "AbortError"));
    };
    image.onload = () => {
      cleanup();
      resolve();
    };
    image.onerror = () => {
      cleanup();
      reject(new Error("The new image could not be loaded"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = url;
  });
}

export async function preloadChangedAssets(
  current: GameState,
  next: GameState,
  signal: AbortSignal,
): Promise<void> {
  const currentCandidates = [
    current.round.leftCandidate,
    current.round.rightCandidate,
  ];
  const nextCandidates = [next.round.leftCandidate, next.round.rightCandidate];
  await Promise.all(
    nextCandidates.map((candidate, index) => {
      const previous = currentCandidates[index];
      return previous.id === candidate.id &&
        previous.imageUrl === candidate.imageUrl
        ? Promise.resolve()
        : preloadImage(candidate.imageUrl, signal);
    }),
  );
}
