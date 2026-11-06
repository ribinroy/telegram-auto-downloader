"""The VR headset feed (HereSphere + DeoVR) and its settings.

`/vr/<key>/...` is reachable without a login - the key is the credential
(see backend/vr.py). Everything else here is behind the API token.
"""
from flask import jsonify, request

from backend import vr
from backend.config import MEDIA_TOKEN_HOURS
from backend.database import get_db
from backend.file_meta import get_thumbs_dir
from backend.web_app.base import token_required
from backend import subtitles


class VrRoutesMixin:
    def register_vr_routes(self):
        app = self.app
        annotate = self._annotate_downloads

        def _base_url():
            # The app needs absolute URLs; behind a reverse proxy the
            # scheme/host the headset used is what has to come back.
            proto = request.headers.get('X-Forwarded-Proto') or request.scheme
            host = request.headers.get('X-Forwarded-Host') or request.host
            return f'{proto}://{host}'

        def _thumbs(download_id):
            d = get_thumbs_dir() / str(download_id)
            if not d.is_dir():
                return []
            return sorted(f.name for f in d.iterdir() if f.suffix == '.jpg')

        def _session(key):
            """(config, urls) for a valid key, else None."""
            db = get_db()
            cfg = vr.check_key(db, key)
            if not cfg:
                return None
            token = vr.mint_media_token(db, cfg.get('username'), MEDIA_TOKEN_HOURS)
            if not token:
                return None
            return cfg, vr.FeedUrls(_base_url(), cfg['key'], token)

        def _video(download_id, cfg):
            d = get_db().get_download_by_id(download_id)
            if not d or d.get('status') != 'done' or d.get('deleted_at'):
                return None
            annotate([d])
            if d.get('hidden') and not cfg.get('include_secured'):
                return None
            return d

        def _heresphere(body, status=200):
            resp = jsonify(body)
            resp.status_code = status
            resp.headers['HereSphere-JSON-Version'] = '1'
            resp.headers['Cache-Control'] = 'no-store'
            return resp

        def _deovr(body, status=200):
            resp = jsonify(body)
            resp.status_code = status
            resp.headers['Cache-Control'] = 'no-store'
            return resp

        # --- HereSphere -------------------------------------------------------

        @app.route("/vr/<key>/heresphere", methods=["GET", "POST", "HEAD"])
        def vr_heresphere_library(key):
            s = _session(key)
            if not s:
                return _heresphere(vr.heresphere_denied('DownLee: invalid or disabled key'), 401)
            cfg, urls = s
            rows = vr.library_downloads(get_db(), annotate, cfg.get('include_secured', False))
            return _heresphere(vr.heresphere_library(rows, urls))

        @app.route("/vr/<key>/heresphere/<int:download_id>", methods=["GET", "POST"])
        def vr_heresphere_video(key, download_id):
            s = _session(key)
            if not s:
                return _heresphere(vr.heresphere_denied('DownLee: invalid or disabled key'), 401)
            cfg, urls = s
            d = _video(download_id, cfg)
            if not d:
                return _heresphere({'access': -1, 'title': 'Not available'}, 404)
            tracks = []
            path = next((p for p in vr_candidate_paths(d) if p.is_file()), None)
            if path:
                try:
                    tracks = subtitles.list_tracks(path)
                except subtitles.SubtitleError:
                    tracks = []
            return _heresphere(vr.heresphere_video(d, urls, _thumbs(download_id), tracks))

        # --- DeoVR ------------------------------------------------------------

        @app.route("/vr/<key>/deovr", methods=["GET", "POST"])
        def vr_deovr_library(key):
            s = _session(key)
            if not s:
                return _deovr(vr.deovr_denied('DownLee: invalid or disabled key'), 401)
            cfg, urls = s
            rows = vr.library_downloads(get_db(), annotate, cfg.get('include_secured', False))
            return _deovr(vr.deovr_library(rows, urls, lambda d: _thumbs(d['id'])))

        @app.route("/vr/<key>/deovr/<int:download_id>", methods=["GET", "POST"])
        def vr_deovr_video(key, download_id):
            s = _session(key)
            if not s:
                return _deovr(vr.deovr_denied('DownLee: invalid or disabled key'), 401)
            cfg, urls = s
            d = _video(download_id, cfg)
            if not d:
                return _deovr({'error': 'Not available'}, 404)
            return _deovr(vr.deovr_video(d, urls, _thumbs(download_id)))

        # --- settings ---------------------------------------------------------

        def _public(cfg):
            if not cfg.get('key'):
                return {'enabled': False, 'key': None, 'include_secured': False, 'created_at': None, 'urls': None}
            base = _base_url()
            return {
                'enabled': True, 'key': cfg['key'],
                'include_secured': bool(cfg.get('include_secured')),
                'created_at': cfg.get('created_at'),
                'urls': {
                    'heresphere': f"{base}/vr/{cfg['key']}/heresphere",
                    'deovr': f"{base}/vr/{cfg['key']}/deovr",
                },
            }

        @app.route("/api/settings/vr", methods=["GET"])
        @token_required
        def vr_settings_get():
            return jsonify(_public(vr.read_feed_config(get_db())))

        @app.route("/api/settings/vr", methods=["POST"])
        @token_required
        def vr_settings_post():
            """{action: 'regenerate'|'disable'} or {include_secured: bool}."""
            db = get_db()
            data = request.json or {}
            action = data.get('action')
            if action == 'disable':
                vr.disable_key(db)
                return jsonify(_public({}))
            username = (request.user or {}).get('username')
            if action == 'regenerate':
                include = data.get('include_secured')
                if include is None:
                    include = vr.read_feed_config(db).get('include_secured', False)
                return jsonify(_public(vr.regenerate_key(db, username, bool(include))))
            if 'include_secured' in data:
                cfg = vr.read_feed_config(db)
                if not cfg.get('key'):
                    return jsonify({'error': 'No key yet'}), 400
                return jsonify(_public(vr.update_feed_config(db, include_secured=bool(data['include_secured']))))
            return jsonify({'error': 'Nothing to do'}), 400

        # --- per-download projection pick -------------------------------------

        @app.route("/api/downloads/<int:download_id>/projection", methods=["GET"])
        @token_required
        def download_projection_get(download_id):
            d = get_db().get_download_by_id(download_id)
            if not d:
                return jsonify({'error': 'Not found'}), 404
            guessed, lens, _ = vr.projection_for({**d, 'vr_projection': None})
            return jsonify({'projection': d.get('vr_projection'), 'detected': guessed, 'lens': lens})

        @app.route("/api/downloads/<int:download_id>/projection", methods=["PUT"])
        @token_required
        def download_projection_put(download_id):
            """{projection: 'flat'|'180-sbs'|...|null} - null clears the pick."""
            data = request.json or {}
            value = data.get('projection')
            if value is not None and value not in vr.PROJECTIONS:
                return jsonify({'error': 'Unknown projection'}), 400
            db = get_db()
            if not db.get_download_by_id(download_id):
                return jsonify({'error': 'Not found'}), 404
            db.update_download_by_id(download_id, vr_projection=value)
            return jsonify({'projection': value})


def vr_candidate_paths(download):
    from backend.web_app.helpers import candidate_file_paths
    return candidate_file_paths(download, download.get('file') or '')
