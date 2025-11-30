"""
Database module for Telegram Downloader
"""
import os
from datetime import datetime
from sqlalchemy import create_engine, Column, Integer, BigInteger, String, Float, DateTime, Text
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, scoped_session

Base = declarative_base()


class Download(Base):
    """Download model representing a file download"""
    __tablename__ = 'downloads'

    id = Column(Integer, primary_key=True, autoincrement=True)
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

    def to_dict(self):
        """Convert model to dictionary"""
        return {
            'id': self.id,
            'file': self.file,
            'status': self.status,
            'progress': self.progress,
            'speed': self.speed,
            'error': self.error,
            'updated_at': self.updated_at.isoformat() if self.updated_at else None,
            'created_at': self.created_at.isoformat() if self.created_at else None,
            'downloaded_bytes': self.downloaded_bytes,
            'total_bytes': self.total_bytes,
            'pending_time': self.pending_time
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


class DatabaseManager:
    """Database manager for handling all database operations"""

    def __init__(self, database_url):
        self.engine = create_engine(database_url, pool_pre_ping=True)
        self.Session = scoped_session(sessionmaker(bind=self.engine))
        Base.metadata.create_all(self.engine)

    def get_session(self):
        """Get a new database session"""
        return self.Session()

    def close_session(self):
        """Close the current session"""
        self.Session.remove()

    def add_download(self, file, status='downloading', progress=0, speed=0,
                     error=None, downloaded_bytes=0, total_bytes=0, pending_time=None):
        """Add a new download entry"""
        session = self.get_session()
        try:
            now = datetime.utcnow()
            download = Download(
                file=file,
                status=status,
                progress=progress,
                speed=speed,
                error=error,
                updated_at=now,
                created_at=now,
                downloaded_bytes=downloaded_bytes,
                total_bytes=total_bytes,
                pending_time=pending_time
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
        """Get all downloads ordered by updated_at descending"""
        session = self.get_session()
        try:
            downloads = session.query(Download).order_by(Download.updated_at.desc()).all()
            return [d.to_dict() for d in downloads]
        finally:
            self.close_session()

    def delete_download(self, file):
        """Delete a download entry by filename"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(file=file).first()
            if download:
                session.delete(download)
                session.commit()
                return True
            return False
        finally:
            self.close_session()

    def delete_download_by_id(self, download_id):
        """Delete a download entry by ID"""
        session = self.get_session()
        try:
            download = session.query(Download).filter_by(id=download_id).first()
            if download:
                session.delete(download)
                session.commit()
                return True
            return False
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


# Global database manager instance (initialized in config)
db_manager = None


def init_database(database_url):
    """Initialize the database manager"""
    global db_manager
    db_manager = DatabaseManager(database_url)
    return db_manager


def get_db():
    """Get the global database manager"""
    return db_manager
