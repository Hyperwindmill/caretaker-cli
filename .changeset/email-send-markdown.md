---
'@hyperwindmill/caretaker-cli': minor
---

feat(cli): `email_send` renders a markdown `body` into the HTML part

`markdown: true` converts `body` host-side (marked, GFM, one inline-styled
wrapper div) and sends it alongside the markdown itself as the text part, so a
formatted mail costs one copy of the content instead of two. Mutually exclusive
with an explicit `html` — both set the same message part.
