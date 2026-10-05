// Meta host — the prep-side effect dispatcher (bands, bonds, items, garrisons / 特质, 机变 cards, globals).
// Placeholder: the full registry and ctx API (docs/META.md of the online remake) is filled in by effects.js.

export class MetaHost {
  constructor(match) {
    this.match = match;
  }
  /** Shop price after onPrice modifiers. */
  price(player, ev) { return Math.max(0, Math.trunc(ev.price)); }
  emit() {}
  gained() {}
  sold() {}
  equipped() {}
  layersAdded() {}
  /** Consume one charge of a built-in effect (升华 / 整备); true when one was used. */
  consumeBuiltin(player, key) {
    const e = player.effects.find((x) => x.key === key && x.counter > 0);
    if (!e) return false;
    e.counter -= 1;
    if (e.counter <= 0) player.effects = player.effects.filter((x) => x !== e);
    player.touch();
    return true;
  }
  roundStart() {}
  prepStart() {}
  prepEnd() {}
  battleStart() {}
  income(player, amount) { return amount; }
  choicePick(player, card) { if (card.kind === 'item') player.gainItem(card.id, { source: 'choice' }); }
}
