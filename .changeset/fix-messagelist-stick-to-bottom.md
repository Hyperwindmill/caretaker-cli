---
"@hyperwindmill/caretaker-cli": patch
---

Fix aggressive auto-scroll in the chat and task message views. Following new content is now gated on a proper stick-to-bottom flag tracked from the scroll position: the view only follows when you are already at the bottom, detaches the instant you scroll up, and re-attaches when you scroll back down (sending your own message always re-pins). Scrolling now targets the message container directly instead of `scrollIntoView`, so it no longer jerks the surrounding task layout.
