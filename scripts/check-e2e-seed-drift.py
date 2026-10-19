#!/usr/bin/env python3
"""Fail when scripts/app-sync-e2e.sh seeds drifted from prisma/schema.prisma.

Two checks, no DB and no backend needed (the e2e itself only runs against a
live backend, so seed SQL rots silently — e.g. a new NOT NULL column without
a default breaks every seed INSERT):
  1. every seeded column must exist on the model (catches renames/drops);
  2. every model field that is required (not optional, no @default, not
     @updatedAt, not a relation) must be seeded (catches the expiresAt
     class: a NOT NULL column the INSERT omits).

Relation fields (lists, object references) and @updatedAt columns are
skipped: seeds never write the former, and the latter rely on DB/client
defaults provided by the hand-written migrations.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
schema = (ROOT / "prisma" / "schema.prisma").read_text()
script = (ROOT / "scripts" / "app-sync-e2e.sh").read_text()

# model -> {field: required}
models: dict[str, dict[str, bool]] = {}
# First pass: type names, so relation-object fields (typed as another model)
# can be told apart from capitalized scalars (String, DateTime, ...).
type_names = set(re.findall(r"^(?:model|enum) (\w+) \{", schema, re.M))
current: str | None = None
for line in schema.splitlines():
    m = re.match(r"model (\w+) \{", line)
    if m:
        current = m.group(1)
        models[current] = {}
        continue
    if line.startswith("}"):
        current = None
        continue
    if current is None:
        continue
    f = re.match(r"\s{2}(\w+)\s+([\w()\[\]]+\??)(.*)", line)
    if not f:
        continue
    assert current is not None  # narrowed above; kept explicit for checkers
    name, typ, rest = f.groups()
    if name.startswith("@@"):
        continue
    base_typ = typ.rstrip("?")
    if "[" in base_typ or base_typ in type_names:
        continue  # relation list/object, not a column
    optional = typ.endswith("?")
    required = not optional and "@default" not in rest and "@updatedAt" not in rest
    models[current][name] = required

errors: list[str] = []
seeds = 0
for m in re.finditer(r'INSERT INTO \\"(\w+)\\" \(([^)]+)\)', script):
    table, cols = m.group(1), [c.strip().strip('\\"') for c in m.group(2).split(",")]
    seeds += 1
    fields = models.get(table)
    if fields is None:
        errors.append(f"{table}: seeds unknown model/table")
        continue
    for col in cols:
        if col not in fields:
            errors.append(f"{table}: seed writes unknown column {col}")
    for field, required in fields.items():
        if required and field not in cols:
            errors.append(f"{table}: seed omits required column {field}")

if errors:
    print("e2e seed drift:\n" + "\n".join(f"  - {e}" for e in errors))
    sys.exit(1)
print(f"e2e seed drift check OK ({seeds} seed INSERTs)")
