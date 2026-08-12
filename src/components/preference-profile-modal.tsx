"use client";

import {
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type ComponentProps,
  type FormEvent,
} from "react";
import {
  preferenceAdaptationFreedom,
  preferenceAdaptationProgress,
  type PreferenceProfile,
  type PreferencePreset,
  type PreferenceProfileSnapshot,
  type GameRules,
  type PromptDeck,
  type VariationSource,
} from "@/domain/game";
import { ModalShell } from "./modal-shell";
import { PromptDeckEditor } from "./prompt-deck-editor";
import { GameRulesEditor } from "./game-rules-editor";
import modalStyles from "./game-modal.module.css";
import styles from "./preference-profile-modal.module.css";

export type PreferenceField =
  | "themes"
  | "inspiration"
  | "mediaTypes"
  | "visualStyle"
  | "colorPalette"
  | "contentLevel"
  | "avoid";

const REVISION_FIELDS: ReadonlyArray<
  readonly [keyof PreferenceProfile, string]
> = [
  ["themes", "Themes"],
  ["inspiration", "Inspiration"],
  ["mediaTypes", "Media"],
  ["visualStyle", "Style"],
  ["colorPalette", "Palette"],
  ["contentLevel", "Content range"],
  ["avoid", "Avoid"],
  ["adaptationMode", "Model freedom"],
  ["adaptationStrength", "Model freedom"],
];

function preferenceFieldChanges(
  previous: PreferenceProfile,
  current: PreferenceProfile,
): string[] {
  return [
    ...new Set(
      REVISION_FIELDS.filter(
        ([field]) => previous[field] !== current[field],
      ).map(([, label]) => label),
    ),
  ];
}

function revisionLabel(source: PreferenceProfileSnapshot["source"]): string {
  return {
    initial: "Baseline",
    manual: "Manual save",
    variation: "Variation branch",
    adaptive: "Model adaptation",
  }[source];
}

function formatRevisionTime(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.valueOf())
    ? createdAt
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
}

interface PreferenceProfileModalProps {
  profile: PreferenceProfile;
  historyLength: number;
  saving: boolean;
  saveQueued: boolean;
  saveError: string | null;
  sourceAnalyzing: boolean;
  sourceError: string | null;
  sourceSummary: string | null;
  variationSource: VariationSource | null;
  revisions: readonly PreferenceProfileSnapshot[];
  presets: readonly PreferencePreset[];
  presetSaving: boolean;
  presetError: string | null;
  promptDeck: PromptDeck | undefined;
  promptDeckSaving: boolean;
  promptDeckError: string | null;
  gameRules: GameRules | null;
  gameRulesSaving: boolean;
  gameRulesError: string | null;
  selectionBoundWait: boolean;
  onClose: () => void;
  onSave: () => void;
  onAnalyzeSource: (image: File) => Promise<void>;
  onRestoreRevision: (
    revision: PreferenceProfileSnapshot,
    frozen: boolean,
  ) => void;
  onSavePreset: (name: string) => Promise<boolean>;
  onApplyPreset: (preset: PreferencePreset) => void;
  onDeletePreset: (presetId: string) => Promise<void>;
  onCreatePromptCard: ComponentProps<typeof PromptDeckEditor>["onCreate"];
  onUpdatePromptDeck: ComponentProps<typeof PromptDeckEditor>["onUpdate"];
  onBlendPromptCards: ComponentProps<typeof PromptDeckEditor>["onBlend"];
  onWriteCustomPromptCard: ComponentProps<typeof PromptDeckEditor>["onWrite"];
  onUpdateGameRules: (rules: GameRules) => Promise<boolean>;
  onFieldChange: <Key extends PreferenceField>(
    key: Key,
    value: PreferenceProfile[Key],
  ) => void;
  onFreedomChange: (freedom: "frozen" | "guided" | "unfettered") => void;
}

export function PreferenceProfileModal({
  profile,
  historyLength,
  saving,
  saveQueued,
  saveError,
  sourceAnalyzing,
  sourceError,
  sourceSummary,
  variationSource,
  revisions,
  presets,
  presetSaving,
  presetError,
  promptDeck,
  promptDeckSaving,
  promptDeckError,
  gameRules,
  gameRulesSaving,
  gameRulesError,
  selectionBoundWait,
  onClose,
  onSave,
  onAnalyzeSource,
  onRestoreRevision,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  onCreatePromptCard,
  onUpdatePromptDeck,
  onBlendPromptCards,
  onWriteCustomPromptCard,
  onUpdateGameRules,
  onFieldChange,
  onFreedomChange,
}: PreferenceProfileModalProps) {
  const sourceInputRef = useRef<HTMLInputElement | null>(null);
  const [presetName, setPresetName] = useState("");
  const busy =
    saving ||
    sourceAnalyzing ||
    presetSaving ||
    promptDeckSaving ||
    gameRulesSaving;
  const adaptationFreedom = preferenceAdaptationFreedom(profile);
  const adaptationFreedomValue = {
    frozen: 0,
    guided: 1,
    unfettered: 2,
  }[adaptationFreedom];
  const adaptationProgress = preferenceAdaptationProgress(
    profile,
    historyLength,
  );

  const analyzeSelectedImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const image = input.files?.[0];
    if (!image) return;
    try {
      await onAnalyzeSource(image);
    } finally {
      input.value = "";
    }
  };

  const savePreset = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await onSavePreset(presetName)) setPresetName("");
  };

  return (
    <ModalShell
      className={`${modalStyles.dialog} ${styles.dialog}`}
      onClose={onClose}
      ariaBusy={busy}
      ariaLabelledBy="preferences-title"
      ariaDescribedBy={
        selectionBoundWait
          ? "preferences-description preferences-wait-note"
          : "preferences-description"
      }
      initialFocusSelector="#preference-themes"
    >
      <>
        <div className={styles.titleRow}>
          <h2 id="preferences-title">Preference profile</h2>
          <div className={styles.adaptationFreedom}>
            <label htmlFor="adaptation-freedom">
              Model freedom <strong>{adaptationFreedom}</strong>
            </label>
            <input
              id="adaptation-freedom"
              type="range"
              min="0"
              max="2"
              step="1"
              value={adaptationFreedomValue}
              style={
                {
                  "--adaptation-fill": `${adaptationFreedomValue * 50}%`,
                } as CSSProperties
              }
              disabled={busy}
              aria-label="Model rewrite freedom"
              aria-valuetext={
                adaptationFreedom === "frozen"
                  ? "Frozen"
                  : adaptationFreedom === "guided"
                    ? "Guided, every 15 rounds"
                    : "Unfettered, every 5 rounds"
              }
              onChange={(event) => {
                const freedom = ["frozen", "guided", "unfettered"] as const;
                onFreedomChange(
                  freedom[Number(event.target.value)] ?? "guided",
                );
              }}
            />
            <span className={styles.adaptationFreedomTicks}>
              <small>Frozen</small>
              <small>Guided</small>
              <small>Unfettered</small>
            </span>
          </div>
        </div>
        <p id="preferences-description">
          {adaptationFreedom === "frozen"
            ? "Frozen preserves every field exactly as saved."
            : adaptationFreedom === "guided"
              ? "Guided allows restrained, leaderboard-driven refinements across the profile after every 15 completed rounds."
              : "Unfettered lets the model rewrite every preference field after every 5 completed rounds."}{" "}
          {adaptationFreedom !== "frozen" &&
          profile.adaptationSourceWinnerIds.length +
            profile.adaptationSourceRejectedIds.length >
            0
            ? `Evidence — winners: ${profile.adaptationSourceWinnerIds.length}; rejected: ${profile.adaptationSourceRejectedIds.length}. `
            : null}
          Novelty rules still take priority.
        </p>
        {variationSource ? (
          <p className={styles.variationSource} role="status">
            Exploring variations of <strong>{variationSource.concept}</strong>.
            Saving this draft preserves the source as parent lineage for new
            candidates.
          </p>
        ) : null}
        <PromptDeckEditor
          deck={promptDeck}
          busy={busy}
          error={promptDeckError}
          onCreate={onCreatePromptCard}
          onUpdate={onUpdatePromptDeck}
          onBlend={onBlendPromptCards}
          onWrite={onWriteCustomPromptCard}
        />
        <GameRulesEditor
          rules={gameRules}
          busy={busy}
          error={gameRulesError}
          onSave={onUpdateGameRules}
        />
        <details className={styles.presets}>
          <summary>
            Saved presets <strong>{presets.length}</strong>
          </summary>
          <form onSubmit={(event) => void savePreset(event)}>
            <label htmlFor="preference-preset-name">Preset name</label>
            <div>
              <input
                id="preference-preset-name"
                value={presetName}
                maxLength={50}
                disabled={busy}
                placeholder="e.g. Ultraviolet editorial"
                onChange={(event) => setPresetName(event.target.value)}
              />
              <button
                type="submit"
                disabled={busy || presetName.trim().length === 0}
              >
                {presetSaving ? "Saving…" : "Save current draft"}
              </button>
            </div>
            <small>A matching name replaces that preset.</small>
          </form>
          {presetError ? (
            <p className={styles.presetError} role="alert">
              {presetError}
            </p>
          ) : null}
          {presets.length > 0 ? (
            <ul>
              {[...presets]
                .sort((left, right) =>
                  right.updatedAt.localeCompare(left.updatedAt),
                )
                .map((preset) => (
                  <li key={preset.id}>
                    <span>
                      <strong>{preset.name}</strong>
                      <time dateTime={preset.updatedAt}>
                        {formatRevisionTime(preset.updatedAt)}
                      </time>
                    </span>
                    <div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onApplyPreset(preset)}
                      >
                        Apply to draft
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void onDeletePreset(preset.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
            </ul>
          ) : (
            <p className={styles.presetEmpty}>
              Save the current draft for quick reuse without applying it to the
              game.
            </p>
          )}
        </details>
        {revisions.length > 0 ? (
          <details className={styles.revisionHistory}>
            <summary>
              Revision history <strong>{revisions.length}</strong>
            </summary>
            <ol>
              {revisions.toReversed().map((revision, reverseIndex) => {
                const index = revisions.length - reverseIndex - 1;
                const previous = revisions[index - 1];
                const changedFields = previous
                  ? preferenceFieldChanges(previous.profile, revision.profile)
                  : ["Starting profile"];
                return (
                  <li key={`${revision.createdAt}-${index}`}>
                    <span>
                      <strong>{revisionLabel(revision.source)}</strong>
                      <time dateTime={revision.createdAt}>
                        {formatRevisionTime(revision.createdAt)}
                      </time>
                    </span>
                    {revision.variationSource ? (
                      <small>From {revision.variationSource.concept}</small>
                    ) : null}
                    <small>{changedFields.join(" · ")}</small>
                    <div>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRestoreRevision(revision, false)}
                      >
                        Restore as draft
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => onRestoreRevision(revision, true)}
                      >
                        Restore frozen
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
          </details>
        ) : null}
        {adaptationProgress ? (
          <div
            className={styles.adaptationCadence}
            role="status"
            aria-label="Preference rewrite cadence"
          >
            <span>
              {adaptationProgress.due
                ? "Rewrite checkpoint ready"
                : `Next rewrite checkpoint in ${adaptationProgress.remaining} ${adaptationProgress.remaining === 1 ? "round" : "rounds"}`}
            </span>
            <progress
              aria-label="Rounds toward next preference rewrite"
              max={adaptationProgress.interval}
              value={adaptationProgress.completed}
            />
            <small>
              {adaptationProgress.due
                ? "The next winning generated candidate may update this profile."
                : `${adaptationProgress.completed} of ${adaptationProgress.interval} rounds completed since the last rewrite checkpoint.`}
            </small>
          </div>
        ) : null}
        <div className={styles.sourceImport}>
          <span>
            <strong>Start from an image</strong>
            <small>
              Infer transferable content and style, then review every field
              before saving.
            </small>
          </span>
          <input
            ref={sourceInputRef}
            className={styles.hiddenFileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label="Choose source image"
            disabled={busy}
            onChange={(event) => void analyzeSelectedImage(event)}
          />
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={() => sourceInputRef.current?.click()}
          >
            Analyze image
          </button>
        </div>
        <div className={styles.grid}>
          <div className={styles.fieldWide}>
            <label htmlFor="preference-themes">
              <span>Themes &amp; subjects</span>
            </label>
            <textarea
              id="preference-themes"
              value={profile.themes}
              disabled={busy}
              onChange={(event) => onFieldChange("themes", event.target.value)}
              rows={4}
              minLength={20}
              maxLength={2000}
              placeholder="What worlds, subjects, or ideas should the game explore?"
              aria-describedby="preference-themes-hint"
            />
            <small id="preference-themes-hint">20–2,000 characters.</small>
          </div>
          <div className={styles.fieldWide}>
            <label htmlFor="preference-inspiration">
              <span>Inspiration</span>
            </label>
            <textarea
              id="preference-inspiration"
              value={profile.inspiration}
              disabled={busy}
              onChange={(event) =>
                onFieldChange("inspiration", event.target.value)
              }
              rows={3}
              maxLength={1000}
              placeholder="Optional composition, lighting, mood, or treatment cues"
              aria-describedby="preference-inspiration-hint"
            />
            <small id="preference-inspiration-hint">
              Optional composition, lighting, mood, or treatment cues.
            </small>
          </div>
          <label className={styles.field}>
            <span>Preferred media</span>
            <input
              value={profile.mediaTypes}
              disabled={busy}
              maxLength={500}
              onChange={(event) =>
                onFieldChange("mediaTypes", event.target.value)
              }
              placeholder="Photography, oil paint, linocut…"
            />
          </label>
          <label className={styles.field}>
            <span>Visual style &amp; mood</span>
            <input
              value={profile.visualStyle}
              disabled={busy}
              maxLength={500}
              onChange={(event) =>
                onFieldChange("visualStyle", event.target.value)
              }
              placeholder="Cinematic, eerie, playful…"
            />
          </label>
          <label className={styles.field}>
            <span>Color palette</span>
            <input
              value={profile.colorPalette}
              disabled={busy}
              maxLength={500}
              onChange={(event) =>
                onFieldChange("colorPalette", event.target.value)
              }
              placeholder="Oxblood, copper, ultraviolet…"
            />
          </label>
          <fieldset className={`${styles.field} ${styles.contentField}`}>
            <legend>Content range</legend>
            <div className={styles.contentChoices}>
              <label className={styles.contentChoice}>
                <input
                  type="radio"
                  name="content-range"
                  value="family-friendly"
                  disabled={busy}
                  checked={profile.contentLevel === "family-friendly"}
                  onChange={() =>
                    onFieldChange("contentLevel", "family-friendly")
                  }
                />
                <span>
                  Family-friendly
                  <small>Broadly suitable imagery</small>
                </span>
              </label>
              <label className={styles.contentChoice}>
                <input
                  type="radio"
                  name="content-range"
                  value="adult-allowed"
                  disabled={busy}
                  checked={profile.contentLevel === "adult-allowed"}
                  onChange={() =>
                    onFieldChange("contentLevel", "adult-allowed")
                  }
                />
                <span>
                  Adult themes
                  <small>Mature, never explicit</small>
                </span>
              </label>
            </div>
          </fieldset>
          <label className={styles.fieldWide}>
            <span>Avoid or de-emphasize</span>
            <textarea
              value={profile.avoid}
              disabled={busy}
              maxLength={800}
              onChange={(event) => onFieldChange("avoid", event.target.value)}
              rows={2}
              placeholder="Subjects, clichés, media, or colors you would rather see less often"
            />
          </label>
        </div>
        {sourceAnalyzing ? (
          <div className={styles.saveProgress} role="status" aria-live="polite">
            <span
              className={styles.saveSpinner}
              data-testid="source-profile-spinner"
              aria-hidden="true"
            />
            <span>
              <strong>Analyzing source image</strong>
              <small>
                Extracting transferable themes, composition, style, and palette…
              </small>
            </span>
          </div>
        ) : sourceError ? (
          <p className={styles.sourceError} role="alert">
            {sourceError}
          </p>
        ) : sourceSummary ? (
          <p className={styles.sourceSummary} role="status">
            Profile populated for review. {sourceSummary}
          </p>
        ) : null}
        {saveError ? (
          <p className={styles.sourceError} role="alert">
            {saveError}
          </p>
        ) : null}
        {saving ? (
          <div
            id={selectionBoundWait ? "preferences-wait-note" : undefined}
            className={styles.saveProgress}
            role="status"
            aria-live="polite"
          >
            <span
              className={styles.saveSpinner}
              data-testid="preference-save-spinner"
              aria-hidden="true"
            />
            <span>
              <strong>
                {saveQueued && selectionBoundWait
                  ? "Profile queued"
                  : "Saving profile"}
              </strong>
              <small>
                {saveQueued && selectionBoundWait
                  ? "Waiting for the challenger to arrive…"
                  : "Applying your preferences…"}
              </small>
            </span>
          </div>
        ) : selectionBoundWait ? (
          <p id="preferences-wait-note" className={styles.notice} role="status">
            Save now to apply these changes when the challenger arrives.
          </p>
        ) : null}
        <div className={modalStyles.actions}>
          <button
            type="button"
            className={modalStyles.actionButton}
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`${modalStyles.actionButton} ${styles.primaryAction}`}
            disabled={busy || profile.themes.trim().length < 20}
            onClick={onSave}
          >
            {saving
              ? saveQueued && selectionBoundWait
                ? "Waiting…"
                : "Saving…"
              : "Save profile"}
          </button>
        </div>
      </>
    </ModalShell>
  );
}
