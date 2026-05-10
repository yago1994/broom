# Planting Feature Spec

## Feature summary

The planting feature turns emptied web page areas into small decorative “garden” moments.

When a user sweeps away an unwanted page element with the broom, the extension can remember that cleared area as an **empty slot**. When the user hovers over that empty slot in edit mode, the cursor changes into a shovel. Clicking the slot plants a randomized decorative plant, such as a pothos, bird of paradise, fern, monstera, snake plant, or succulent.

The intent is not to add a complex decoration editor. The intent is to create a fast, delightful reward for cleaning up a webpage.

Core interaction:

```text
Broom something away → empty slot appears → hover shows shovel → click → random plant appears
```

The plant is selected through curated randomness, animated gently, persisted per hostname, and rendered using a fixed safe component catalog.

---

## Product framing

The feature should feel like:

```text
Turn annoying web clutter into a tiny garden.
```

It should not feel like:

```text
Configure decorative HTML to inject into a website.
```

The user should feel that every cleanup action creates the possibility of a small surprise. The feature should be playful, but not noisy. It should add emotional texture to the extension without slowing down the core task of modifying a page.

---

## Design principle: juice with restraint

This feature follows the idea of “juice”: small, satisfying, non-essential feedback that makes an interface feel alive and responsive.

In this feature, juice appears in the moment of interaction:

- Hovering an emptied area reveals that it is plantable.
- The cursor changes to a shovel.
- The empty slot softly highlights.
- Clicking plants something instantly.
- The plant pops in with a short growth animation.
- The plant settles into a slow, subtle sway.

The feature should avoid excessive or distracting juice:

- No constant sparkles.
- No frequent idle particles.
- No long animations that delay the task.
- No configuration-heavy plant picker in the default flow.
- Respect `prefers-reduced-motion`.

The interaction should prioritize:

```text
Minimum input → maximum delightful output
```

---

## UX flow

### Default flow

1. User enters edit mode.
2. User uses the broom to remove an element.
3. The extension creates an `EmptySlot` for the removed space.
4. In edit mode, the empty slot is hoverable.
5. On hover:
   - The cursor becomes a shovel.
   - The slot gets a soft green outline or tint.
   - A small label may appear: `Plant here`.
6. On click:
   - The extension chooses a random plant from a curated set.
   - The plant appears with a short pop/grow animation.
   - The plant begins a subtle idle sway.
   - The plant is persisted as a `decorate` rule.
7. A small temporary toast appears:

```text
🌱 Pothos planted
Shuffle · Remove
```

### Secondary controls

The default interaction should not require a plant picker.

After planting, the user may briefly see lightweight controls:

- **Shuffle**: replace the plant with another random plant suitable for the slot.
- **Remove**: remove the plant and return the slot to empty.

This gives the user agency without slowing the initial interaction.

### Future optional flow

Later versions may support natural language:

```text
“Put something tropical here” → bird of paradise
“Put something viney here” → pothos
“Put something minimal here” → snake plant
```

The model should only map language to known safe plant options. It should never generate raw HTML, CSS, SVG, or JavaScript.

---

## Architecture fit

The planting feature should extend the existing architecture without violating the separation of responsibilities.

### Content script

Owns:

- Empty slot rendering.
- Hover affordances.
- Shovel cursor.
- Plant rendering.
- Plant animation.
- Replay of persisted plant rules.
- MutationObserver-based re-application.

Does not own:

- LLM API keys.
- Network calls.
- Arbitrary model execution.

### Background service worker

Owns:

- Optional future LLM interpretation of natural language plant requests.
- Storage brokering.
- Healing support if selectors break.

Does not own:

- DOM rendering.
- Animation.
- Page interaction.

### Storage

Stores:

- Rules per hostname.
- Empty slots per hostname.
- Decorate rules for planted items.

---

## Storage shape

The original storage shape is:

```ts
{ [hostname: string]: Rule[] }
```

For planting, use a host-level object:

```ts
type HostStorage = {
  rules: Rule[];
  emptySlots: EmptySlot[];
};

type StorageShape = {
  [hostname: string]: HostStorage;
};
```

This lets the extension track empty spaces separately from active rules.

---

## Data model

### Rule union

```ts
type Rule =
  | HideRule
  | RestyleRule
  | InjectRule
  | ReplaceRule
  | DecorateRule;
```

### Empty slot

An `EmptySlot` represents a space created by brooming/removing something.

```ts
type EmptySlot = {
  id: string;
  hostname: string;
  sourceRuleId: string;
  selector: SelectorInfo;
  originalBox: {
    width: number;
    height: number;
  };
  state: "empty" | "planted";
  createdAt: number;
};
```

### Selector info

```ts
type SelectorInfo = {
  primary: string;
  fallbacks: string[];
  semantic: string;
};
```

### Decorate rule

```ts
type DecorateRule = {
  id: string;
  hostname: string;
  type: "decorate";
  selector: SelectorInfo;
  payload: DecoratePayload;
  createdAt: number;
  lastAppliedAt: number | null;
  lastFailedAt: number | null;
  failCount: number;
};
```

### Decorate payload

```ts
type DecoratePayload = {
  decoration: "plant";
  slotId: string;
  plant: PlantProps;
  generatedBy: "random" | "user-selected" | "llm-mapped";
};
```

### Plant props

```ts
type PlantProps = {
  kind: PlantKind;
  size: "sm" | "md" | "lg";
  pot: "terracotta" | "ceramic" | "none";
  animation: "gentle-sway" | "breathing" | "leaf-wiggle" | "none";
};

type PlantKind =
  | "pothos"
  | "bird-of-paradise"
  | "snake-plant"
  | "monstera"
  | "fern"
  | "succulent";
```

---

## Randomization strategy

The plant should be randomized once at planting time, then persisted.

Do not re-randomize on every page load. Re-randomizing on every visit would make the page feel unstable rather than delightful.

Use curated randomness based on the slot’s dimensions.

```ts
function chooseRandomPlant(slot: EmptySlot): PlantProps {
  const { width, height } = slot.originalBox;

  const smallPlants: PlantKind[] = [
    "succulent",
    "fern",
    "snake-plant"
  ];

  const mediumPlants: PlantKind[] = [
    "pothos",
    "fern",
    "snake-plant",
    "monstera"
  ];

  const largePlants: PlantKind[] = [
    "bird-of-paradise",
    "monstera",
    "pothos"
  ];

  const pool =
    height < 90 ? smallPlants :
    height > 180 ? largePlants :
    mediumPlants;

  return {
    kind: randomFrom(pool),
    size: height > 180 ? "lg" : height > 90 ? "md" : "sm",
    animation: "gentle-sway",
    pot: randomFrom(["terracotta", "ceramic", "none"])
  };
}
```

Randomness should feel surprising but appropriate. A giant bird of paradise should not appear in a tiny inline gap.

---

## Rendering approach

Plants should be rendered through a fixed safe component catalog.

Do not allow arbitrary HTML, CSS, JavaScript, or model-generated SVG.

### Plant renderer

```ts
function renderPlant(props: PlantProps): HTMLElement {
  const wrapper = document.createElement("div");

  wrapper.className = [
    "a2ui-plant",
    `a2ui-plant-${props.kind}`,
    `a2ui-plant-${props.size}`,
    `a2ui-plant-pot-${props.pot}`,
    `a2ui-plant-${props.animation}`
  ].join(" ");

  wrapper.setAttribute("aria-hidden", "true");
  wrapper.innerHTML = getTrustedPlantSvg(props.kind, props.pot);

  return wrapper;
}
```

### Trusted plant assets

```ts
function getTrustedPlantSvg(kind: PlantKind, pot: PlantProps["pot"]): string {
  switch (kind) {
    case "pothos":
      return POTHOS_SVG;
    case "bird-of-paradise":
      return BIRD_OF_PARADISE_SVG;
    case "snake-plant":
      return SNAKE_PLANT_SVG;
    case "monstera":
      return MONSTERA_SVG;
    case "fern":
      return FERN_SVG;
    case "succulent":
      return SUCCULENT_SVG;
    default:
      return POTHOS_SVG;
  }
}
```

All plant SVGs should be bundled with the extension.

---

## Shovel cursor

When edit mode is active, empty slots should expose a hoverable hit area.

```html
<div class="a2ui-empty-slot" data-a2ui-slot-id="slot_123">
  <div class="a2ui-empty-slot-label">Plant here</div>
</div>
```

### CSS

```css
.a2ui-empty-slot {
  cursor: url("chrome-extension://__MSG_@@extension_id__/assets/shovel-cursor.svg") 6 26, pointer;
  outline: 1px dashed transparent;
  background: transparent;
  transition:
    background 140ms ease,
    outline-color 140ms ease,
    transform 140ms ease;
}

.a2ui-empty-slot:hover {
  outline-color: rgba(80, 160, 100, 0.65);
  background: rgba(80, 160, 100, 0.07);
}

.a2ui-empty-slot-label {
  opacity: 0;
  transform: translateY(4px);
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}

.a2ui-empty-slot:hover .a2ui-empty-slot-label {
  opacity: 1;
  transform: translateY(0);
}
```

The shovel cursor asset must be exposed in `web_accessible_resources`.

```json
{
  "web_accessible_resources": [
    {
      "resources": [
        "assets/shovel-cursor.svg",
        "assets/plants/*.svg"
      ],
      "matches": ["<all_urls>"]
    }
  ]
}
```

Because custom cursors may be missed by some users, the hover label should remain as a backup affordance.

---

## Animation scope

### Planting animation

The plant should appear with a quick grow/pop animation.

```css
.a2ui-plant-enter {
  animation:
    a2uiPlantPopIn 420ms cubic-bezier(.2, 1.4, .4, 1),
    a2uiPlantIdleSway 5.5s ease-in-out infinite 420ms;
}

@keyframes a2uiPlantPopIn {
  0% {
    opacity: 0;
    transform: scale(0.82) translateY(8px) rotate(-2deg);
  }
  70% {
    opacity: 1;
    transform: scale(1.04) translateY(-2px) rotate(1deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0) rotate(0deg);
  }
}
```

### Idle sway

```css
.a2ui-plant {
  pointer-events: none;
  display: inline-flex;
  justify-content: center;
  align-items: end;
  transform-origin: bottom center;
  user-select: none;
  contain: layout style paint;
}

.a2ui-plant-gentle-sway {
  animation: a2uiPlantIdleSway 5.5s ease-in-out infinite;
}

@keyframes a2uiPlantIdleSway {
  0% {
    transform: rotate(-1.2deg);
  }
  50% {
    transform: rotate(1.2deg);
  }
  100% {
    transform: rotate(-1.2deg);
  }
}
```

### Size classes

```css
.a2ui-plant-sm {
  width: 72px;
  min-height: 72px;
}

.a2ui-plant-md {
  width: 120px;
  min-height: 120px;
}

.a2ui-plant-lg {
  width: 180px;
  min-height: 180px;
}
```

### Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  .a2ui-plant,
  .a2ui-plant-enter,
  .a2ui-plant-gentle-sway {
    animation: none !important;
  }
}
```

---

## Applying a plant rule

```ts
function onEmptySlotClick(slot: EmptySlot) {
  const plant = chooseRandomPlant(slot);

  const rule: DecorateRule = {
    id: crypto.randomUUID(),
    hostname: window.location.hostname,
    type: "decorate",
    selector: slot.selector,
    payload: {
      decoration: "plant",
      slotId: slot.id,
      plant,
      generatedBy: "random"
    },
    createdAt: Date.now(),
    lastAppliedAt: null,
    lastFailedAt: null,
    failCount: 0
  };

  applyDecorateRule(rule, { enterAnimation: true });
  persistRule(rule);
  markSlotAsPlanted(slot.id);
  showPlantToast(rule);
}
```

---

## Replaying plant rules

On page load:

```ts
function replayHostPersonalization(hostState: HostStorage) {
  applyHideAndRestyleRules(hostState.rules);
  waitForAnchorsThenApplyInjectReplaceAndDecorate(hostState.rules);

  if (isEditMode()) {
    renderEmptySlotAffordances(hostState.emptySlots);
  }
}
```

For planted rules:

```ts
function applyDecorateRule(rule: DecorateRule, options?: { enterAnimation?: boolean }) {
  const anchor = resolveSelector(rule.selector);
  if (!anchor) return markRuleFailed(rule.id);

  const existing = document.querySelector(`[data-a2ui-rule-id="${rule.id}"]`);
  if (existing) return;

  const slot = document.createElement("div");
  slot.className = "a2ui-plant-slot";
  slot.dataset.a2uiRuleId = rule.id;

  const plant = renderPlant(rule.payload.plant);

  if (options?.enterAnimation) {
    plant.classList.add("a2ui-plant-enter");
  }

  slot.appendChild(plant);
  anchor.insertAdjacentElement("afterend", slot);

  markRuleApplied(rule.id);
}
```

---

## Empty slot rendering

Empty slots should only be visible in edit mode. Planted decorations should be visible during normal browsing.

```ts
function renderEmptySlotAffordances(slots: EmptySlot[]) {
  for (const slot of slots) {
    if (slot.state !== "empty") continue;

    const anchor = resolveSelector(slot.selector);
    if (!anchor) continue;

    const existing = document.querySelector(`[data-a2ui-slot-id="${slot.id}"]`);
    if (existing) continue;

    const slotEl = document.createElement("div");
    slotEl.className = "a2ui-empty-slot";
    slotEl.dataset.a2uiSlotId = slot.id;

    const label = document.createElement("div");
    label.className = "a2ui-empty-slot-label";
    label.textContent = "Plant here";

    slotEl.appendChild(label);

    slotEl.addEventListener("click", () => {
      onEmptySlotClick(slot);
    });

    anchor.insertAdjacentElement("afterend", slotEl);
  }
}
```

---

## Shuffle behavior

Shuffle should replace the current plant with another valid random plant and update the persisted rule.

```ts
function shufflePlant(rule: DecorateRule, slot: EmptySlot) {
  const nextPlant = chooseRandomPlant(slot);

  const updatedRule: DecorateRule = {
    ...rule,
    payload: {
      ...rule.payload,
      plant: nextPlant,
      generatedBy: "random"
    }
  };

  removeRenderedRule(rule.id);
  applyDecorateRule(updatedRule, { enterAnimation: true });
  persistRule(updatedRule);
}
```

---

## Remove behavior

Remove should delete the decoration rule and mark the slot as empty again.

```ts
function removePlant(rule: DecorateRule) {
  removeRenderedRule(rule.id);
  deleteRule(rule.id);
  markSlotAsEmpty(rule.payload.slotId);
}
```

---

## LLM role

The LLM should not be involved in the default planting flow.

Default planting is deterministic and local:

```text
slot dimensions → curated random plant → safe renderer → persisted decorate rule
```

Future LLM usage may support language mapping:

```text
“something tropical” → bird-of-paradise
“something viney” → pothos
“something small” → succulent
```

Allowed LLM output:

```json
{
  "kind": "bird-of-paradise",
  "size": "md",
  "animation": "gentle-sway",
  "pot": "terracotta"
}
```

Disallowed LLM output:

- Raw HTML.
- Raw CSS.
- SVG strings.
- JavaScript.
- Animation keyframes.
- External asset URLs.

All LLM outputs must be validated against the plant schema before use.

---

## Safety and security

Non-negotiables:

- Plant SVGs are bundled extension assets.
- No arbitrary HTML from the model.
- No arbitrary CSS from the model.
- No scripts.
- No external plant assets loaded from remote URLs.
- Content script never receives API keys.
- Decoration schema is validated before rendering.
- Cursor and plant assets are exposed only through `web_accessible_resources`.

---

## Accessibility

Plants are decorative and should not clutter the accessibility tree.

```ts
plantElement.setAttribute("aria-hidden", "true");
```

The empty slot affordance should be keyboard-accessible in edit mode if possible:

```html
<button class="a2ui-empty-slot" aria-label="Plant something here">
  <span class="a2ui-empty-slot-label">Plant here</span>
</button>
```

If using a `div`, add:

```ts
slotEl.tabIndex = 0;
slotEl.setAttribute("role", "button");
slotEl.setAttribute("aria-label", "Plant something here");
```

Keyboard behavior:

- `Enter`: plant random item.
- `Space`: plant random item.
- `Escape`: leave slot unchanged.

---

## Build order

Recommended implementation sequence:

```text
1. Add preserve-space broom/hide mode.
2. Add EmptySlot data model and storage migration.
3. Create empty slots when user brooms an element.
4. Render empty-slot affordances only in edit mode.
5. Add shovel cursor and hover highlight.
6. Add bundled plant SVG catalog.
7. Add Plant renderer.
8. Add curated random plant selection based on slot dimensions.
9. On empty-slot click, create and persist a decorate rule.
10. Replay decorate rules on page load.
11. Add plant pop-in and gentle sway animation.
12. Add temporary toast with Shuffle and Remove.
13. Add popup controls for planted decorations.
14. Add selector healing support for decorate rules.
15. Later: add natural-language plant mapping through the LLM.
```

---

## MVP definition

The MVP is complete when:

```text
- User can broom an element.
- The removed area becomes a remembered empty slot.
- In edit mode, hovering the empty slot shows a shovel cursor and visual affordance.
- Clicking the empty slot plants a random appropriate plant.
- The plant has a short entrance animation.
- The plant gently sways while idle.
- The planted rule persists per hostname.
- The plant reappears on page reload.
- The user can remove or shuffle the plant.
- Motion respects prefers-reduced-motion.
```

---

## Future ideas

Potential later additions:

- Seasonal plant variants.
- Rare random “special” plants.
- Tiny watering interaction.
- Plant growth over time.
- Named gardens per website.
- Export/import gardens.
- Shareable rule packs.
- “Clean this whole site and grow a garden” mode.
- Natural-language decoration prompts.

These should be deferred until the core extension is useful and stable.

---

## Recommendation

Implement planting as a low-friction decorative layer:

```text
One click, randomized, safe, persistent, gently animated.
```

Avoid upfront customization. Let randomness create delight. Offer lightweight correction after the fact through Shuffle and Remove.

The feature should make the user feel that cleaning the web produces a small living reward.
