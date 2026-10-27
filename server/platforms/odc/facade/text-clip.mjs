// T16 rule 8 (one refusal, every text whole or cut cleanly): a text cut to `max` UTF-16 units with its mark ('…' by default),
// never between the two halves of a character outside the BMP (an emoji, a rare CJK ideograph): a lone surrogate is no
// character and becomes U+FFFD in the UTF-8 of the answer. The one cut of every clip that ends a text with a mark.
//   clipText(text, max, mark = '…') -> the text, or its head plus the mark, at most max units long
const isHighSurrogate = unit => unit >= 0xD800 && unit <= 0xDBFF;

export function clipText(text, max, mark = '…') {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  let end = Math.max(0, max - mark.length);
  if (end > 0 && isHighSurrogate(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(0, end) + mark;
}
