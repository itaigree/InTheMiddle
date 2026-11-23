## appdash - the project dashboard

This project has a row on a dashboard in Claude that its owner reads on his
phone. It is the only place he sees where this project stands, so keep it true.

- **Dashboard:** https://claude.ai/artifact/UNhyWDYdSbjRedoX9eyYc6
- **This project's key:** `InTheMiddle`

Everything below goes through the `ArtifactData` tool with
`url` = the dashboard link above. If it is not in your tool list, load it with
`ToolSearch` (`select:ArtifactData`). It is allowed in `.claude/settings.json`,
so it runs without a permission prompt. Every write to a document that already
exists needs `if_version` = the `version` you last read it at.

### At the start of a session

`query` the collection `data/board/bugs` with
`where: [["project", "==", "InTheMiddle"], ["status", "in", ["חדש", "בטיפול"]]]`.
Those are things he wrote from his phone. Raise them if they bear on what you
were asked to do. Set one's `status` to `בטיפול` when you pick it up and `טופל`
once the fix is pushed, adding a dated line to its `details` saying what fixed it.

### When to update the row

Update it when something real changed:

- work finished and pushed, or a PR opened or merged
- you are blocked on something only he can do -> `status` = `ממתין לך`
- you reached a decision that is his to make -> `status` = `צריך החלטה שלך`
- the project shipped -> `status` = `שוחרר`

Do not update it for answering a question, reading code, a change you did not
push, or anything that leaves the project where it already stood. A dashboard
that updates on noise stops being read.

### How to update

First `get` the row: collection `data/board/projects`, doc_id `InTheMiddle`.
Then one `batch` call with both writes, so it is one step:

1. `update` on `data/board/projects` / `InTheMiddle` with `if_version` and the
   fields that changed:

| Field | What goes in it |
|---|---|
| `status` | בעבודה / ממתין לך / צריך החלטה שלך / מושהה / שוחרר |
| `summary` | one line in Hebrew: where the project stands now |
| `needs_you` | the specific thing you need from him - "a real AdMob app ID", not "configuration". Set to `""` once unblocked. |
| `decision` | the question, the options, and your recommendation. Set to `""` once decided. |
| `next_step` | what happens the moment he unblocks it |
| `updated` | today's date, `YYYY-MM-DD` |
| `branch`, `pr` | the branch, and the PR URL when there is one (`""` when there is none) |

2. `set` a new log entry on `data/board/log`, doc_id
   `InTheMiddle-<YYYYMMDD>-<HHMMSS>` (today, the current UTC time), data
   `{"project": "InTheMiddle", "date": "YYYY-MM-DD", "seq": <HHMMSS as a number>, "text": "<one or two sentences in Hebrew: what changed>"}`.
   The dashboard shows these newest first, so the row carries its history and
   not only its current state.

`needs_you` and `decision` are the two fields he scans for. If you fill either
one, set `status` to match: a filled blocker sitting at `בעבודה` reads as
"nothing needed from me" and he will scroll straight past it.

All text is plain: no Markdown. Write a link as the bare `https://` URL and the
dashboard turns it into a link.

### Finding something out of scope

If you notice something worth fixing that is not what you were asked to do, add
a bug instead of widening the task: `set` on `data/board/bugs`, doc_id
`InTheMiddle-<YYYYMMDDHHMMSS>`, data
`{"project": "InTheMiddle", "kind": "באג" or "הצעה", "status": "חדש", "priority": "", "title": "<one line>", "details": "<what you saw and how to reproduce it>", "created": "<ISO 8601 UTC>"}`.
