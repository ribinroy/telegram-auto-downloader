"""Shared Flask globals and the JWT auth decorator for the web_app package."""
import jwt
from functools import wraps
from pathlib import Path
from flask import request, jsonify
from backend.config import JWT_SECRET, ACCESS_TOKEN_MINUTES, REFRESH_TOKEN_DAYS
from backend.database import get_db

# Kept for backwards compatibility with older imports; the real lifetimes now
# live in backend.config (access tokens are short, refresh tokens are long).
JWT_EXPIRY_DAYS = REFRESH_TOKEN_DAYS

# Frontend dist directory
FRONTEND_DIST = Path(__file__).parent.parent.parent / "frontend" / "dist"

# Set by WebApp.__init__; read across modules via get_socketio()/get_web_app().
socketio = None
_web_app = None


def get_socketio():
    """Get the global socketio instance"""
    return socketio



def get_web_app():
    """Get the global web app instance"""
    return _web_app



# Routes still usable while a forced password change is pending
PASSWORD_CHANGE_ALLOWED_PATHS = {'/api/auth/verify', '/api/auth/password', '/api/auth/logout'}


def decode_token(token, expected_type='access'):
    """Decode and structurally validate a JWT.

    Returns (claims, None) or (None, (payload, status)) ready to be returned
    from a route. `code` in the error payload lets the client tell "expired,
    go refresh" apart from "invalid, go log in".
    """
    try:
        claims = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
    except jwt.ExpiredSignatureError:
        return None, ({'error': 'Token has expired', 'code': 'token_expired'}, 401)
    except jwt.InvalidTokenError:
        return None, ({'error': 'Invalid token', 'code': 'token_invalid'}, 401)

    # Tokens issued before typing existed are treated as access tokens so an
    # in-flight session isn't dropped on upgrade.
    token_type = claims.get('typ', 'access')
    if token_type != expected_type:
        return None, ({'error': 'Wrong token type', 'code': 'token_invalid'}, 401)
    return claims, None


def token_required(f):
    """Decorator to require a valid, non-revoked access token.

    Beyond the signature/expiry check, the token's `tv` claim is compared with
    the user's current `token_version`: a password change or "sign out
    everywhere" bumps that counter and instantly invalidates every access
    token already handed out, without waiting for expiry.

    While the user's `must_change_password` flag is set (default credentials),
    the token only grants access to the paths in
    PASSWORD_CHANGE_ALLOWED_PATHS - everything else returns 403 with code
    'password_change_required'.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        auth_header = request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]

        if not token:
            return jsonify({'error': 'Token is missing', 'code': 'token_missing'}), 401

        claims, error = decode_token(token, expected_type='access')
        if error:
            payload, status = error
            return jsonify(payload), status

        # One DB read covers existence, revocation and the password-change
        # lockdown, so state changes take effect on the very next request.
        state = get_db().get_auth_state(claims.get('user_id'))
        if not state:
            return jsonify({'error': 'Invalid token', 'code': 'token_invalid'}), 401
        if int(claims.get('tv', 0)) != int(state['token_version']):
            return jsonify({'error': 'Token has been revoked', 'code': 'token_revoked'}), 401

        request.user = claims
        request.auth_state = state
        request.must_change_password = state['must_change_password']
        if request.must_change_password and request.path not in PASSWORD_CHANGE_ALLOWED_PATHS:
            return jsonify({'error': 'Password change required',
                            'code': 'password_change_required'}), 403

        return f(*args, **kwargs)
    return decorated
