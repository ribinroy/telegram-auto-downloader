"""
Database module for DownloadLee
"""
import hashlib
import uuid
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Float, DateTime, Text, Boolean
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session

Base = declarative_base()


def generate_uuid():
    """Generate a UUID string for download tracking"""
    return str(uuid.uuid4())


class Download(Base):
    """Download model representing a file download"""
    __tablename__ = 'downloads'

    id = Column(Integer, primary_key=True, autoincrement=True)
    message_id = Column(String(100), nullable=True)  # UUID or Telegram message ID as string
    file = Column(String(500), nullable=False)
    status = Column(String(50), default='downloading')
    progress = Column(Float, default=0)
    speed = Column(Float, default=0)
    error = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)
    downloaded_bytes = Column(BigInteger, default=0)
    total_bytes = Column(BigInteger, default=0)
    pending_time = Column(Float, nullable=True)
    is_deleted = Column(Boolean, default=False)
    downloaded_from = Column(String(100), default='telegram')  # 'telegram' or domain name
    url = Column(Text, nullable=True)  # Source URL for yt-dlp downloads
    file_deleted = Column(Boolean, default=False)  # True if physical file was deleted from disk

    def to_dict(self):
        """Convert model to dictionary"""
        return {
            'id': self.id,
            'message_id': self.message_id,
            'file': self.file,
            'status': self.status,
            'progress': self.progress,
            'speed': self.speed,
            'error': self.error,
            'updated_at': f"{self.updated_at.isoformat()}Z" if self.updated_at else None,
            'created_at': f"{self.created_at.isoformat()}Z" if self.created_at else None,
            'downloaded_bytes': self.downloaded_bytes,
            'total_bytes': self.total_bytes,
            'pending_time': self.pending_time,
            'downloaded_from': self.downloaded_from or 'telegram',
            'url': self.url,
            'file_deleted': self.file_deleted or False
        }


class Settings(Base):
    """Settings model for storing application configuration"""
    __tablename__ = 'settings'

    id = Column(Integer, primary_key=True, autoincrement=True)
    key = Column(String(100), unique=True, nullable=False)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        """Convert model to dictionary"""
        return {
            'key': self.key,
            'value': self.value,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None
        }


class DownloadTypeMap(Base):
    """Download type mapping for folder organization and security"""
    __tablename__ = 'download_type_maps'

    id = Column(Integer, primary_key=True, autoincrement=True)
    downloaded_from = Column(String(100), unique=True, nullable=False)
    is_secured = Column(Boolean, default=False)
    folder = Column(String(255), nullable=True)
    quality = Column(String(20), nullable=True)  # Default quality e.g., "720p", "1080p"
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        """Convert model to dictionary"""
        return {
            'id': self.id,
            'downloaded_from': self.downloaded_from,
            'is_secured': self.is_secured,
            'folder': self.folder,
            'quality': self.quality,
            'created_at': f"{self.created_at.isoformat()}Z" if self.created_at else None,
            'updated_at': f"{self.updated_at.isoformat()}Z" if self.updated_at else None
        }


class User(Base):
    """User model for authentication"""
    __tablename__ = 'users'

    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False)
    password_hash = Column(String(64), nullable=False)  # SHA-256 hash
    created_at = Column(DateTime, default=datetime.utcnow)

    def to_dict(self):
        """Convert model to dictionary (excludes password)"""
        return {
            'id': self.id,
            'username': self.username,
            'created_at': f"{self.created_at.isoformat()}Z" if self.created_at else None
        }

    @staticmethod
    def hash_password(password: str) -> str:
        """Hash a password using SHA-256"""
        return hashlib.sha256(password.encode()).hexdigest()

    def check_password(self, password: str) -> bool:
        """Check if provided password matches"""
        return self.password_hash == self.hash_password(password)


class DatabaseManager:
    """Database manager for handling all database operations"""

    def __init__(self, database_url):
        self.engine = create_engine(database_url, pool_pre_ping=True)
        self.Session = scoped_session(sessionmaker(bind=self.engine))
        Base.metadata.create_all(self.engine)
        self._run_migrations()

    def _run_migrations(self):
        """Run any pending database migrations"""
        from sqlalchemy import text, inspect

        inspector = inspect(self.engine)
        columns = [c['name'] for c in inspector.get_columns('downloads')]

        with self.engine.connect() as conn:
            # Add file_deleted column if it doesn't exist
            if 'file_deleted' not in columns:
                conn.execute(text('ALTER TABLE downloads ADD COLUMN file_deleted BOOLEAN DEFAULT FALSE'))
                conn.commit()

    def get_session(self):
        """Get a new database session"""
        return self.Session()

    def close_session(self):
        """Close the current session"""
        self.Session.remove()

    def add_download(self, file, status='downloading', progress=0, speed=0,
                     error=None, downloaded_bytes=0, total_bytes=0, pending_time=None,
                     message_id=None, downloaded_from='telegram', url=None):
        """Add a new download entry"""
        session = self.get_session()
        try:
            now = datetime.utcnow()
            # Convert message_id to string if it's an int (for Telegram IDs)
            msg_id = str(message_id) if message_id is not None else generate_uuid()
            download = Download(
                message_id=msg_id,
                file=file,
                status=status,
                progress=progress,
                speed=speed,
                error=error,
                updated_at=now,
                created_at=now,
                downloaded_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                pending_time=pending_time,
                downloaded_from=downloaded_from,
                url=url
            )
            session.add(download)
            session.commit()
            return download.to_dict()
        finally:
            self.close_session()

    def update_download(self, file, **kwargs):
        """Update a download entry by filename"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(file=file).first()
            if download:
                for key, value in kwargs.items():
                    if hasattr(download, key):
                        setattr(download, key, value)
                session.commit()
                return download.to_dict()
            return None
        finally:
            self.close_session()

    def update_download_by_id(self, download_id, **kwargs):
        """Update a download entry by ID"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(id=download_id).first()
            if download:
                for key, value in kwargs.items():
                    if hasattr(download, key):
                        setattr(download, key, value)
                session.commit()
                return download.to_dict()
            return None
        finally:
            self.close_session()

    def update_download_by_message_id(self, message_id, **kwargs):
        """Update a download entry by message ID (string UUID or Telegram ID)"""
        session = self.get_session()
        try:
            msg_id = str(message_id) if message_id is not None else None
            download = session.query(Download).filter_by(message_id=msg_id).first()
            if download:
                for key, value in kwargs.items():
                    if hasattr(download, key):
                        setattr(download, key, value)
                session.commit()
                return download.to_dict()
            return None
        finally:
            self.close_session()

    def get_download(self, file):
        """Get a download entry by filename"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(file=file).first()
            return download.to_dict() if download else None
        finally:
            self.close_session()

    def get_download_by_id(self, download_id):
        """Get a download entry by ID"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(id=download_id).first()
            return download.to_dict() if download else None
        finally:
            self.close_session()

    def get_all_downloads(self):
        """Get all non-deleted downloads ordered by updated_at descending"""
        session = self.get_session()
        try:
            downloads = session.query(Download).filter(
                (Download.is_deleted == False) | (Download.is_deleted == None)
            ).order_by(Download.updated_at.desc()).all()
            return [d.to_dict() for d in downloads]
        finally:
            self.close_session()

    def delete_download(self, file):
        """Soft delete a download entry by filename"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(file=file).first()
            if download:
                download.is_deleted = True
                download.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False
        finally:
            self.close_session()

    def delete_download_by_id(self, download_id):
        """Soft delete a download entry by ID"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(id=download_id).first()
            if download:
                download.is_deleted = True
                download.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False
        finally:
            self.close_session()

    def delete_download_by_message_id(self, message_id):
        """Soft delete a download entry by message ID (string UUID or Telegram ID)"""
        session = self.get_session()
        try:
            msg_id = str(message_id) if message_id is not None else None
            download = session.query(Download).filter_by(message_id=msg_id).first()
            if download:
                download.is_deleted = True
                download.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False
        finally:
            self.close_session()

    def get_download_by_message_id(self, message_id):
        """Get a download entry by message ID (string UUID or Telegram ID)"""
        session = self.get_session()
        try:
            msg_id = str(message_id) if message_id is not None else None
            download = session.query(Download).filter_by(message_id=msg_id).first()
            return download.to_dict() if download else None
        finally:
            self.close_session()

    def get_setting(self, key):
        """Get a setting value by key"""
        session = self.get_session()
        try:
            setting = session.query(Settings).filter_by(key=key).first()
            return setting.value if setting else None
        finally:
            self.close_session()

    def set_setting(self, key, value):
        """Set a setting value (insert or update)"""
        session = self.get_session()
        try:
            setting = session.query(Settings).filter_by(key=key).first()
            if setting:
                setting.value = value
                setting.updated_at = datetime.utcnow()
            else:
                setting = Settings(key=key, value=value)
                session.add(setting)
            session.commit()
            return setting.to_dict()
        finally:
            self.close_session()

    def get_all_settings(self):
        """Get all settings as a dictionary"""
        session = self.get_session()
        try:
            settings = session.query(Settings).all()
            return {s.key: s.value for s in settings}
        finally:
            self.close_session()

    def set_multiple_settings(self, settings_dict):
        """Set multiple settings at once"""
        session = self.get_session()
        try:
            for key, value in settings_dict.items():
                setting = session.query(Settings).filter_by(key=key).first()
                if setting:
                    setting.value = value
                    setting.updated_at = datetime.utcnow()
                else:
                    setting = Settings(key=key, value=value)
                    session.add(setting)
            session.commit()
            return self.get_all_settings()
        finally:
            self.close_session()

    # User management methods
    def get_user_by_username(self, username: str):
        """Get a user by username"""
        session = self.get_session()
        try:
            user = session.query(User).filter_by(username=username).first()
            return user
        finally:
            self.close_session()

    def authenticate_user(self, username: str, password: str):
        """Authenticate a user by username and password"""
        session = self.get_session()
        try:
            user = session.query(User).filter_by(username=username).first()
            if user and user.check_password(password):
                return user.to_dict()
            return None
        finally:
            self.close_session()

    def create_user(self, username: str, password: str):
        """Create a new user"""
        session = self.get_session()
        try:
            existing = session.query(User).filter_by(username=username).first()
            if existing:
                return None  # User already exists
            user = User(
                username=username,
                password_hash=User.hash_password(password)
            )
            session.add(user)
            session.commit()
            return user.to_dict()
        finally:
            self.close_session()

    def update_user_password(self, user_id: int, current_password: str, new_password: str):
        """Update user password after verifying current password"""
        session = self.get_session()
        try:
            user = session.query(User).filter_by(id=user_id).first()
            if not user:
                return {'error': 'User not found'}
            if not user.check_password(current_password):
                return {'error': 'Current password is incorrect'}
            user.password_hash = User.hash_password(new_password)
            session.commit()
            return {'success': True}
        finally:
            self.close_session()

    def seed_default_user(self):
        """Create default user if no users exist"""
        session = self.get_session()
        try:
            user_count = session.query(User).count()
            if user_count == 0:
                user = User(
                    username='admin',
                    password_hash=User.hash_password('admin')
                )
                session.add(user)
                session.commit()
                print("Default user 'admin' created")
        finally:
            self.close_session()

    # Download type map methods
    def get_all_download_type_maps(self):
        """Get all download type mappings"""
        session = self.get_session()
        try:
            maps = session.query(DownloadTypeMap).order_by(DownloadTypeMap.downloaded_from).all()
            return [m.to_dict() for m in maps]
        finally:
            self.close_session()

    def get_download_type_map(self, downloaded_from: str):
        """Get a download type mapping by downloaded_from value"""
        session = self.get_session()
        try:
            mapping = session.query(DownloadTypeMap).filter_by(downloaded_from=downloaded_from).first()
            return mapping.to_dict() if mapping else None
        finally:
            self.close_session()

    def get_secured_sources(self):
        """Get list of downloaded_from values that are secured"""
        session = self.get_session()
        try:
            maps = session.query(DownloadTypeMap).filter_by(is_secured=True).all()
            return [m.downloaded_from for m in maps]
        finally:
            self.close_session()

    def get_secured_mapping_ids(self):
        """Get list of mapping IDs that are secured"""
        session = self.get_session()
        try:
            maps = session.query(DownloadTypeMap).filter_by(is_secured=True).all()
            return [m.id for m in maps]
        finally:
            self.close_session()

    def add_download_type_map(self, downloaded_from: str, is_secured: bool = False, folder: str = None, quality: str = None):
        """Add a new download type mapping"""
        session = self.get_session()
        try:
            existing = session.query(DownloadTypeMap).filter_by(downloaded_from=downloaded_from).first()
            if existing:
                return {'error': 'Mapping already exists for this source'}
            mapping = DownloadTypeMap(
                downloaded_from=downloaded_from,
                is_secured=is_secured,
                folder=folder,
                quality=quality
            )
            session.add(mapping)
            session.commit()
            return mapping.to_dict()
        finally:
            self.close_session()

    def update_download_type_map(self, map_id: int, **kwargs):
        """Update a download type mapping"""
        session = self.get_session()
        try:
            mapping = session.query(DownloadTypeMap).filter_by(id=map_id).first()
            if not mapping:
                return {'error': 'Mapping not found'}
            for key, value in kwargs.items():
                if hasattr(mapping, key) and key != 'id':
                    setattr(mapping, key, value)
            mapping.updated_at = datetime.utcnow()
            session.commit()
            return mapping.to_dict()
        finally:
            self.close_session()

    def delete_download_type_map(self, map_id: int):
        """Delete a download type mapping"""
        session = self.get_session()
        try:
            mapping = session.query(DownloadTypeMap).filter_by(id=map_id).first()
            if not mapping:
                return False
            session.delete(mapping)
            session.commit()
            return True
        finally:
            self.close_session()


# Global database manager instance (initialized in config)
db_manager = None


def init_database(database_url):
    """Initialize the database manager"""
    global db_manager
    db_manager = DatabaseManager(database_url)
    db_manager.seed_default_user()
    return db_manager


def get_db():
    """Get the global database manager"""
    return db_manager
