// Shared between the watch overlay's swipe-to-minimize gesture and the player's tap handling.
let suppress = false;
export function suppressNextTap() { suppress = true; setTimeout(() => (suppress = false), 400); }
export function consumeSuppressedTap() { const s = suppress; suppress = false; return s; }
