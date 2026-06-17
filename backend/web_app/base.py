"""Shared Flask globals and the JWT auth decorator for the web_app package."""
import jwt
from functools import wraps
from pathlib import Path
from flask import request, jsonify
from backend.config import JWT_SECRET
from backend.database import get_db

JWT_EXPIRY_DAYS = 30  # Keep signed in for 30 days

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
PASSWORD_CHANGE_ALLOWED_PATHS = {'/api/auth/verify', '/api/auth/password'}


def token_required(f):
    """Decorator to require valid JWT token.

    While the user's `must_change_password` flag is set (default credentials),
    the token only grants access to /api/auth/verify and /api/auth/password —
    everything else returns 403 with code 'password_change_required'.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        auth_header = request.headers.get('Authorization')
        if auth_header and auth_header.startswith('Bearer '):
            token = auth_header.split(' ')[1]

        if not token:
            return jsonify({'error': 'Token is missing'}), 401

        try:
            data = jwt.decode(token, JWT_SECRET, algorithms=['HS256'])
            request.user = data
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token has expired'}), 401
        except jwt.InvalidTokenError:
            return jsonify({'error': 'Invalid token'}), 401

        # Checked in the DB (not the token) so the lockdown lifts immediately
        # after the password change without re-issuing the JWT.
        request.must_change_password = get_db().user_must_change_password(data.get('user_id'))
        if request.must_change_password and request.path not in PASSWORD_CHANGE_ALLOWED_PATHS:
            return jsonify({'error': 'Password change required',
                            'code': 'password_change_required'}), 403

        return f(*args, **kwargs)
    return decorated

