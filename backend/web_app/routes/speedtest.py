"""Browser <-> server throughput test.

Three routes, all deliberately dumb: a ping that answers at once, a download
that streams N bytes of noise, and an upload that reads the body and throws
it away. The browser does the timing - the server's only job is to not be
the bottleneck, which means no compression, no caching and no buffering a
whole body in memory.
"""
import os
import time
from flask import jsonify, request, Response

from backend.web_app.base import token_required

CHUNK = 1024 * 1024
DEFAULT_DOWNLOAD = 256 * CHUNK
MAX_DOWNLOAD = 4 * 1024 * CHUNK  # 4 GB; the client aborts on its own deadline
# One megabyte of noise, reused: generating random bytes per chunk would make
# the CPU the bottleneck before the wire is.
_NOISE = os.urandom(CHUNK)


def _no_store(resp):
    resp.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate'
    resp.headers['Pragma'] = 'no-cache'
    return resp


class SpeedTestRoutesMixin:
    def register_speedtest_routes(self):
        @self.app.route("/api/speedtest/ping", methods=["GET"])
        @token_required
        def speedtest_ping():
            """Round trip through auth and the app, as a real API call costs."""
            return _no_store(jsonify({"t": time.time()}))

        @self.app.route("/api/speedtest/download", methods=["GET"])
        @token_required
        def speedtest_download():
            """Stream `size` bytes (?size=, default 256 MB, max 4 GB) of noise."""
            try:
                size = int(request.args.get("size", DEFAULT_DOWNLOAD))
            except ValueError:
                return jsonify({"error": "size must be a number"}), 400
            size = max(CHUNK, min(size, MAX_DOWNLOAD))

            def body():
                left = size
                while left > 0:
                    n = min(CHUNK, left)
                    yield _NOISE if n == CHUNK else _NOISE[:n]
                    left -= n

            resp = Response(body(), mimetype='application/octet-stream', direct_passthrough=True)
            resp.headers['Content-Length'] = str(size)
            return _no_store(resp)

        @self.app.route("/api/speedtest/upload", methods=["POST"])
        @token_required
        def speedtest_upload():
            """Read the body in chunks and discard it; reply with what arrived."""
            started = time.monotonic()
            total = 0
            stream = request.stream
            while True:
                chunk = stream.read(CHUNK)
                if not chunk:
                    break
                total += len(chunk)
            return _no_store(jsonify({"bytes": total, "seconds": time.monotonic() - started}))
