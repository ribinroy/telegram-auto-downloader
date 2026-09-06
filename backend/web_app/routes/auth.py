import secrets
import jwt
from datetime import datetime, timedelta
from flask import jsonify, request
from backend.config import (
    JWT_SECRET, ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS, MEDIA_TOKEN_HOURS,
)
from backend.database import get_db
from backend.web_app.base import token_required, decode_token
from backend.web_app.ratelimit import login_limiter, login_keys, client_ip


def _issue_access_token(user_id, username, token_version):
    """Short-lived bearer token sent with every API call."""
    now = datetime.utcnow()
    return jwt.encode({
        'typ': 'access',
        'user_id': user_id,
        'username': username,
        'tv': token_version,
        'iat': now,
        'exp': now + timedelta(minutes=ACCESS_TOKEN_MINUTES),
    }, JWT_SECRET, algorithm='HS256')


def _issue_refresh_token(user_id, session_id, jti, expires_at):
    """Long-lived token, valid only while its `user_sessions` row says so."""
    return jwt.encode({
        'typ': 'refresh',
        'user_id': user_id,
        'sid': session_id,
        'jti': jti,
        'iat': datetime.utcnow(),
        'exp': expires_at,
    }, JWT_SECRET, algorithm='HS256')


def _token_pair(user, token_version, request_obj):
    """Start a new session and mint both tokens for it."""
    db = get_db()
    jti = secrets.token_urlsafe(32)
    expires_at = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_DAYS)
    session_id = db.create_user_session(
        user['id'], jti, expires_at,
        user_agent=request_obj.headers.get('User-Agent'),
        ip=client_ip(request_obj))
    return {
        'token': _issue_access_token(user['id'], user['username'], token_version),
        'refresh_token': _issue_refresh_token(user['id'], session_id, jti, expires_at),
        'expires_in': ACCESS_TOKEN_MINUTES * 60,
    }


def _issue_media_token(user_id, token_version):
    """Token for <video>/<img> URLs: usable only on the streaming and
    thumbnail routes, and expiring on its own schedule."""
    now = datetime.utcnow()
    return jwt.encode({
        'typ': 'media',
        'user_id': user_id,
        'tv': token_version,
        'iat': now,
        'exp': now + timedelta(hours=MEDIA_TOKEN_HOURS),
    }, JWT_SECRET, algorithm='HS256')


class AuthRoutesMixin:
    def register_auth_routes(self):
        @self.app.route("/api/auth/login", methods=["POST"])
        def login():
            data = request.json or {}
            username = data.get("username")
            password = data.get("password")

            if not username or not password:
                return jsonify({"error": "Username and password required"}), 400

            # Throttle before touching the database, so a locked-out client
            # can't use login attempts to keep hashing work running either.
            keys = login_keys(request, username)
            wait = login_limiter.retry_after(keys)
            if wait:
                return jsonify({
                    "error": f"Too many failed login attempts. Try again in {wait}s.",
                    "code": "rate_limited",
                    "retry_after": wait,
                }), 429, {"Retry-After": str(wait)}

            db = get_db()
            user = db.authenticate_user(username, password)

            if not user:
                lockout = login_limiter.register_failure(keys)
                if lockout:
                    return jsonify({
                        "error": f"Too many failed login attempts. Try again in {lockout}s.",
                        "code": "rate_limited",
                        "retry_after": lockout,
                    }), 429, {"Retry-After": str(lockout)}
                return jsonify({"error": "Invalid credentials"}), 401

            login_limiter.register_success(keys)
            # Opportunistic housekeeping; cheap and keeps the table bounded.
            db.purge_expired_sessions()

            payload = _token_pair(user, user.get('token_version', 0), request)
            payload["user"] = {k: v for k, v in user.items() if k != 'token_version'}
            payload["must_change_password"] = bool(user.get('must_change_password'))
            return jsonify(payload)

        @self.app.route("/api/auth/refresh", methods=["POST"])
        def refresh():
            """Exchange a refresh token for a fresh pair.

            The refresh token is rotated on every use. Replaying a superseded
            one revokes the whole session - that is the only signal available
            that a refresh token has leaked."""
            data = request.json or {}
            supplied = (data.get("refresh_token") or "").strip()
            if not supplied:
                auth_header = request.headers.get('Authorization', '')
                if auth_header.startswith('Bearer '):
                    supplied = auth_header.split(' ', 1)[1]
            if not supplied:
                return jsonify({"error": "Refresh token required", "code": "token_missing"}), 401

            claims, error = decode_token(supplied, expected_type='refresh')
            if error:
                payload, status = error
                return jsonify(payload), status

            db = get_db()
            state = db.get_auth_state(claims.get('user_id'))
            if not state:
                return jsonify({"error": "Invalid token", "code": "token_invalid"}), 401

            new_jti = secrets.token_urlsafe(32)
            expires_at = datetime.utcnow() + timedelta(days=REFRESH_TOKEN_DAYS)
            result = db.rotate_user_session(
                claims.get('sid'), claims.get('user_id'), claims.get('jti'),
                new_jti, expires_at, ip=client_ip(request))
            if 'error' in result:
                code = 'token_reused' if result['error'] == 'reuse_detected' else 'token_revoked'
                return jsonify({"error": "Session is no longer valid", "code": code}), 401

            return jsonify({
                "token": _issue_access_token(state['id'], state['username'], state['token_version']),
                "refresh_token": _issue_refresh_token(
                    state['id'], claims.get('sid'), new_jti, expires_at),
                "expires_in": ACCESS_TOKEN_MINUTES * 60,
                "must_change_password": state['must_change_password'],
            })

        @self.app.route("/api/auth/logout", methods=["POST"])
        def logout():
            """Revoke just this device's session. Accepts the refresh token so
            logout still works once the access token has expired."""
            data = request.json or {}
            supplied = (data.get("refresh_token") or "").strip()
            if supplied:
                claims, error = decode_token(supplied, expected_type='refresh')
                if not error:
                    get_db().revoke_user_session(claims.get('sid'), claims.get('user_id'))
            return jsonify({"success": True})

        @self.app.route("/api/auth/logout-all", methods=["POST"])
        @token_required
        def logout_all():
            """Sign out every device: bumps token_version (killing outstanding
            access tokens) and revokes all refresh sessions."""
            get_db().bump_token_version(request.user['user_id'])
            return jsonify({"success": True})

        @self.app.route("/api/auth/sessions", methods=["GET"])
        @token_required
        def list_sessions():
            return jsonify({"sessions": get_db().get_user_sessions(request.user['user_id'])})

        @self.app.route("/api/auth/sessions/<int:session_id>", methods=["DELETE"])
        @token_required
        def revoke_session(session_id):
            ok = get_db().revoke_user_session(session_id, request.user['user_id'])
            if not ok:
                return jsonify({"error": "Session not found"}), 404
            return jsonify({"success": True})

        @self.app.route("/api/auth/media-token", methods=["GET"])
        @token_required
        def media_token():
            state = request.auth_state
            return jsonify({
                "media_token": _issue_media_token(state['id'], state['token_version']),
                "expires_in": MEDIA_TOKEN_HOURS * 3600,
            })

        @self.app.route("/api/auth/verify", methods=["GET"])
        @token_required
        def verify_token():
            return jsonify({
                "user": request.user,
                "must_change_password": bool(getattr(request, 'must_change_password', False))
            })

        @self.app.route("/api/auth/password", methods=["POST"])
        @token_required
        def update_password():
            data = request.json or {}
            current_password = data.get("current_password")
            new_password = data.get("new_password")

            if not current_password or not new_password:
                return jsonify({"error": "Current and new password required"}), 400

            if new_password == 'admin':
                return jsonify({"error": "The default password 'admin' is not allowed"}), 400

            if len(new_password) < 8:
                return jsonify({"error": "Password must be at least 8 characters"}), 400

            db = get_db()
            result = db.update_user_password(request.user['user_id'], current_password, new_password)

            if 'error' in result:
                return jsonify(result), 400

            # The change just revoked every session, this one included. Hand
            # back a fresh pair so the user stays signed in here while other
            # devices are signed out.
            user = {'id': request.user['user_id'], 'username': request.user['username']}
            payload = _token_pair(user, result['token_version'], request)
            payload["success"] = True
            return jsonify(payload)
