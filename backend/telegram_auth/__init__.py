"""
Telegram Web-based Authentication Handler

Handles the Telegram authentication flow via web UI instead of CLI.
This enables Docker containerization without interactive terminal access.
"""
import asyncio
import threading
from pathlib import Path
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PasswordHashInvalidError
from backend.config import SESSION_FILE, load_telegram_config


class TelegramAuthHandler:
    """Handles Telegram authentication via web interface"""

    def __init__(self):
        self.phone = None
        self.phone_code_hash = None
        self._auth_state = 'unknown'
        # Create a dedicated thread with its own event loop for auth operations
        self._loop = None
        self._thread = None
        self._client = None

    def _ensure_loop(self):
        """Ensure we have a dedicated event loop running in a separate thread"""
        if self._loop is None or not self._loop.is_running():
            self._loop = asyncio.new_event_loop()
            self._thread = threading.Thread(target=self._run_loop, daemon=True)
            self._thread.start()
            # Wait for loop to start
            import time
            time.sleep(0.1)

    def _run_loop(self):
        """Run the event loop in a dedicated thread"""
        asyncio.set_event_loop(self._loop)
        self._loop.run_forever()

    def _run_async(self, coro):
        """Run an async coroutine in our dedicated loop"""
        self._ensure_loop()
        future = asyncio.run_coroutine_threadsafe(coro, self._loop)
        return future.result(timeout=60)

    def _get_client(self):
        """Get or create the Telethon client"""
        if self._client is None:
            # Load fresh config each time (in case it was updated via web UI)
            config = load_telegram_config()
            self._client = TelegramClient(str(SESSION_FILE), config['api_id'], config['api_hash'])
        return self._client

    def check_auth_simple(self):
        """
        Simple check if session file exists AND config is valid.
        Use this for initial page load to avoid event loop conflicts.
        """
        # First check if config is valid
        config = load_telegram_config()
        if not config['api_id'] or not config['api_hash'] or not config['chat_id']:
            return {'authenticated': False, 'configured': False}

        # Then check if session file exists
        session_path = Path(str(SESSION_FILE) + '.session')
        if session_path.exists() and session_path.stat().st_size > 0:
            return {'authenticated': True, 'session_exists': True, 'configured': True}
        return {'authenticated': False, 'configured': True}

    async def _check_auth_async(self):
        """Check if already authenticated by connecting to Telegram"""
        client = self._get_client()

        try:
            if not client.is_connected():
                await client.connect()

            if await client.is_user_authorized():
                self._auth_state = 'authenticated'
                me = await client.get_me()
                return {
                    'authenticated': True,
                    'user': {
                        'id': me.id,
                        'first_name': me.first_name,
                        'last_name': me.last_name,
                        'username': me.username,
                        'phone': me.phone
                    }
                }
            else:
                self._auth_state = 'not_authenticated'
                return {'authenticated': False}
        except Exception as e:
            self._auth_state = 'not_authenticated'
            return {'authenticated': False, 'error': str(e)}

    def check_auth(self):
        """Check authentication status"""
        # Only do a quick session file check - don't try to connect
        # because the main app's Telegram client already has the session locked
        return self.check_auth_simple()

    async def _send_code_async(self, phone: str):
        """Send verification code to phone"""
        client = self._get_client()
        self.phone = phone

        try:
            if not client.is_connected():
                await client.connect()

            # Check if already authorized
            if await client.is_user_authorized():
                self._auth_state = 'authenticated'
                me = await client.get_me()
                return {
                    'success': True,
                    'already_authenticated': True,
                    'user': {
                        'id': me.id,
                        'first_name': me.first_name,
                        'last_name': me.last_name,
                        'username': me.username,
                        'phone': me.phone
                    }
                }

            # Send code
            result = await client.send_code_request(phone)
            self.phone_code_hash = result.phone_code_hash
            self._auth_state = 'awaiting_code'

            return {
                'success': True,
                'phone_code_hash': result.phone_code_hash,
                'next_step': 'code'
            }
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def send_code(self, phone: str):
        """Send verification code"""
        return self._run_async(self._send_code_async(phone))

    async def _verify_code_async(self, code: str):
        """Verify the code sent to phone"""
        if not self.phone or not self.phone_code_hash:
            return {'success': False, 'error': 'No pending authentication. Start with phone number first.'}

        client = self._get_client()

        try:
            await client.sign_in(
                phone=self.phone,
                code=code,
                phone_code_hash=self.phone_code_hash
            )

            self._auth_state = 'authenticated'
            me = await client.get_me()

            return {
                'success': True,
                'user': {
                    'id': me.id,
                    'first_name': me.first_name,
                    'last_name': me.last_name,
                    'username': me.username,
                    'phone': me.phone
                }
            }
        except SessionPasswordNeededError:
            self._auth_state = 'awaiting_password'
            return {
                'success': True,
                'needs_password': True,
                'next_step': 'password'
            }
        except PhoneCodeInvalidError:
            return {'success': False, 'error': 'Invalid code. Please try again.'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def verify_code(self, code: str):
        """Verify code"""
        return self._run_async(self._verify_code_async(code))

    async def _verify_password_async(self, password: str):
        """Verify 2FA password"""
        client = self._get_client()

        try:
            await client.sign_in(password=password)

            self._auth_state = 'authenticated'
            me = await client.get_me()

            return {
                'success': True,
                'user': {
                    'id': me.id,
                    'first_name': me.first_name,
                    'last_name': me.last_name,
                    'username': me.username,
                    'phone': me.phone
                }
            }
        except PasswordHashInvalidError:
            return {'success': False, 'error': 'Invalid password. Please try again.'}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def verify_password(self, password: str):
        """Verify 2FA password"""
        return self._run_async(self._verify_password_async(password))

    async def _logout_async(self):
        """Logout and remove session"""
        client = self._get_client()

        try:
            if not client.is_connected():
                await client.connect()
            await client.log_out()
            self._auth_state = 'not_authenticated'
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def logout(self):
        """Logout"""
        return self._run_async(self._logout_async())

    def get_state(self):
        """Get current authentication state"""
        return self._auth_state


# Global instance
_auth_handler = None


def get_auth_handler():
    """Get or create the global auth handler"""
    global _auth_handler
    if _auth_handler is None:
        _auth_handler = TelegramAuthHandler()
    return _auth_handler
