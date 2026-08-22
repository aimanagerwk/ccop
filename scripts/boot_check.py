import json, sys
from ccop.__main__ import main

def run(argv):
    try:
        main(argv)
    except SystemExit as e:
        return e.code
    return 0

# up twice (idempotent)
for i in range(2):
    code = run(["up"])
    print("UP_CODE", i, code, file=sys.stderr)

code = run(["status"])
print("STATUS_CODE", code, file=sys.stderr)
