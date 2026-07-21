"use client";

import { useEffect } from "react";

type GameplaySide = "left" | "right";

interface GameplayShortcutOptions {
  suspended: boolean;
  onSelect: (side: GameplaySide) => void;
  onTie: () => void;
  onBothLose: () => void;
}

type GameplayCommand = GameplaySide | "tie" | "both-lose";

const COMMAND_BY_KEY: Readonly<Record<string, GameplayCommand>> = {
  "1": "left",
  a: "left",
  "2": "right",
  b: "right",
  "3": "tie",
  c: "tie",
  "4": "both-lose",
  d: "both-lose",
};

function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        "textarea, input, select, [contenteditable]:not([contenteditable='false'])",
      ),
    )
  );
}

export function useGameplayShortcuts({
  suspended,
  onSelect,
  onTie,
  onBothLose,
}: GameplayShortcutOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        suspended ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.repeat ||
        event.isComposing ||
        isEditableTarget(event.target)
      ) {
        return;
      }

      const command = COMMAND_BY_KEY[event.key.toLowerCase()];
      if (command === "left" || command === "right") onSelect(command);
      else if (command === "tie") onTie();
      else if (command === "both-lose") onBothLose();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBothLose, onSelect, onTie, suspended]);
}
