---
"@hyperwindmill/caretaker-cli": patch
---

The task reviewer now reads the messages the task owner wrote in the task thread and follows them (for example "do not run the full test suite"). A review cut short by its time budget no longer counts as a "changes requested" round: the task is blocked with the reason instead, and no round is used up.
