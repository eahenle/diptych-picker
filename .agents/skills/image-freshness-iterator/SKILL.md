---
name: image-freshness-iterator
description: Use when a user asks to iterate on a source image using a temperature, preserve a subject anchor, or escape recurring visual patterns in Diptych Picker.
---

# Image freshness iterator

Use the [iteration planner](../../../src/domain/image-iteration.ts) to choose a
visual direction relative to an immutable source. Temperature measures the
amount of conceptual and visual change. Keep the saved content ceiling and
provider safety checks in force at every temperature. The Frozen, Guided and
Unfettered preference slider controls profile revision cadence independently.

## Commands

Use `iterate`, `iterate 0.7`, `iterate hot`, or
`iterate 0.8, preserve [red, white, and blue stripes]`. Each additional anchor
starts with another comma and `preserve` clause. Decimal values from 0 to 1
are accepted. The default is `warm`.

| Alias  | Temperature |
| ------ | ----------- |
| frozen | 0.05        |
| cool   | 0.25        |
| warm   | 0.5         |
| hot    | 0.75        |
| wild   | 0.95        |

## Prepare the inputs

1. Inspect the source image or use a trusted manual observation of it. Supply
   `source.origin` as `visual-analysis` or `manual-observation`. Describe
   visible features with short, consistent labels. Omit axes that lack evidence.
2. Specify `subject.mandatoryAnchors` for essential subject continuity,
   `subject.preservedAxes` for locked source features, and `subject.exclusions`
   for prohibited motifs. Command anchors add to the subject anchors. Use
   transferable descriptions and authorized subject details. Keep names,
   likeness instructions, private text, source paths and image bytes out of
   fingerprints.
3. Draft alternatives through concrete edits to observed axes. Use gaze and
   palette for small changes. Consider activity, pose, composition, aesthetic
   and wardrobe logic for scene-level changes. Use setting, viewer relationship,
   role, narrative and tension engine for broader reinterpretations. Name the
   visual source of tension when present. List required anchors and then
   optional lineage anchors in preference order in `retainedAnchors`. Use
   `removedAnchors` for explicit removals. Provide `visualAnchors` for the
   full projected motif list or omit it to carry forward source motifs minus
   explicit removals. Tag any applicable exclusions.
   The trusted caller independently vets safety and content range for each
   proposal. Labels match after case and whitespace normalization, so use
   consistent vocabulary across observations, exclusions and proposals.
4. Supply up to twelve recent selected or rejected outcomes, oldest first.
   Attach fingerprints from actual images when available. Use manual observations
   when automated analysis is unavailable, or omit a missing fingerprint. Supply
   the paired image's observed fingerprint when available.

## Read the plan

The planner chooses one eligible proposal and reports the requested temperature,
mandatory and optional anchors, preserved axes, concrete axis changes, tension
engine, exclusions, projected fingerprint and separate selected and rejected
repetition penalties. The optional preservation budget is eight through 0.2,
five through 0.4, three below 0.5, and two from 0.5 onward. Mandatory anchors
are outside that budget. The projected fingerprint records salient motifs,
including incidental details. Inspect the actual output before recording a
fingerprint as visual history.

On `anchor-conflict`, resolve each listed preserve/exclude collision with the
user before drafting alternatives. On `insufficient-source`, obtain
observations for the source and every locked
axis. On `no-eligible-proposal`, draft alternatives that satisfy the brief and
its safety decisions. On `no-proposal-in-range`, draft alternatives closer to
the source. Retain the original constraints through each retry.

After installing the repository dependencies, run this planning-only example
from the repository root with Node.js 24.

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --input-type=module <<'NODE'
import { planImageIteration } from "./src/domain/image-iteration.ts";

const subject = { mandatoryAnchors: ["wooden handle"], preservedAxes: ["setting"] };
const source = {
  origin: "manual-observation",
  axes: { palette: "warm", composition: "centered", setting: "kitchen" },
};
const proposal = {
  id: "offset",
  changes: { composition: "off center" },
  retainedAnchors: ["wooden handle", "copper kettle"],
  safety: "allowed",
  contentLevel: "family-friendly",
};
const result = planImageIteration({
  command: "iterate cool, preserve [copper kettle]",
  subject,
  source,
  contentLevel: "family-friendly",
  proposals: [proposal],
});

console.log(JSON.stringify(result, null, 2));
NODE
```

The example preserves the kettle and wooden handle and shifts the composition
off center. It returns a plan without starting an image worker.
