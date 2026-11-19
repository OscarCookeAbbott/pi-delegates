# pi-delegates

Delegate bounded work to fresh Pi sessions. The widget shows live and resumable work; `/delegates` opens history, details, and controls. `delegate` exposes `start`, `list`, `info`, `steer`, `request_steer`, `resume`, and `cancel`. Use exact two-character IDs.

A waiting delegate saves its question and stops. Reply with `steer`, or `resume` with a message and optional model. Quitting or switching the root session stops its delegates; reopen that session to resume them manually. A transcript is not a checkpoint for a running command. Delegates use the same filesystem as the root unless you give them another `cwd`; no Git or worktree setup is performed.

Children inherit the parent's model and enabled tools. They load extensions through normal Pi discovery plus the caller's explicit file extensions. A tool that cannot be loaded in the child is reported before work starts. Filters constrain tool exposure, not filesystem or process permissions. Optional `delegates` settings: `allowTools` and `denyTools` (empty by default, deny wins), `maxDepth` (3), `maxConcurrent` (4), and `maxLaunches` (64 per root session). You can also narrow tools on `start`.

With a compatible `pi-tasks` installed, `tasks` and `task_notes` default to the delegate's own tree. Pass `delegateId` to access a child's tree; `/delegates` shows it to the user. No other extensions are required.

Install with `pi install git:github.com/OscarCookeAbbott/pi-delegates`. Requires Pi 1.5.2+ and Node 22.19+. To try a local checkout, run `pi -e ./src/index.ts`.
