## appdash - the Notion project dashboard

This project has a row in a Notion dashboard its owner reads on his phone. It is
the only place he sees where this project stands, so keep it true.

- **This project's row:** https://app.notion.com/p/408ce74fad0a812c905acfe65c9cdea7
- **Projects database:** `collection://3ffce74f-ad0a-8093-9896-000ba724a1fd`
- **Bugs and suggestions:** `collection://29e42e8d-1848-403f-a503-eaea46db52d0`

### At the start of a session

Query the bugs database for rows whose `פרויקט` relation is this project and
whose `סטטוס` is `חדש` or `בטיפול`. Those are things he wrote from his phone.
Raise them if they bear on what you were asked to do. Set one to `בטיפול` when
you pick it up and `טופל` once the fix is pushed.

### When to update the row

Update it when something real changed:

- work finished and pushed, or a PR opened or merged
- you are blocked on something only he can do -> `סטטוס` = `ממתין לך`
- you reached a decision that is his to make -> `סטטוס` = `צריך החלטה שלך`
- the project shipped -> `סטטוס` = `שוחרר`

Do not update it for answering a question, reading code, a change you did not
push, or anything that leaves the project where it already stood. A dashboard
that updates on noise stops being read.

### How to update

One `notion-update-page` call on the row above.

| Field | What goes in it |
|---|---|
| `סטטוס` | בעבודה / ממתין לך / צריך החלטה שלך / מושהה / שוחרר |
| `תקציר` | one line in Hebrew: where the project stands now |
| `מה צריך ממך` | the specific thing you need from him - "a real AdMob app ID", not "configuration". Clear it once unblocked. |
| `החלטה פתוחה` | the question, the options, and your recommendation. Clear it once decided. |
| `הצעד הבא` | what happens the moment he unblocks it |
| `עודכן` | today's date |
| `ענף`, `PR` | the branch, and the PR URL when there is one |

`מה צריך ממך` and `החלטה פתוחה` are the two fields he scans for. If you fill
either one, set `סטטוס` to match: a filled blocker sitting at `בעבודה` reads as
"nothing needed from me" and he will scroll straight past it.

Then append a dated line to the `## יומן` heading on the project page, newest
first, so the row carries its history and not only its current state.

### Finding something out of scope

If you notice something worth fixing that is not what you were asked to do, add
a row to the bugs database instead of widening the task: `סוג` = `באג` or
`הצעה`, `פרויקט` = this project, `פרטים` = what you saw and how to reproduce it.
