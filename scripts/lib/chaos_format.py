"""Pretty-print the admin API's chaos responses for a terminal.

Reads JSON on stdin; the single argument says which shape to expect. Kept
out of the Makefile because formatting logic wedged into a recipe is
unreadable and unquotable in about equal measure.
"""

from __future__ import annotations

import json
import sys

BOLD = "\033[1m"
DIM = "\033[2m"
YELLOW = "\033[33m"
GREEN = "\033[32m"
OFF = "\033[0m"


def shown(value: object) -> str:
    """Render a value the way the operator would type it back.

    Python's True/False are not what `chaos.sh set` accepts, and printing
    them invites someone to paste one back and get a validation error.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if value == "":
        return '""'
    return str(value)


def flag_lines(flags: list[dict]) -> list[str]:
    active = [flag for flag in flags if flag["active"]]
    if not active:
        return [f"  {GREEN}no flags are active{OFF}"]
    width = max(len(flag["name"]) for flag in active)
    return [
        f"  {YELLOW}{flag['name']:<{width}}{OFF} {shown(flag['value'])}"
        f"  {DIM}(default {shown(flag['default'])}){OFF}"
        for flag in sorted(active, key=lambda flag: flag["name"])
    ]


def print_status(doc: dict) -> None:
    scenario = doc.get("activeScenario") or "none"
    print(f"{BOLD}active scenario:{OFF} {scenario}")
    print("\n".join(flag_lines(doc["flags"])))


def print_reset(doc: dict) -> None:
    cleared = doc.get("cleared") or []
    compensated = doc.get("compensated") or []
    print(f"{GREEN}reset{OFF}: cleared {len(cleared)} flag(s)")
    for name in sorted(cleared):
        print(f"  - {name}")
    # Worth calling out separately: these are the ones a hash delete alone
    # would not have undone.
    for name in compensated:
        print(f"  {GREEN}rebuilt{OFF} {name}")


def print_scenarios(doc: dict) -> None:
    print(f"{BOLD}active:{OFF} {doc.get('active') or 'none'}\n")
    for scenario in doc["scenarios"]:
        print(f"  {BOLD}{scenario['id']:<4}{OFF} {scenario['name']}")
        print(f"       {DIM}{scenario['story']}{OFF}")
        print(f"       {DIM}{', '.join(scenario['products'])}{OFF}")


def print_applied(doc: dict) -> None:
    scenario = doc["scenario"]
    print(f"{BOLD}{scenario['id']}  {scenario['name']}{OFF}")
    print(f"  {scenario['story']}\n")
    for name, value in sorted(scenario["flags"].items()):
        print(f"  {YELLOW}{name}{OFF} = {shown(value)}")
    if scenario.get("requiresRestartToRecover"):
        print(f"\n  {YELLOW}note{OFF}: this one needs a restart to recover, "
              "not just a reset.")
    if scenario.get("loadMultiplier", 1) != 1:
        print(f"  {DIM}runs at {scenario['loadMultiplier']}x load{OFF}")


PRINTERS = {
    "status": print_status,
    "reset": print_reset,
    "scenarios": print_scenarios,
    "applied": print_applied,
}


def main() -> int:
    shape = sys.argv[1] if len(sys.argv) > 1 else "status"
    PRINTERS[shape](json.load(sys.stdin))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
