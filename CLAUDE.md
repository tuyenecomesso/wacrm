@AGENTS.md

## Development Workflow - Mandatory Completion Gate

After every non-trivial implementation, do not mark the work complete immediately. The following completion loop is mandatory:

1. Run the project verification commands relevant to the change (tests, lint, type checks, build, migrations, or static analysis).
2. Load and run the skill defined at workspace-root `.agents/skills/production-readiness-auditor/SKILL.md` against the complete implementation and its end-to-end flow.
3. Load and run the skill defined at workspace-root `.agents/skills/anti-overengineering-codex-skill/SKILL.md` to detect unnecessary abstractions, avoidable model calls, duplicated logic, excess context, cost, latency, or moving parts.
4. Treat every supported BLOCKER, HIGH, MEDIUM, failed check, missing critical test, and actionable simplification as implementation work. Fix it autonomously without asking the user for permission or confirmation.
5. Re-run the affected verification commands and both skills after the fixes. Continue the audit -> fix -> verify loop until all checks pass and both reviews are green, with no unresolved production blocker or actionable overengineering finding.
6. Only then mark the task, OpenSpec item, or change as completed. Never mark partial, failing, unaudited, or knowingly fragile work as done.

This gate runs automatically before completion; do not wait for the user to request it. If an external dependency, unavailable credential, or irreversible decision makes green status impossible, keep the work open and report the exact blocker instead of claiming completion.
