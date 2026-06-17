import os
import json
import asyncio
import posixpath
import jwt
from datetime import datetime, timedelta
from pathlib import Path
from flask import jsonify, request, send_from_directory, Response
from backend.config import JWT_SECRET
from backend.database import get_db
from backend import metrics
from backend.web_app.base import (
    token_required, get_socketio, get_web_app,
    JWT_EXPIRY_DAYS, PASSWORD_CHANGE_ALLOWED_PATHS, FRONTEND_DIST,
)
from backend.web_app.torrent import (
    load_torrent_config, apply_torrent_session, transmission_add_magnet,
    transmission_rpc, normalize_transmission_url,
)
from backend.web_app.vps import load_vps_credentials, annotate_vps_folders, open_vps_sftp
from backend.web_app.helpers import candidate_file_paths


class AnalyticsRoutesMixin:
    def register_analytics_routes(self):
        @self.app.route("/api/analytics", methods=["GET"])
        @token_required
        def get_analytics():
            """Get download analytics data for charts"""
            db = get_db()
            include_deleted = request.args.get("include_deleted", "false").lower() == "true"
            all_downloads = db.get_all_downloads(include_deleted=include_deleted)

            # Get date range from query params (default: last 30 days, 0 = all time)
            days = int(request.args.get("days", 30))
            group_by = request.args.get("group_by", "day")  # 'day' or 'hour'

            from datetime import datetime, timedelta
            from collections import defaultdict

            now = datetime.utcnow()
            cutoff = now - timedelta(days=days) if days > 0 else None

            # Filter downloads within date range
            recent_downloads = []
            for d in all_downloads:
                created = d.get("created_at")
                if created:
                    try:
                        dt = datetime.fromisoformat(created.replace('Z', '+00:00')) if isinstance(created, str) else created
                        dt_naive = dt.replace(tzinfo=None)
                        if cutoff is None or dt_naive >= cutoff:
                            recent_downloads.append({**d, '_dt': dt_naive})
                    except:
                        pass

            # Group by time period
            downloads_by_time = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_source = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_author = defaultdict(lambda: {'count': 0, 'size': 0})
            downloads_by_status = defaultdict(int)
            hourly_distribution = defaultdict(int)  # Downloads by hour of day (0-23)

            for d in recent_downloads:
                dt = d['_dt']
                source = d.get('downloaded_from', 'unknown')
                status = d.get('status', 'unknown')
                size = d.get('total_bytes', 0) or 0

                # Group by day or hour
                if group_by == 'hour':
                    key = dt.strftime('%Y-%m-%d %H:00')
                else:
                    key = dt.strftime('%Y-%m-%d')

                downloads_by_time[key]['count'] += 1
                downloads_by_time[key]['size'] += size

                # By source
                downloads_by_source[source]['count'] += 1
                downloads_by_source[source]['size'] += size

                # By author
                author = d.get('author') or 'unknown'
                downloads_by_author[author]['count'] += 1
                downloads_by_author[author]['size'] += size

                # By status
                downloads_by_status[status] += 1

                # Hourly distribution (regardless of date)
                hourly_distribution[dt.hour] += 1

            # Convert to sorted lists for charts
            time_labels = sorted(downloads_by_time.keys())
            time_data = [
                {
                    'label': label,
                    'count': downloads_by_time[label]['count'],
                    'size': downloads_by_time[label]['size']
                }
                for label in time_labels
            ]

            # Fill in missing dates/hours
            if group_by == 'day' and time_labels:
                filled_data = []
                if cutoff is not None:
                    start_date = cutoff.date()
                else:
                    start_date = datetime.strptime(time_labels[0], '%Y-%m-%d').date()
                end = now.date()
                current = start_date
                while current <= end:
                    key = current.strftime('%Y-%m-%d')
                    if key in downloads_by_time:
                        filled_data.append({
                            'label': key,
                            'count': downloads_by_time[key]['count'],
                            'size': downloads_by_time[key]['size']
                        })
                    else:
                        filled_data.append({'label': key, 'count': 0, 'size': 0})
                    current += timedelta(days=1)
                time_data = filled_data

            # Sort sources by count
            source_data = [
                {'source': source, 'count': data['count'], 'size': data['size']}
                for source, data in sorted(downloads_by_source.items(), key=lambda x: -x[1]['count'])
            ]

            # Hourly distribution (0-23)
            hourly_data = [
                {'hour': h, 'count': hourly_distribution.get(h, 0)}
                for h in range(24)
            ]

            # Sort authors by count
            author_data = [
                {'author': author, 'count': data['count'], 'size': data['size']}
                for author, data in sorted(downloads_by_author.items(), key=lambda x: -x[1]['count'])
            ]

            # Summary stats
            total_downloads = len(recent_downloads)
            total_size = sum(d.get('total_bytes', 0) or 0 for d in recent_downloads)
            completed = sum(1 for d in recent_downloads if d.get('status') == 'done')
            failed = sum(1 for d in recent_downloads if d.get('status') == 'failed')

            return jsonify({
                'time_series': time_data,
                'by_source': source_data,
                'by_author': author_data,
                'by_status': dict(downloads_by_status),
                'hourly_distribution': hourly_data,
                'summary': {
                    'total_downloads': total_downloads,
                    'total_size': total_size,
                    'completed': completed,
                    'failed': failed,
                    'success_rate': round(completed / total_downloads * 100, 1) if total_downloads > 0 else 0
                },
                'period_days': days,
                'group_by': group_by
            })

        # Cookies API for yt-dlp authentication
