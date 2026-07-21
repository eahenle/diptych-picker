import type {
  ChallengerPromptInput,
  ChallengerPromptProvider,
  GeneratedImage,
  ImageProvider,
  ProposedChallenger,
} from "./providers";
import sharp from "sharp";

const concepts: ProposedChallenger[] = [
  {
    concept: "Kinetic paper aviary",
    visualPrompt:
      "A kinetic paper aviary suspended in a sunlit concrete library, ivory folded birds driven by delicate brass linkages, crisp architectural photography, one standalone square image",
    styleTags: ["paper craft", "architectural photography", "warm daylight"],
    reasoningSummary:
      "Tests warmth, motion, and handcraft against darker technical imagery.",
  },
  {
    concept: "Subterranean ceramic archive",
    visualPrompt:
      "A subterranean archive of enormous hand-thrown ceramic vessels arranged inside a decommissioned hydroelectric tunnel, mineral stains and cool work lights, one standalone square image",
    styleTags: ["ceramic", "industrial archaeology", "cinematic blue"],
    reasoningSummary:
      "Keeps material precision while changing scale, subject, and medium.",
  },
  {
    concept: "Fox-shaped weather station",
    visualPrompt:
      "A playful fox-shaped autonomous weather station crossing a windswept alpine snowfield, practical fabricated panels and tiny antennae, documentary telephoto photograph, one standalone square image",
    styleTags: ["fabrication", "documentary", "winter"],
    reasoningSummary:
      "Introduces humor and open space without repeating the winner's narrative.",
  },
  {
    concept: "Oxblood botanical blueprint",
    visualPrompt:
      "An impossible carnivorous flower documented as a meticulous cyanotype and copper-foil botanical plate on oxblood paper, museum conservation lighting, one standalone square image",
    styleTags: ["cyanotype", "botanical plate", "copper foil"],
    reasoningSummary:
      "Changes into a graphic archival medium while retaining intricate craft.",
  },
  {
    concept: "Parent-child lunar foundry",
    visualPrompt:
      "A parent and child in compact work suits casting a tiny bronze moon in a backyard foundry at dusk, competent teamwork and quiet wonder, cinematic candid photograph, one standalone square image",
    styleTags: ["human warmth", "fabrication", "cinematic candid"],
    reasoningSummary:
      "Explores warmth and shared competence as a counterpoint to solitary scenes.",
  },
  {
    concept: "Deep-sea glass orchestra",
    visualPrompt:
      "A deep-sea research chamber where robotic arms play an orchestra of resonant glass vessels beside a dark ocean window, precise hard science fiction, one standalone square image",
    styleTags: ["hard science fiction", "glass", "deep sea"],
    reasoningSummary:
      "Combines engineering and music while changing setting, palette, and composition.",
  },
];

export class MockChallengerPromptProvider implements ChallengerPromptProvider {
  async propose(input: ChallengerPromptInput): Promise<ProposedChallenger> {
    const recent = new Set(
      input.recentConcepts.map((concept) => concept.toLowerCase()),
    );
    const start = input.selectionHistory.length % concepts.length;

    for (let offset = 0; offset < concepts.length; offset += 1) {
      const proposal = concepts[(start + offset) % concepts.length];
      if (!recent.has(proposal.concept.toLowerCase()))
        return this.withPreferenceRevision(proposal, input);
    }

    return this.withPreferenceRevision(concepts[start], input);
  }

  private withPreferenceRevision(
    proposal: ProposedChallenger,
    input: ChallengerPromptInput,
  ): ProposedChallenger {
    if (input.preferenceProfile.adaptationMode !== "adaptive") return proposal;
    const leader = input.leaderboardEvidence?.entries.find(
      ({ rank }) => rank === 1,
    );
    const visual = input.leaderboardVisualProfile?.profile;
    const unfettered =
      (input.preferenceProfile.adaptationStrength ?? "guided") === "unfettered";
    const fields = {
      themes: input.preferenceProfile.themes,
      inspiration: input.preferenceProfile.inspiration,
      mediaTypes: input.preferenceProfile.mediaTypes,
      visualStyle: input.preferenceProfile.visualStyle,
      colorPalette: input.preferenceProfile.colorPalette,
      contentLevel: input.preferenceProfile.contentLevel,
      avoid: input.preferenceProfile.avoid,
    };
    return {
      ...proposal,
      preferenceRevision: {
        ...fields,
        themes: unfettered && visual?.themes ? visual.themes : fields.themes,
        inspiration: visual
          ? [fields.inspiration, visual.inspiration].filter(Boolean).join("; ")
          : leader
            ? `Favor transferable qualities from pool leader ${leader.concept} (${leader.wins} wins, ${leader.losses} losses, Elo ${leader.rating}) while continuing to explore distinct compositions.`
            : `Continue exploring distinct ${proposal.styleTags.join(", ")} treatments until the pool establishes a durable leader.`,
        visualStyle: [
          fields.visualStyle,
          ...(visual?.visualStyle
            ? [visual.visualStyle]
            : (leader?.style ?? proposal.styleTags)),
        ]
          .filter(Boolean)
          .join(", "),
        colorPalette: visual
          ? [fields.colorPalette, visual.colorPalette]
              .filter(Boolean)
              .join(", ")
          : fields.colorPalette,
        mediaTypes:
          unfettered && visual?.mediaTypes
            ? visual.mediaTypes
            : fields.mediaTypes,
        contentLevel:
          unfettered && visual?.contentLevel
            ? visual.contentLevel
            : fields.contentLevel,
        avoid:
          unfettered && visual
            ? [fields.avoid, visual.avoid].filter(Boolean).join(", ")
            : fields.avoid,
      },
    };
  }
}

function hash(value: string): number {
  let result = 2166136261;
  for (const character of value) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export class MockImageProvider implements ImageProvider {
  async generate(prompt: string): Promise<GeneratedImage> {
    const seed = hash(prompt);
    const hue = seed % 360;
    const secondHue = (hue + 98 + (seed % 73)) % 360;
    const rotation = seed % 90;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <radialGradient id="ground" cx="32%" cy="24%" r="90%"><stop offset="0" stop-color="hsl(${hue} 42% 34%)"/><stop offset="0.56" stop-color="hsl(${secondHue} 35% 17%)"/><stop offset="1" stop-color="#07070a"/></radialGradient>
  <filter id="grain"><feTurbulence baseFrequency=".72" numOctaves="3" seed="${seed % 99}"/><feColorMatrix values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 .14 0"/></filter>
  <filter id="glow"><feGaussianBlur stdDeviation="16"/></filter>
</defs>
<rect width="1024" height="1024" fill="url(#ground)"/>
<g transform="translate(512 512) rotate(${rotation})" fill="none" stroke-linecap="round">
  <circle r="312" stroke="hsl(${hue} 62% 68%)" stroke-width="3" opacity=".54"/>
  <circle r="228" stroke="hsl(${secondHue} 70% 72%)" stroke-width="18" stroke-dasharray="82 34" opacity=".72"/>
  <path d="M-382 126 C-206 -274 84 -342 376 -92 C132 -38 80 226 -218 352 Z" stroke="#d49a76" stroke-width="9" opacity=".82"/>
  <path d="M-324 -104 Q0 306 348 -156" stroke="#eee8dc" stroke-width="4" opacity=".64"/>
  <circle cx="-176" cy="-114" r="42" fill="#0a090d" stroke="#b36c4b" stroke-width="8"/>
  <circle cx="218" cy="156" r="64" fill="hsl(${secondHue} 48% 48%)" opacity=".78" filter="url(#glow)"/>
</g>
<rect width="1024" height="1024" filter="url(#grain)" opacity=".34"/>
</svg>`;

    const bytes = await sharp(Buffer.from(svg)).png().toBuffer();

    return {
      bytes,
      extension: "png",
      contentType: "image/png",
      width: 1024,
      height: 1024,
    };
  }
}
