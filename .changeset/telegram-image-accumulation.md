---
'@hyperwindmill/caretaker-cli': minor
---

Telegram: images are now delivered to agents, and several messages from the same chat become a single reply.

Images (`photo`, and `document` with an `image/*` mime) are downloaded into the session attachment store and ride the turn as attachments, so an agent on an OpenAI-compatible provider can see them. Previously any message without `text` was dropped silently — including a photo with a caption, since Telegram puts that in `caption`.

Messages are accumulated per chat and delivered as one merged turn instead of one agent run per message. An image with no caption waits up to three minutes for a caption, unless the chat flushed recently, in which case it goes out on the next tick because the agent already has the context. Messages arriving while a run is in flight are now held and delivered when it finishes, instead of being answered with a "session already in progress" notice and lost.

Note: `claude-code` and ACP agents receive the merged text but not the images — their runners do not consume prompt attachments yet.
