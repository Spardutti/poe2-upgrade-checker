# Wraeclast Iron

The design language of PoE2 Upgrade Checker. It takes its mood from Path of Exile 2's dark ARPG world: black and moonlit blue, stone-grey text, carved capitals in parchment gold, cast-iron frames with gold filigree, and blood red for the one thing you came to do. It borrows the mood, not GGG's property: no logos, artwork or fonts from the game, and everything is drawn in CSS.

All of it lives in [`src/ui/style.css`](src/ui/style.css), which the popup, the results window and the app pages share. Use the tokens; don't add new hex values in components.

## Colour

| Token | Value | Use |
|---|---|---|
| `--void` | `#050506` | Page background |
| `--abyss` | `#0a0c10` | Panel fill |
| `--night` | `#13202e` | Moonlit atmosphere, only inside gradients (page tops, sidebar) |
| `--iron` / `--iron-hi` / `--iron-lo` | `#2c3038` / `#474c55` / `#16191e` | Frame lines, button edges / bevel highlight / row rules |
| `--bronze` | `#7a6545` | Inner frame line, nav text, table headers, links |
| `--gold` / `--gold-hi` | `#c9a463` / `#f1e4c2` | Filigree, the selected thing, focus / top of the heading gradient |
| `--stone` | `#b6b6b6` | Body text |
| `--bone` | `#e2e0db` | Values and strong text |
| `--ash` | `#858585` | Secondary text |
| `--blood` (`-hi`, `-lo`) | `#8e1a1a` | The one main action per view |
| `--up` / `--down` / `--warn` | `#6fd16a` / `#e2483c` / `#e0b04e` | Better / worse / careful (colour-blind mode swaps to blue / orange) |
| `--rare` / `--unique` / `--magic` / `--mod` / `--rune` | as in game | Item names and mod lines, so they read the way players expect |

## Type

- **Carved: Cinzel** (bundled, SIL OFL). Headings, item names, verdicts, buttons, navigation, table headers, big numbers. Headings get the parchment-to-gold gradient and a black glow. Cinzel is all capitals, so keep sentences out of it: carve the number, write the words after it in text (`+26.8%` *for your build*).
- **Text: Alegreya Sans** (bundled, SIL OFL). Everything you read: mods, explanations, settings, tables. 14 px base.
- Numbers that line up use `font-variant-numeric: tabular-nums`.

## Shapes

- **Iron frame** on every panel (`.card`, `.card-p`, `.listing`, `.modal-box`): a 1 px iron line, a black line and a faint bronze line inside it, a deep drop shadow, and gold diamonds on the top corners. A cold blue wash fades in at the top of each frame.
- **Square corners everywhere.** No rounded cards, no pills. Small markers are diamonds (the online dot, the diamond-cut divider).
- **Verdicts are seals:** the carved word in an outlined box with a soft glow in its colour (UPGRADE, LOSES RESISTANCE, LOSES DAMAGE, UPGRADE, BUT…). The number sits beside it.
- **Warnings** (lost resistance or damage) are a band with a blood gradient and a red edge; the card around them gets a red inner line.
- **Resistance bars** are engraved gauges with element gradients and a gold notch at the cap.
- **The selected page** in the sidebar has a gold ring around its sigil.

## Buttons

| Kind | Look | Where |
|---|---|---|
| Blood (`.primary`, `.find`) | Red gradient with a gold edge | The one main action of a view: Find upgrades in the popup, Better for my build, Import |
| Gilded (`.primary.gilded`) | Iron with a gold edge and gold text | The main action on each of many repeated items: Travel to hideout / Copy whisper on result cards, Run on saved searches |
| Iron (default) | Dark gradient, iron edge, gold on hover | Everything else |
| Link (`.link`) | Bronze underlined text | Small asides: "on trade site ↗", "why?" |

## Rules

1. The ground is black or cold night blue, never warm brown.
2. Gold is for frames, headings and the selected thing. Text stays stone grey.
3. Blood red marks one action per view.
4. Item names and mods keep the game's colours.
5. Verdicts are words first, numbers second.
6. Text over atmosphere gets the black glow (`--glow`).
7. No GGG logos, art or fonts.
