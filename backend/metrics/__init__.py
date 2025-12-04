"""
Prometheus metrics module for DownLee
"""
from prometheus_client import Counter, Gauge, Histogram, Info, generate_latest, CONTENT_TYPE_LATEST

# Application info
app_info = Info('downlee', 'DownLee application information')
app_info.info({'version': '1.0.0', 'name': 'DownLee'})

# Download counters
downloads_total = Counter(
    'downlee_downloads_total',
    'Total number of downloads',
    ['source', 'status']  # Labels: source (telegram, youtube, etc.), status (done, failed, stopped)
)

downloads_started = Counter(
    'downlee_downloads_started_total',
    'Total number of downloads started',
    ['source']
)

# Active downloads gauge
downloads_in_progress = Gauge(
    'downlee_downloads_in_progress',
    'Number of currently active downloads',
    ['source']
)

# Speed metrics
download_speed_bytes = Gauge(
    'downlee_download_speed_bytes',
    'Current total download speed in bytes per second'
)

download_speed_by_source = Gauge(
    'downlee_download_speed_bytes_by_source',
    'Current download speed by source in bytes per second',
    ['source']
)

# Bytes metrics
bytes_downloaded_total = Counter(
    'downlee_bytes_downloaded_total',
    'Total bytes downloaded',
    ['source']
)

bytes_pending = Gauge(
    'downlee_bytes_pending',
    'Total bytes pending download'
)

# Download size histogram (for completed downloads)
download_size_bytes = Histogram(
    'downlee_download_size_bytes',
    'Size of completed downloads in bytes',
    ['source'],
    buckets=[
        1024 * 1024,           # 1 MB
        10 * 1024 * 1024,      # 10 MB
        50 * 1024 * 1024,      # 50 MB
        100 * 1024 * 1024,     # 100 MB
        500 * 1024 * 1024,     # 500 MB
        1024 * 1024 * 1024,    # 1 GB
        5 * 1024 * 1024 * 1024 # 5 GB
    ]
)

# Download duration histogram (for completed downloads)
download_duration_seconds = Histogram(
    'downlee_download_duration_seconds',
    'Duration of completed downloads in seconds',
    ['source'],
    buckets=[10, 30, 60, 120, 300, 600, 1800, 3600]  # 10s to 1h
)

# Error counter
download_errors_total = Counter(
    'downlee_download_errors_total',
    'Total number of download errors',
    ['source', 'error_type']  # error_type: timeout, network, cancelled, unknown
)

# Retry counter
download_retries_total = Counter(
    'downlee_download_retries_total',
    'Total number of download retries',
    ['source']
)

# Queue metrics
queue_size = Gauge(
    'downlee_queue_size',
    'Number of items in download queue'
)

# Database stats
db_downloads_count = Gauge(
    'downlee_db_downloads_count',
    'Total downloads in database',
    ['status']
)


def get_metrics():
    """Generate Prometheus metrics output"""
    return generate_latest()


def get_content_type():
    """Get the content type for Prometheus metrics"""
    return CONTENT_TYPE_LATEST


# Helper functions for updating metrics

def record_download_started(source: str):
    """Record a new download started"""
    downloads_started.labels(source=source).inc()
    downloads_in_progress.labels(source=source).inc()


def record_download_completed(source: str, size_bytes: int, duration_seconds: float):
    """Record a completed download"""
    downloads_total.labels(source=source, status='done').inc()
    downloads_in_progress.labels(source=source).dec()
    bytes_downloaded_total.labels(source=source).inc(size_bytes)
    download_size_bytes.labels(source=source).observe(size_bytes)
    if duration_seconds > 0:
        download_duration_seconds.labels(source=source).observe(duration_seconds)


def record_download_failed(source: str, error_type: str = 'unknown'):
    """Record a failed download"""
    downloads_total.labels(source=source, status='failed').inc()
    downloads_in_progress.labels(source=source).dec()
    download_errors_total.labels(source=source, error_type=error_type).inc()


def record_download_stopped(source: str):
    """Record a stopped/cancelled download"""
    downloads_total.labels(source=source, status='stopped').inc()
    downloads_in_progress.labels(source=source).dec()


def record_retry(source: str):
    """Record a download retry"""
    download_retries_total.labels(source=source).inc()


def update_speed(total_speed_kb: float, speed_by_source: dict = None):
    """Update current download speed

    Args:
        total_speed_kb: Total speed in KB/s
        speed_by_source: Dict of {source: speed_kb} for per-source speeds
    """
    download_speed_bytes.set(total_speed_kb * 1024)  # Convert to bytes/s
    if speed_by_source:
        for source, speed_kb in speed_by_source.items():
            download_speed_by_source.labels(source=source).set(speed_kb * 1024)


def update_pending_bytes(pending: int):
    """Update pending bytes to download"""
    bytes_pending.set(pending)


def update_db_stats(stats_by_status: dict):
    """Update database statistics

    Args:
        stats_by_status: Dict of {status: count}
    """
    for status, count in stats_by_status.items():
        db_downloads_count.labels(status=status).set(count)


def update_queue_size(size: int):
    """Update queue size"""
    queue_size.set(size)
