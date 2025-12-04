"""
Telegram Web-based Authentication Handler

Handles the Telegram authentication flow via web UI instead of CLI.
This enables Docker containerization without interactive terminal access.
"""
import asyncio
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, PhoneCodeInvalidError, PasswordHashInvalidError
from backend.config import API_ID, API_HASH, SESSION_FILE


class TelegramAuthHandler:
    """Handles Telegram authentication via web interface"""

    def __init__(self):
        self.client = None
        self.phone = None
        self.phone_code_hash = None
        self._auth_state = 'unknown'  # unknown, not_authenticated, awaiting_code, awaiting_password, authenticated
        self._loop = None

    def _get_or_create_loop(self):
        """Get existing event loop or create new one"""
        try:
            return asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop

    def _ensure_client(self):
        """Ensure client is created"""
        if self.client is None:
            self.client = TelegramClient(str(SESSION_FILE), API_ID, API_HASH)

    async def _check_auth_async(self):
        """Check if already authenticated"""
        self._ensure_client()

        try:
            await self.client.connect()

            if await self.client.is_user_authorized():
                self._auth_state = 'authenticated'
                me = await self.client.get_me()
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
        """Synchronous wrapper to check authentication status"""
        loop = self._get_or_create_loop()
        return loop.run_until_complete(self._check_auth_async())

    async def _send_code_async(self, phone: str):
        """Send verification code to phone"""
        self._ensure_client()
        self.phone = phone

        try:
            await self.client.connect()

            # Check if already authorized
            if await self.client.is_user_authorized():
                self._auth_state = 'authenticated'
                return {'success': True, 'already_authenticated': True}

            # Send code
            result = await self.client.send_code_request(phone)
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
        """Synchronous wrapper to send verification code"""
        loop = self._get_or_create_loop()
        return loop.run_until_complete(self._send_code_async(phone))

    async def _verify_code_async(self, code: str):
        """Verify the code sent to phone"""
        if not self.phone or not self.phone_code_hash:
            return {'success': False, 'error': 'No pending authentication. Start with phone number first.'}

        try:
            await self.client.sign_in(
                phone=self.phone,
                code=code,
                phone_code_hash=self.phone_code_hash
            )

            self._auth_state = 'authenticated'
            me = await self.client.get_me()

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
        """Synchronous wrapper to verify code"""
        loop = self._get_or_create_loop()
        return loop.run_until_complete(self._verify_code_async(code))

    async def _verify_password_async(self, password: str):
        """Verify 2FA password"""
        try:
            await self.client.sign_in(password=password)

            self._auth_state = 'authenticated'
            me = await self.client.get_me()

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
        """Synchronous wrapper to verify 2FA password"""
        loop = self._get_or_create_loop()
        return loop.run_until_complete(self._verify_password_async(password))

    async def _logout_async(self):
        """Logout and remove session"""
        try:
            self._ensure_client()
            await self.client.connect()
            await self.client.log_out()
            self._auth_state = 'not_authenticated'
            return {'success': True}
        except Exception as e:
            return {'success': False, 'error': str(e)}

    def logout(self):
        """Synchronous wrapper to logout"""
        loop = self._get_or_create_loop()
        return loop.run_until_complete(self._logout_async())

    def get_state(self):
        """Get current authentication state"""
        return self._auth_state

    async def disconnect(self):
        """Disconnect client"""
        if self.client and self.client.is_connected():
            await self.client.disconnect()


# Global instance
_auth_handler = None


def get_auth_handler():
    """Get or create the global auth handler"""
    global _auth_handler
    if _auth_handler is None:
        _auth_handler = TelegramAuthHandler()
    return _auth_handler
