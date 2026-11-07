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
from backend.web_app.ratelimit import client_ip

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

        # --- results table (both kinds) -----------------------------------------
        from backend.database import get_db
        from backend import speedtest as inet

        @self.app.route("/api/speedtest/results", methods=["GET"])
        @token_required
        def speedtest_results():
            """History (?kind=browser|internet, ?limit=), newest first."""
            kind = request.args.get("kind") or None
            if kind not in (None, 'browser', 'internet'):
                return jsonify({"error": "kind must be browser or internet"}), 400
            try:
                limit = max(1, min(int(request.args.get("limit", 20)), 200))
            except ValueError:
                return jsonify({"error": "limit must be a number"}), 400
            return _no_store(jsonify({"results": get_db().get_speed_tests(kind, limit=limit)}))

        @self.app.route("/api/speedtest/results", methods=["POST"])
        @token_required
        def speedtest_record():
            """The browser test's outcome, timed by the device: {ping, download_mbps,
            upload_mbps, download_bytes, upload_bytes}. The device and its
            address are taken from the request, not the body."""
            data = request.json or {}
            try:
                row = get_db().add_speed_test(
                    'browser', ping=data.get('ping') if isinstance(data.get('ping'), dict) else None,
                    download_mbps=float(data.get('download_mbps') or 0),
                    upload_mbps=float(data.get('upload_mbps') or 0),
                    download_bytes=int(data.get('download_bytes') or 0),
                    upload_bytes=int(data.get('upload_bytes') or 0),
                    client=request.headers.get('User-Agent'), ip=client_ip(request),
                )
            except (TypeError, ValueError):
                return jsonify({"error": "Bad result"}), 400
            return jsonify(row), 201

        @self.app.route("/api/speedtest/results/<int:test_id>", methods=["DELETE"])
        @token_required
        def speedtest_delete(test_id):
            if not get_db().delete_speed_test(test_id):
                return jsonify({"error": "Not found"}), 404
            return jsonify({"deleted": True})

        # --- server -> internet ------------------------------------------------

        @self.app.route("/api/speedtest/internet", methods=["GET"])
        @token_required
        def internet_speedtest_status():
            """Live state of the box's own uplink test (history: /results?kind=internet)."""
            return _no_store(jsonify(inet.get_test().status()))

        @self.app.route("/api/speedtest/internet", methods=["POST"])
        @token_required
        def internet_speedtest_start():
            test = inet.get_test()
            if not test.start(on_done=lambda r: inet.record_history(get_db(), r)):
                return jsonify({"error": "A test is already running"}), 409
            return _no_store(jsonify(test.status()))

        @self.app.route("/api/speedtest/internet", methods=["DELETE"])
        @token_required
        def internet_speedtest_cancel():
            inet.get_test().cancel()
            return _no_store(jsonify({"cancelled": True}))
