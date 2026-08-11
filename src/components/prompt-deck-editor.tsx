"use client";

import { useRef, useState, type FormEvent } from "react";
import type { PromptCard, PromptDeck } from "@/domain/game";
import styles from "./prompt-deck-editor.module.css";

interface PromptDeckEditorProps {
  deck: PromptDeck | undefined;
  busy: boolean;
  error: string | null;
  onCreate: (input: {
    title: string;
    prompt: string;
    negativePrompt: string;
    weight: number;
    tags: string[];
  }) => Promise<boolean>;
  onUpdate: (
    update:
      | { kind: "deck"; enabled: boolean }
      | { kind: "card"; cardId: string; active?: boolean; weight?: number }
      | {
          kind: "suggestion";
          suggestionId: string;
          action: "accept" | "discard";
        },
  ) => Promise<void>;
  onBlend: (cardIds: [string, string]) => Promise<boolean>;
  onWrite: (input: {
    guidance: string;
    images: readonly File[];
  }) => Promise<boolean>;
}

export function PromptDeckEditor({
  deck,
  busy,
  error,
  onCreate,
  onUpdate,
  onBlend,
  onWrite,
}: PromptDeckEditorProps) {
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [tags, setTags] = useState("");
  const [blendSelection, setBlendSelection] = useState<string[]>([]);
  const [writerGuidance, setWriterGuidance] = useState("");
  const [writerImages, setWriterImages] = useState<File[]>([]);
  const writerImageInputRef = useRef<HTMLInputElement | null>(null);
  const cards = deck?.cards ?? [];
  const activeCards = cards.filter((card) => card.active);
  const availableBlendIds = new Set(activeCards.map(({ id }) => id));
  const effectiveBlendSelection = blendSelection.filter((id) =>
    availableBlendIds.has(id),
  );

  const toggleBlendCard = (cardId: string) => {
    setBlendSelection((current) => {
      const available = current.filter((id) => availableBlendIds.has(id));
      if (available.includes(cardId)) {
        return available.filter((id) => id !== cardId);
      }
      return available.length < 2
        ? [...available, cardId]
        : [available[1], cardId];
    });
  };

  const blendSelected = async () => {
    if (effectiveBlendSelection.length !== 2) return;
    const cardIds = effectiveBlendSelection as [string, string];
    if (await onBlend(cardIds)) setBlendSelection([]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const saved = await onCreate({
      title,
      prompt,
      negativePrompt,
      weight: 1,
      tags: tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
        .slice(0, 8),
    });
    if (saved) {
      setTitle("");
      setPrompt("");
      setNegativePrompt("");
      setTags("");
    }
  };

  const submitWriter = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (await onWrite({ guidance: writerGuidance, images: writerImages })) {
      setWriterGuidance("");
      setWriterImages([]);
      if (writerImageInputRef.current) writerImageInputRef.current.value = "";
    }
  };

  return (
    <details className={styles.editor}>
      <summary>
        Prompt deck
        <strong>
          {activeCards.length}/{cards.length}
        </strong>
      </summary>
      <div className={styles.body}>
        <label className={styles.deckToggle}>
          <input
            type="checkbox"
            checked={deck?.enabled ?? false}
            disabled={busy || activeCards.length === 0}
            onChange={(event) =>
              void onUpdate({ kind: "deck", enabled: event.target.checked })
            }
          />
          <span>
            <strong>Use weighted prompt cards</strong>
            <small>
              Future jobs draw one active card; the explicit preference profile
              remains authoritative.
            </small>
          </span>
        </label>

        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}

        {cards.length > 0 ? (
          <ul className={styles.cards}>
            {cards.map((card) => (
              <PromptCardRow
                key={card.id}
                card={card}
                busy={busy}
                blendSelected={effectiveBlendSelection.includes(card.id)}
                blendDisabled={Boolean(deck?.blendJob) || !card.active}
                onToggleBlend={() => toggleBlendCard(card.id)}
                onUpdate={onUpdate}
              />
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>
            Add concise archetype or style cards, then enable weighted draws.
          </p>
        )}

        {cards.length >= 2 ? (
          <div className={styles.blendControls}>
            <span>
              Select two active cards to draft a balanced, reviewable child.
            </span>
            <button
              type="button"
              disabled={
                busy ||
                Boolean(deck?.blendJob) ||
                effectiveBlendSelection.length !== 2
              }
              onClick={() => void blendSelected()}
            >
              Blend selected 50/50
            </button>
          </div>
        ) : null}

        <form
          className={`${styles.form} ${styles.writerForm}`}
          onSubmit={(event) => void submitWriter(event)}
        >
          <strong>Draft a card from sources</strong>
          <small>
            Supply text, up to five private seed images, or both. The writer
            returns one reviewable prompt-deck card and never generates or
            alters an image.
          </small>
          <label>
            Text guidance
            <textarea
              value={writerGuidance}
              maxLength={2_000}
              rows={3}
              disabled={busy || Boolean(deck?.writerJob)}
              onChange={(event) => setWriterGuidance(event.target.value)}
              placeholder="Describe the transferable subject, composition, mood, medium, palette, or constraints to capture"
            />
          </label>
          <label>
            Seed images
            <input
              ref={writerImageInputRef}
              type="file"
              aria-label="Seed images"
              accept="image/png,image/jpeg,image/webp"
              multiple
              disabled={busy || Boolean(deck?.writerJob)}
              onChange={(event) =>
                setWriterImages(Array.from(event.currentTarget.files ?? []))
              }
            />
            <small>
              {writerImages.length > 0
                ? `${writerImages.length} of 5 selected`
                : "PNG, JPEG, or WebP; 20 MB and 4096 px maximum per image."}
            </small>
          </label>
          <button
            type="submit"
            disabled={
              busy ||
              Boolean(deck?.writerJob) ||
              writerImages.length > 5 ||
              (writerImages.length === 0 && writerGuidance.trim().length === 0)
            }
          >
            {deck?.writerJob ? "Writer working…" : "Draft reviewable card"}
          </button>
        </form>

        {deck?.editorJob ? (
          <p className={styles.editorStatus} role="status">
            Editor is drafting two alternatives for{" "}
            <strong>
              {cards.find((card) => card.id === deck.editorJob?.cardId)
                ?.title ?? "a repeatedly rejected card"}
            </strong>
            …
          </p>
        ) : null}

        {deck?.blendJob ? (
          <p className={styles.editorStatus} role="status">
            Blender is drafting a child from{" "}
            <strong>
              {deck.blendJob.cardIds
                .map(
                  (cardId) =>
                    cards.find((card) => card.id === cardId)?.title ??
                    "a selected card",
                )
                .join(" + ")}
            </strong>
            …
          </p>
        ) : null}

        {deck?.writerJob ? (
          <p className={styles.editorStatus} role="status">
            Writer is synthesizing a reviewable card from{" "}
            <strong>
              {writerSourceLabel(
                deck.writerJob.sourceImageDigests?.length ??
                  deck.writerJob.expectedJob.sources.length,
                Boolean(deck.writerJob.sourceTextDigest),
                deck.writerJob.sourceCandidateIds.length,
              )}
            </strong>
            …
          </p>
        ) : null}

        {(deck?.suggestions ?? []).length > 0 ? (
          <section
            className={styles.suggestions}
            aria-label="Prompt card suggestions"
          >
            <strong>Prompt-card suggestions</strong>
            <small>
              Review first. Accepting creates a new immutable card; source cards
              and images stay unchanged.
            </small>
            <ul>
              {(deck?.suggestions ?? []).map((suggestion) => (
                <li key={suggestion.id}>
                  <strong>{suggestion.title}</strong>
                  {suggestion.parentCardIds ? (
                    <small>
                      Blend of{" "}
                      {suggestion.parentCardIds
                        .map(
                          (cardId) =>
                            cards.find((card) => card.id === cardId)?.title ??
                            "source card",
                        )
                        .join(" + ")}
                    </small>
                  ) : suggestion.sourceCandidateIds ||
                    suggestion.sourceImageDigests ||
                    suggestion.sourceTextDigest ? (
                    <small>
                      Written from{" "}
                      {!suggestion.sourceTextDigest &&
                      suggestion.sourceCandidateIds?.length
                        ? `${suggestion.sourceCandidateIds.length} saved generated images`
                        : writerSourceLabel(
                            suggestion.sourceImageDigests?.length ??
                              suggestion.sourceCandidateIds?.length ??
                              0,
                            Boolean(suggestion.sourceTextDigest),
                          )}
                    </small>
                  ) : null}
                  <p>{suggestion.prompt}</p>
                  {suggestion.negativePrompt ? (
                    <small>Avoid: {suggestion.negativePrompt}</small>
                  ) : null}
                  <small>{suggestion.reasoningSummary}</small>
                  <div className={styles.suggestionActions}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onUpdate({
                          kind: "suggestion",
                          suggestionId: suggestion.id,
                          action: "accept",
                        })
                      }
                    >
                      Accept as new card
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void onUpdate({
                          kind: "suggestion",
                          suggestionId: suggestion.id,
                          action: "discard",
                        })
                      }
                    >
                      Discard
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <form className={styles.form} onSubmit={(event) => void submit(event)}>
          <strong>Add immutable card</strong>
          <label>
            Title
            <input
              value={title}
              maxLength={80}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Industrial nocturne"
            />
          </label>
          <label>
            Prompt direction
            <textarea
              value={prompt}
              minLength={20}
              maxLength={1_000}
              rows={3}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="A concise subject, composition, medium, or style direction"
            />
          </label>
          <div className={styles.formPair}>
            <label>
              Avoid for this card
              <input
                value={negativePrompt}
                maxLength={500}
                disabled={busy}
                onChange={(event) => setNegativePrompt(event.target.value)}
                placeholder="Optional card-specific negatives"
              />
            </label>
            <label>
              Tags
              <input
                value={tags}
                disabled={busy}
                onChange={(event) => setTags(event.target.value)}
                placeholder="portrait, copper, nocturne"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={
              busy || title.trim().length === 0 || prompt.trim().length < 20
            }
          >
            {busy ? "Saving…" : "Add card"}
          </button>
        </form>
      </div>
    </details>
  );
}

function writerSourceLabel(
  imageCount: number,
  hasText: boolean,
  candidateCount = 0,
): string {
  if (!hasText && candidateCount > 0) {
    return `${candidateCount} ${candidateCount === 1 ? "favorite" : "favorites"}`;
  }
  const images =
    imageCount > 0
      ? `${imageCount} ${imageCount === 1 ? "image" : "images"}`
      : "";
  if (images && hasText) return `${images} + text guidance`;
  if (images) return images;
  return "text guidance";
}

function PromptCardRow({
  card,
  busy,
  blendSelected,
  blendDisabled,
  onToggleBlend,
  onUpdate,
}: {
  card: PromptCard;
  busy: boolean;
  blendSelected: boolean;
  blendDisabled: boolean;
  onToggleBlend: () => void;
  onUpdate: PromptDeckEditorProps["onUpdate"];
}) {
  const adjustWeight = (factor: number) =>
    onUpdate({
      kind: "card",
      cardId: card.id,
      weight: Math.min(100, Math.max(0.1, card.weight * factor)),
    });

  return (
    <li className={!card.active ? styles.inactive : undefined}>
      <span className={styles.cardHeading}>
        <strong>{card.title}</strong>
        <small>
          {card.stats.wins}W · {card.stats.rejects}R
        </small>
      </span>
      <p>{card.prompt}</p>
      {card.negativePrompt ? <small>Avoid: {card.negativePrompt}</small> : null}
      {card.tags.length > 0 ? (
        <span className={styles.tags}>{card.tags.join(" · ")}</span>
      ) : null}
      <div className={styles.cardActions}>
        <button
          type="button"
          disabled={busy || blendDisabled}
          aria-pressed={blendSelected}
          aria-label={`${blendSelected ? "Remove" : "Select"} ${card.title} ${blendSelected ? "from" : "for"} blend`}
          onClick={onToggleBlend}
        >
          {blendSelected ? "Selected" : "Blend"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void adjustWeight(1 / 1.1)}
          aria-label={`Decrease ${card.title} weight`}
        >
          −
        </button>
        <output aria-label={`${card.title} weight`}>
          {card.weight.toFixed(2)}×
        </output>
        <button
          type="button"
          disabled={busy}
          onClick={() => void adjustWeight(1.1)}
          aria-label={`Increase ${card.title} weight`}
        >
          +
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void onUpdate({
              kind: "card",
              cardId: card.id,
              active: !card.active,
            })
          }
        >
          {card.active ? "Archive" : "Reactivate"}
        </button>
      </div>
    </li>
  );
}
