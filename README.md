# pi-delegates

Delegate work to fresh Pi sessions. Each delegate starts with its own brief, not the parent's conversation. Delegates can start their own children, ask their parent for guidance, and resume from a saved conversation.

**No built-in sandboxing or worktree management.** A delegate is a separate process running with your OS permissions. It starts in its parent's working directory unless you pass `cwd`. You can point it at a worktree you created yourself, but changing `cwd` or filtering tools is not a security boundary.

## Install

```sh
pi install git:github.com/OscarCookeAbbott/pi-delegates@v0.4.0
```

Requires Pi 1.5.2+ and Node 22.19+. To try a local checkout, run `pi -e ./src/index.ts`.

## Use

Ask Pi to delegate a task. The live tree shows activity and context usage; `/delegates` opens history, details, and controls. Use exact, case-sensitive two-character IDs. Select a delegate, then **Open conversation** to follow its recent saved messages with Pi’s native Markdown and tool rendering. The view shows its place in the delegate tree without switching your Pi session. Press `S` to steer, reply, or resume, use Pi’s tool expansion shortcut for details, and press `Esc` to go back. The view updates as entries are saved, not token by token; press `R` to refresh manually. In fullscreen mode, click a widget row for a short context preview.

- **Model and thinking:** `start` inherits the direct parent's model and thinking level; `resume` keeps the delegate's saved settings. Both accept `model` and `thinking` overrides. Pi clamps thinking to what the model supports.
- **Tools:** Delegates inherit their parent's enabled work tools. Pi loads extensions through normal discovery plus the parent's explicit CLI extensions. If an inherited tool is missing, the run fails before work starts. `allowTools` and `denyTools` can narrow the inherited set in `delegates` settings or on `start`. Both default to empty; deny wins.
- **Progress:** `request_update {id}` asks a running delegate for a report at its next turn boundary. Delegates use `update {message}` to report progress without pausing. `info {id}` shows the latest report without sending a message.
- **Steering and resume:** `steer` queues guidance at a turn boundary or replies to a paused delegate. A delegate that calls `request_steer` saves its question and stops. If a model or tool call stalls, use `interrupt {id}` and then `resume`; `cancel` permanently ends the run and its descendants. Quitting or switching the root session stops live delegates; reopen that session to resume manually. Transcripts are saved locally and cannot resume an in-flight command.

Default limits per root session: depth **3**, concurrent delegates **4**, total starts **64** (`maxDepth`, `maxConcurrent`, `maxLaunches` under `delegates` settings).

## Optional integrations

- [pi-tasks](https://github.com/OscarCookeAbbott/pi-tasks/commit/69a429a) (`69a429a` or later): `tasks` and `task_notes` default to the delegate's own tree. Pass `delegateId` to view or edit a child's tree. Users can view it in `/delegates`.
- [pi-async-jobs](https://github.com/OscarCookeAbbott/pi-async-jobs/commit/39ff993) (`39ff993` or later): stops background jobs early when the delegate shuts down. `pi-range-edit` and other enabled work tools are inherited when available.
