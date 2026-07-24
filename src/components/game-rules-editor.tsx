"use client";

import { useState, type FormEvent } from "react";
import { GAME_RULE_BOUNDS, type GameRules } from "@/domain/game";
import styles from "./game-rules-editor.module.css";

interface GameRulesEditorProps {
  rules: GameRules | null;
  busy: boolean;
  error: string | null;
  onSave: (rules: GameRules) => Promise<boolean>;
}

const FIELDS: ReadonlyArray<{
  key: keyof GameRules;
  label: string;
  description: string;
}> = [
  {
    key: "bufferTarget",
    label: "Ready queue target",
    description: "Generated challengers kept ready for instant rounds.",
  },
  {
    key: "poolMaximum",
    label: "Reusable pool capacity",
    description:
      "Highest-rated generated candidates retained for future draws.",
  },
  {
    key: "championRetirementStreak",
    label: "Champion streak limit",
    description: "Consecutive wins before both displayed candidates retire.",
  },
  {
    key: "fallbackMaximumConsecutive",
    label: "Fallback draw limit",
    description:
      "Maximum consecutive reusable-pool draws while generation lags.",
  },
];

function validRules(rules: GameRules): boolean {
  return FIELDS.every(({ key }) => {
    const bounds = GAME_RULE_BOUNDS[key];
    return (
      Number.isInteger(rules[key]) &&
      rules[key] >= bounds.min &&
      rules[key] <= bounds.max
    );
  });
}

export function GameRulesEditor({
  rules,
  busy,
  error,
  onSave,
}: GameRulesEditorProps) {
  const [overrides, setOverrides] = useState<Partial<GameRules>>({});
  const draft = rules ? { ...rules, ...overrides } : null;
  const changed = Boolean(
    rules && draft && FIELDS.some(({ key }) => rules[key] !== draft[key]),
  );

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft && validRules(draft) && (await onSave(draft))) setOverrides({});
  };

  return (
    <details className={styles.editor}>
      <summary>Game rules</summary>
      <form onSubmit={(event) => void submit(event)}>
        <p>
          Changes apply to this game immediately and travel with saved-game
          exports. Starting fresh restores configured defaults.
        </p>
        {draft ? (
          <div className={styles.grid}>
            {FIELDS.map(({ key, label, description }) => {
              const bounds = GAME_RULE_BOUNDS[key];
              const inputId = `game-rule-${key}`;
              return (
                <label key={key} htmlFor={inputId}>
                  <span>{label}</span>
                  <input
                    id={inputId}
                    aria-label={label}
                    type="number"
                    min={bounds.min}
                    max={bounds.max}
                    step="1"
                    value={draft[key]}
                    disabled={busy}
                    onChange={(event) =>
                      setOverrides({
                        ...overrides,
                        [key]: Number(event.target.value),
                      })
                    }
                  />
                  <small>
                    {description} {bounds.min}–{bounds.max}.
                  </small>
                </label>
              );
            })}
          </div>
        ) : (
          <p role="status">Loading current rules…</p>
        )}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={
            busy || !draft || !changed || (draft ? !validRules(draft) : true)
          }
        >
          {busy ? "Applying…" : "Apply rules"}
        </button>
      </form>
    </details>
  );
}
