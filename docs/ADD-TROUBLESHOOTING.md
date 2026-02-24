
- Only discord command `/add-guide`
- We need to input the alertName
- Opens a private (with user only) thread. Whatever the user types in that thread is the guide to save
- When user finishes types `/save`
- For exit types `/cancel`
- Each alert by name can have its guide (not by alert type but by name / Alert ID)
- It's markdown (as much as Discord supports)
- We can also upload images and the bot processes the whole thread

## Implementation

- **Command:** `/add-guide` with required option `alert_name` (alert rule name).
- **Flow:** Slash command runs in a text channel (or in a thread’s parent). Bot creates a **private thread**, adds the user, and sends instructions. A message collector in that thread listens for the user’s messages.
- **Actions in thread:** User types guide content (markdown + attachments). **`/save`** — build markdown from all messages (including image URLs), persist via `setTroubleshootingGuide(ruleName, content)`, then end session. **`/cancel`** — end session without saving. Session **times out** after 1 hour of inactivity.
- **Storage:** One guide per **rule name** in `troubleshooting_guides` (same as `POST /troubleshooting-guide`). Requires `DATABASE_URL`.
- **Logs:** `slash_add_guide_ok`, `slash_add_guide_cancelled`, `slash_add_guide_failed`, `slash_add_guide_timeout`, `slash_add_guide_thread_failed`.