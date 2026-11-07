"""The player's info (i) panel: ffprobe JSON -> the panel's shape, the probe
itself (real ffmpeg where installed), and the two routes that serve it."""
import shutil
import subprocess
from pathlib import Path

import pytest

from backend import media_info

HAS_FFMPEG = shutil.which('ffmpeg') is not None and shutil.which('ffprobe') is not None

PROBE = {
    'format': {
        'format_name': 'matroska,webm', 'format_long_name': 'Matroska / WebM',
        'duration': '7451.5', 'bit_rate': '25000000', 'size': '999',
        'tags': {'TITLE': 'The Film', 'ENCODER': 'libebml', 'COMPATIBLE_BRANDS': 'noise'},
    },
    'streams': [
        {'index': 0, 'codec_type': 'video', 'codec_name': 'hevc', 'codec_long_name': 'H.265',
         'profile': 'Main 10', 'width': 3840, 'height': 2160, 'display_aspect_ratio': '16:9',
         'avg_frame_rate': '24000/1001', 'r_frame_rate': '24000/1001', 'pix_fmt': 'yuv420p10le',
         'color_space': 'bt2020nc', 'color_primaries': 'bt2020', 'color_transfer': 'smpte2084',
         'disposition': {'default': 1}, 'tags': {'BPS': '22000000'}},
        {'index': 1, 'codec_type': 'audio', 'codec_name': 'eac3', 'channels': 6,
         'channel_layout': '5.1(side)', 'sample_rate': '48000', 'bit_rate': '640000',
         'disposition': {'default': 1}, 'tags': {'language': 'eng', 'title': 'Surround'}},
        {'index': 2, 'codec_type': 'subtitle', 'codec_name': 'subrip',
         'disposition': {'forced': 1}, 'tags': {'language': 'und'}},
        {'index': 3, 'codec_type': 'attachment', 'codec_name': 'ttf'},
    ],
    'chapters': [{'start_time': '0.000000', 'end_time': '300.0', 'tags': {'title': 'Opening'}}],
}


def test_summarize_shapes_every_stream_and_the_container(tmp_path):
    f = tmp_path / 'film.mkv'
    f.write_bytes(b'x' * 10)
    info = media_info.summarize(PROBE, f)

    assert info['file'] == {'name': 'film.mkv', 'path': str(f), 'size': 10, 'modified': f.stat().st_mtime}
    c = info['container']
    assert c['format_long'] == 'Matroska / WebM' and c['duration'] == 7451.5 and c['bitrate'] == 25_000_000
    # Only tags worth showing, keys lower-cased
    assert c['tags'] == {'title': 'The Film', 'encoder': 'libebml'}

    video, audio, sub, attach = info['streams']
    assert video['width'] == 3840 and video['fps'] == 23.976 and video['bit_depth'] == 10
    assert video['hdr'] == 'HDR10 (PQ)' and video['aspect'] == '16:9' and video['default'] is True
    assert video['bitrate'] == 22_000_000           # MKV keeps it in a BPS tag
    assert audio['channels'] == 6 and audio['sample_rate'] == 48000 and audio['language'] == 'eng'
    assert audio['title'] == 'Surround' and audio['bitrate'] == 640_000
    assert sub['forced'] is True and sub['language'] is None     # 'und' is no language
    assert attach['type'] == 'attachment'
    assert info['chapters'] == [{'start': 0.0, 'end': 300.0, 'title': 'Opening'}]


def test_summarize_survives_missing_and_odd_fields(tmp_path):
    probe = {'streams': [
        {'index': 0, 'codec_type': 'video', 'avg_frame_rate': '0/0', 'r_frame_rate': '25/1',
         'display_aspect_ratio': '0:1', 'bits_per_raw_sample': '12',
         'side_data_list': [{'side_data_type': 'DOVI configuration record'}]},
        {'index': 1, 'codec_type': 'video', 'pix_fmt': 'yuv420p', 'color_transfer': 'arib-std-b67'},
        {'index': 2, 'codec_type': 'video', 'pix_fmt': 'rgb24', 'bit_rate': 'N/A'},
    ]}
    info = media_info.summarize(probe, tmp_path / 'gone.mp4')
    a, b, c = info['streams']
    assert a['fps'] == 25.0 and a['aspect'] is None and a['bit_depth'] == 12 and a['hdr'] == 'Dolby Vision'
    assert b['bit_depth'] == 8 and b['hdr'] == 'HLG'
    assert c['bit_depth'] == 8 and c['bitrate'] is None and c['hdr'] is None
    # A file that vanished mid-request still answers, without a size or date
    assert info['file']['size'] is None and info['file']['modified'] is None
    assert info['container']['duration'] is None and info['chapters'] == []


def test_a_missing_file_is_a_404(tmp_path):
    with pytest.raises(media_info.MediaInfoError) as e:
        media_info.media_info(tmp_path / 'nope.mp4')
    assert e.value.status == 404


def _fake_run(stdout=b'', returncode=0, exc=None):
    def run(*a, **k):
        if exc:
            raise exc
        return subprocess.CompletedProcess(a, returncode, stdout, b'')
    return run


def test_probe_failures_map_to_statuses(tmp_path, monkeypatch):
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'junk')
    cases = [
        (_fake_run(returncode=1), 422),                               # not media
        (_fake_run(stdout=b'not json', returncode=1), 422),
        (_fake_run(exc=subprocess.TimeoutExpired('ffprobe', 30)), 504),
        (_fake_run(exc=FileNotFoundError('ffprobe')), 500),
    ]
    for run, status in cases:
        monkeypatch.setattr(media_info.subprocess, 'run', run)
        with pytest.raises(media_info.MediaInfoError) as e:
            media_info.media_info(f)
        assert e.value.status == status


def test_a_nonzero_exit_with_streams_still_answers(tmp_path, monkeypatch):
    """ffprobe exits non-zero on a slightly damaged file it read fine."""
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'junk')
    monkeypatch.setattr(media_info.subprocess, 'run',
                        _fake_run(stdout=b'{"streams":[{"index":0,"codec_type":"audio"}]}', returncode=1))
    assert media_info.media_info(f)['streams'][0]['type'] == 'audio'


@pytest.fixture
def clip(tmp_path):
    if not HAS_FFMPEG:
        pytest.skip('ffmpeg not installed')
    out = tmp_path / 'clip.mp4'
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=d=2:s=320x240',
                    '-f', 'lavfi', '-i', 'sine=d=2', '-shortest', '-pix_fmt', 'yuv420p', str(out)],
                   check=True)
    return out


def test_a_real_file_is_probed(clip):
    info = media_info.media_info(clip)
    kinds = [s['type'] for s in info['streams']]
    assert kinds == ['video', 'audio']
    assert info['streams'][0]['width'] == 320 and info['streams'][0]['height'] == 240
    assert 1.5 < info['container']['duration'] < 2.5


# --- routes -----------------------------------------------------------------

def test_explorer_route(client, db, auth, monkeypatch, tmp_path):
    f = tmp_path / 'clip.mp4'
    f.write_bytes(b'x')
    monkeypatch.setattr(media_info, 'media_info', lambda p: {'file': {'path': str(p)}})
    res = client.post('/api/files/info', json={'path': str(f)}, headers=auth)
    assert res.status_code == 200 and res.get_json()['file']['path'] == str(f)

    assert client.post('/api/files/info', json={'path': str(f)}).status_code == 401
    assert client.post('/api/files/info', json={'path': 'vps:/x.mp4'}, headers=auth).status_code == 400
    assert client.post('/api/files/info', json={'path': str(tmp_path / 'nope.mp4')}, headers=auth).status_code == 404

    def boom(p):
        raise media_info.MediaInfoError('Not a media file ffprobe can read', 422)
    monkeypatch.setattr(media_info, 'media_info', boom)
    res = client.post('/api/files/info', json={'path': str(f)}, headers=auth)
    assert res.status_code == 422 and 'ffprobe' in res.get_json()['error']


def test_download_route_finds_the_file_through_the_record(client, db, auth, monkeypatch, tmp_path):
    f = tmp_path / 'Movie.mkv'
    f.write_bytes(b'x')
    from backend.web_app.routes import media
    monkeypatch.setattr(media, 'candidate_file_paths', lambda d, name: [f])
    monkeypatch.setattr(media_info, 'media_info', lambda p: {'file': {'name': Path(p).name}})
    row = db.add_download(file='Movie.mkv', status='done', progress=100,
                          downloaded_from='telegram', message_id='info-1')
    did = row['id'] if isinstance(row, dict) else row.id

    res = client.get(f'/api/video/info/{did}', headers=auth)
    assert res.status_code == 200 and res.get_json()['file']['name'] == 'Movie.mkv'
    assert client.get(f'/api/video/info/{did}').status_code == 401
    assert client.get('/api/video/info/99999', headers=auth).status_code == 404

    def boom(p):
        raise media_info.MediaInfoError('Probing the file timed out', 504)
    monkeypatch.setattr(media_info, 'media_info', boom)
    assert client.get(f'/api/video/info/{did}', headers=auth).status_code == 504
