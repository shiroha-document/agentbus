#!/usr/bin/env python3
"""Tiny static file server for the Windows installer CI runtime tests.

Serves a release-shaped fixture tree (releases/download/<tag>/...) over
plain HTTP on 127.0.0.1 so install.ps1 can verify checksum, install, and
run the binary without touching GitHub or any real hub. Write methods and
path traversal are rejected.

Usage: win-install-fixture.py ROOT PORT
"""

import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class FixtureHandler(SimpleHTTPRequestHandler):
    def log_message(self, fmt, *args):  # quiet: CI prints its own logs
        pass

    def do_PUT(self):
        self.send_error(405)

    do_POST = do_PUT
    do_DELETE = do_PUT

    def translate_path(self, path):
        # Strip query/fragment and keep the request inside ROOT.
        path = path.split("?", 1)[0].split("#", 1)[0]
        rel = path.lstrip("/")
        full = os.path.realpath(os.path.join(self.directory, rel))
        root = os.path.realpath(self.directory)
        if not (full == root or full.startswith(root + os.sep)):
            return os.path.join(root, "__forbidden__")
        return full


def main():
    root = os.path.realpath(sys.argv[1])
    port = int(sys.argv[2])
    handler = lambda *a, **kw: FixtureHandler(*a, directory=root, **kw)
    srv = ThreadingHTTPServer(("127.0.0.1", port), handler)
    srv.serve_forever()


if __name__ == "__main__":
    main()
