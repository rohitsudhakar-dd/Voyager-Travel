"""Split a DDL script into individual statements.

Migrations are written as readable SQL scripts, but asyncpg executes through
prepared statements and refuses more than one command at a time. Splitting here
keeps the migrations legible instead of forcing every CREATE TABLE into its own
Python string.

Quoting and comments are tracked so that a semicolon inside a string literal or
a `--` comment is not mistaken for a statement terminator.
"""

from __future__ import annotations

from typing import Iterator


def split_statements(script: str) -> Iterator[str]:
    statement: list[str] = []
    index = 0
    length = len(script)

    while index < length:
        char = script[index]

        # Line comment: skip to end of line, dropping it entirely.
        if char == "-" and script.startswith("--", index):
            end = script.find("\n", index)
            index = length if end == -1 else end + 1
            continue

        # Block comment.
        if char == "/" and script.startswith("/*", index):
            end = script.find("*/", index + 2)
            index = length if end == -1 else end + 2
            continue

        # Single-quoted literal; '' is an escaped quote.
        if char == "'":
            statement.append(char)
            index += 1
            while index < length:
                statement.append(script[index])
                if script[index] == "'":
                    if script.startswith("''", index):
                        statement.append(script[index + 1])
                        index += 2
                        continue
                    index += 1
                    break
                index += 1
            continue

        # Dollar-quoted body, e.g. $$ ... $$ or $tag$ ... $tag$.
        if char == "$":
            end_of_tag = script.find("$", index + 1)
            if end_of_tag != -1 and script[index + 1 : end_of_tag].isidentifier() or (
                end_of_tag == index + 1
            ):
                tag = script[index : end_of_tag + 1]
                closing = script.find(tag, end_of_tag + 1)
                stop = length if closing == -1 else closing + len(tag)
                statement.append(script[index:stop])
                index = stop
                continue

        if char == ";":
            candidate = "".join(statement).strip()
            if candidate:
                yield candidate
            statement = []
            index += 1
            continue

        statement.append(char)
        index += 1

    trailing = "".join(statement).strip()
    if trailing:
        yield trailing
